import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/events.js";
import type { ImplementInput, PipelineRunner, PlanInput, ReviewInput, ReviewResult } from "../src/services/pipeline-runner.js";
import { QueueService } from "../src/services/queue.js";
import { SettingsService } from "../src/services/settings.js";

const migrations = ["001_initial.sql", "002_pipeline.sql"].map((file) => fs.readFileSync(path.resolve("migrations", file), "utf8"));

class FakeRunner implements PipelineRunner {
  planCalls = 0; implementCalls = 0; reviewCalls = 0;
  reviews: ReviewResult[] = [{ verdict: "CLEAN", notes: "Everything matches." }];
  failAt: "plan" | "implement" | "review" | null = null;
  async plan(_input: PlanInput) { this.planCalls++; if (this.failAt === "plan") throw new Error("plan exploded"); return "# Approved approach\nBuild it safely."; }
  async implement(input: ImplementInput) {
    this.implementCalls++; if (this.failAt === "implement") throw new Error("implement exploded");
    fs.writeFileSync(path.join(input.worktree, `attempt-${this.implementCalls}.txt`), `attempt ${this.implementCalls}\n`);
    return `Implementation attempt ${this.implementCalls}`;
  }
  async review(_input: ReviewInput) { this.reviewCalls++; if (this.failAt === "review") throw new Error("review exploded"); return this.reviews[Math.min(this.reviewCalls - 1, this.reviews.length - 1)]!; }
}

let db: DatabaseSync; let queue: QueueService; let runner: FakeRunner; let root: string; let repo: string; let mainSha: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-queue-")); repo = path.join(root, "repo"); fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Fixture\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
  mainSha = execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();
  db = new DatabaseSync(":memory:"); for (const migration of migrations) db.exec(migration);
  db.prepare("INSERT INTO projects(id,name,path,status,added_at) VALUES('p','Test',?,'active',?)").run(repo, new Date().toISOString());
  runner = new FakeRunner(); queue = new QueueService(db, new EventHub(), runner, new SettingsService(db));
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("prompt queue pipeline", () => {
  it("preserves FIFO append, reorder, and cancellation", () => {
    queue.add("p", "first"); const second = queue.add("p", "second"); queue.add("p", "third");
    queue.update(second.id, { position: 1 });
    expect(queue.list("p").map((item) => [item.text, item.position])).toEqual([["second", 1], ["first", 2], ["third", 3]]);
    expect(queue.update(second.id, { status: "cancelled" }).status).toBe("cancelled");
  });

  it("creates a plan, snapshots config, and requires attention", async () => {
    const item = queue.add("p", "Build feature", { implement: { effort: "high" } });
    await queue.runPlanStage(item.id); const ready = queue.list("p")[0]!;
    expect(ready).toMatchObject({ status: "plan_ready", needsAttention: true, planText: "# Approved approach\nBuild it safely.", implementEffort: "high", planModel: "sonnet" });
    expect(queue.listEvents(item.id).map((event) => event.kind)).toContain("awaiting_approval");
  });

  it("marks a planning failure for human attention", async () => {
    runner.failAt = "plan"; const item = queue.add("p", "Fail planning"); await queue.runPlanStage(item.id);
    expect(queue.list("p")[0]).toMatchObject({ status: "failed", needsAttention: true, errorMessage: "plan exploded" });
  });

  it("guards approval and creates an isolated worktree before implementation", async () => {
    const item = queue.add("p", "Build feature"); await expect(queue.approvePlan(item.id)).rejects.toThrow("completed plan");
    await queue.runPlanStage(item.id); const approved = await queue.approvePlan(item.id);
    expect(approved.status).toBe("implementing"); expect(fs.existsSync(approved.worktreePath!)).toBe(true); expect(approved.resultBranch).toBe(`pm/${item.id}`);
  });

  it("rejects a duplicate concurrent approval with a clear message instead of racing git", async () => {
    const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id);
    const [first, second] = await Promise.allSettled([queue.approvePlan(item.id), queue.approvePlan(item.id)]);
    const results = [first, second];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect((rejected!.reason as Error).message).toMatch(/completed plan/);
    expect(queue.list("p")[0]!.status).toBe("implementing");
  });

  it("stays cancellable while queued behind a busy concurrency slot", async () => {
    let releaseFirst: () => void = () => {};
    const stall = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const original = runner.plan.bind(runner);
    runner.plan = async (input) => { await stall; return original(input); };
    const busy = queue.add("p", "Busy job"); const waiting = queue.add("p", "Waiting job");
    const busyRun = queue.runPlanStage(busy.id);
    await new Promise((resolve) => setImmediate(resolve)); // let the busy job claim the only slot
    const waitingRun = queue.runPlanStage(waiting.id);
    // Still queued (not stuck as 'planning') while it waits for the slot, so it can be cancelled.
    expect(queue.list("p").find((item) => item.id === waiting.id)!.status).toBe("queued");
    expect(queue.update(waiting.id, { status: "cancelled" }).status).toBe("cancelled");
    releaseFirst(); await busyRun; await waitingRun;
    expect(queue.list("p").find((item) => item.id === waiting.id)!.status).toBe("cancelled");
    runner.plan = original;
  });

  it("runs the happy path without touching main", async () => {
    const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id); await queue.approvePlan(item.id); await queue.runImplementReviewLoop(item.id);
    const done = queue.list("p")[0]!; expect(done.status).toBe("done"); expect(done.needsAttention).toBe(false); expect(done.reviewVerdict).toBe("CLEAN");
    expect(execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(mainSha);
    expect(execFileSync("git", ["-C", repo, "log", "-1", "--format=%s", done.resultBranch!], { encoding: "utf8" }).trim()).toContain("pm: implement");
  });

  it("caps automatic fixes at two rounds", async () => {
    runner.reviews = [{ verdict: "NEEDS-FIXES", notes: "Still broken." }];
    const item = queue.add("p", "Difficult feature"); await queue.runPlanStage(item.id); await queue.approvePlan(item.id); await queue.runImplementReviewLoop(item.id);
    expect(queue.list("p")[0]).toMatchObject({ status: "review_exhausted", needsAttention: true, fixRoundsUsed: 2 });
    expect(runner.implementCalls).toBe(3); expect(runner.reviewCalls).toBe(3);
  });

  it("allows one explicitly requested post-cap fix", async () => {
    runner.reviews = [{ verdict: "NEEDS-FIXES", notes: "Still broken." }];
    const item = queue.add("p", "Difficult feature"); await queue.runPlanStage(item.id); await queue.approvePlan(item.id); await queue.runImplementReviewLoop(item.id);
    runner.reviews = [{ verdict: "CLEAN", notes: "Fixed now." }]; runner.reviewCalls = 0;
    queue.requestMoreFixes(item.id, "Use the safer parser."); await queue.runImplementReviewLoop(item.id, false);
    expect(queue.list("p")[0]).toMatchObject({ status: "done", fixRoundsUsed: 3, reviewVerdict: "CLEAN" });
  });

  it("returns to review_exhausted when an explicit extra round is still broken", async () => {
    runner.reviews = [{ verdict: "NEEDS-FIXES", notes: "Still broken." }];
    const item = queue.add("p", "Difficult feature"); await queue.runPlanStage(item.id); await queue.approvePlan(item.id); await queue.runImplementReviewLoop(item.id);
    queue.requestMoreFixes(item.id); await queue.runImplementReviewLoop(item.id, false);
    expect(queue.list("p")[0]).toMatchObject({ status: "review_exhausted", needsAttention: true, fixRoundsUsed: 3 });
  });

  it("preserves the worktree and stops after a hard failure", async () => {
    const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id); const approved = await queue.approvePlan(item.id); runner.failAt = "implement"; await queue.runImplementReviewLoop(item.id);
    expect(queue.list("p")[0]).toMatchObject({ status: "failed", needsAttention: true }); expect(fs.existsSync(approved.worktreePath!)).toBe(true); expect(runner.reviewCalls).toBe(0);
  });

  it("attributes a failure to the stage that actually threw", async () => {
    const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id); await queue.approvePlan(item.id);
    runner.failAt = "review"; await queue.runImplementReviewLoop(item.id);
    expect(queue.list("p")[0]).toMatchObject({ status: "failed" });
    const failedEvent = queue.listEvents(item.id).find((event) => event.kind === "failed");
    expect(failedEvent?.stage).toBe("review");
  });

  it("allows plan edits only at the approval gate", async () => {
    const item = queue.add("p", "Build feature"); expect(() => queue.editPlan(item.id, "new")).toThrow("awaiting approval");
    await queue.runPlanStage(item.id); expect(queue.editPlan(item.id, "Human-edited plan").planText).toBe("Human-edited plan");
    await queue.approvePlan(item.id); expect(() => queue.editPlan(item.id, "too late")).toThrow("awaiting approval"); expect(() => queue.update(item.id, { text: "too late" })).toThrow("active pipeline");
  });
});
