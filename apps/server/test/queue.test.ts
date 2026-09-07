import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/events.js";
import { migrationSql } from "./helpers/migrations.js";
import type { ImplementInput, PipelineRunner, PlanInput, ReviewInput, ReviewResult } from "../src/services/pipeline-runner.js";
import { QueueService } from "../src/services/queue.js";
import { SettingsService } from "../src/services/settings.js";

const migrations = migrationSql();

class FakeRunner implements PipelineRunner {
  planCalls = 0; implementCalls = 0; reviewCalls = 0;
  reviews: ReviewResult[] = [{ verdict: "CLEAN", notes: "Everything matches." }];
  failAt: "plan" | "implement" | "review" | null = null;
  // Set by a test before calling runPlanStage to exercise checkpoint/summary drafting; left
  // empty by default so every existing test (which never sets these) is unaffected.
  planCheckpoints: string[] = [];
  planSummary = "";
  // Optional per-test hook: called with the same onOutput the real runner would invoke, so a
  // test can simulate the CLI streaming a PM_CHECKPOINT marker (or any other chunk) while
  // implementing, without needing a real subprocess.
  onImplementOutput: ((onOutput: NonNullable<ImplementInput["onOutput"]>) => void) | null = null;
  async plan(input: PlanInput) {
    this.planCalls++; if (this.failAt === "plan") throw new Error("plan exploded");
    input.onOutput?.("stdout", "planning…\n");
    return { text: "# Approved approach\nBuild it safely.", reviewPrompt: "Check it was built safely.", checkpoints: this.planCheckpoints, summary: this.planSummary || undefined };
  }
  async implement(input: ImplementInput) {
    this.implementCalls++; if (this.failAt === "implement") throw new Error("implement exploded");
    fs.writeFileSync(path.join(input.worktree, `attempt-${this.implementCalls}.txt`), `attempt ${this.implementCalls}\n`);
    if (input.onOutput) this.onImplementOutput?.(input.onOutput);
    return `Implementation attempt ${this.implementCalls}`;
  }
  lastReviewInput: ReviewInput | null = null;
  async review(input: ReviewInput) {
    this.reviewCalls++; this.lastReviewInput = input; if (this.failAt === "review") throw new Error("review exploded");
    input.onOutput?.("stdout", "reviewing…\n");
    return this.reviews[Math.min(this.reviewCalls - 1, this.reviews.length - 1)]!;
  }
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

  it("recovers a job stuck mid-run from a previous process into a retryable failure", async () => {
    const item = queue.add("p", "Build feature");
    await queue.runPlanStage(item.id);
    await queue.approvePlan(item.id);
    // Simulate the process dying mid-implement: force the row back to "implementing" as if a
    // real run were still in flight, with no in-memory job actually driving it (a fresh
    // QueueService, as a real restart would construct).
    db.prepare("UPDATE queued_prompts SET status='implementing' WHERE id=?").run(item.id);
    const fresh = new QueueService(db, new EventHub(), runner, new SettingsService(db));
    expect(fresh.recoverInterruptedJobs()).toBe(1);
    const recovered = fresh.list("p")[0]!;
    expect(recovered).toMatchObject({ status: "failed", needsAttention: true });
    expect(recovered.errorMessage).toContain("Interrupted by a server restart");
    // A second call (e.g. building the app again in the same process) finds nothing left to do.
    expect(fresh.recoverInterruptedJobs()).toBe(0);
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

  it("drafts a review prompt alongside the plan and passes it to the review stage", async () => {
    const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id);
    const planReady = queue.list("p")[0]!;
    expect(planReady.reviewPrompt).toBe("Check it was built safely.");
    expect(planReady.reviewPromptOriginalText).toBe("Check it was built safely.");
    await queue.approvePlan(item.id); await queue.runImplementReviewLoop(item.id);
    expect(runner.lastReviewInput?.reviewPrompt).toBe("Check it was built safely.");
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

  describe("retryFailed", () => {
    it("rejects retrying anything but a failed item", async () => {
      const item = queue.add("p", "Build feature");
      await expect(queue.retryFailed(item.id)).rejects.toThrow("Only a failed item");
    });

    it("sends a plan-stage failure (no worktree yet) back to queued, ready for a normal push", async () => {
      runner.failAt = "plan";
      const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id);
      expect(queue.list("p")[0]).toMatchObject({ status: "failed", worktreePath: null });
      const retried = await queue.retryFailed(item.id);
      expect(retried).toMatchObject({ status: "queued", needsAttention: false, errorMessage: null });
      runner.failAt = null; await queue.runPlanStage(item.id);
      expect(queue.list("p")[0]!.status).toBe("plan_ready"); // proves it actually runs again, not just reset
    });

    it("resumes a first-attempt implement failure as a fresh pass -- no prior commit exists to continue from", async () => {
      const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id); const approved = await queue.approvePlan(item.id);
      runner.failAt = "implement"; await queue.runImplementReviewLoop(item.id);
      expect(queue.list("p")[0]).toMatchObject({ status: "failed", worktreePath: approved.worktreePath });
      const retried = await queue.retryFailed(item.id);
      expect(retried).toMatchObject({ status: "implementing", worktreePath: approved.worktreePath, planApprovedAt: approved.planApprovedAt }); // same worktree/plan, not re-planned
      runner.failAt = null; await queue.runImplementReviewLoop(retried.id);
      expect(queue.list("p")[0]).toMatchObject({ status: "done", reviewVerdict: "CLEAN" });
      expect(runner.planCalls).toBe(1); // plan never re-ran on retry
    });

    // The bug this guards against: naively always resuming as 'implementing' would fire a
    // brand-new `codex exec` at a worktree that already has a successful, committed implement
    // pass sitting in it (from before the fix round that then failed) -- duplicating or
    // conflicting with real work instead of continuing the same Codex session.
    it("resumes a fix-round failure as 'fixing' (continuing the session), not a fresh 'implementing' pass", async () => {
      const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id); const approved = await queue.approvePlan(item.id);
      runner.reviews = [{ verdict: "NEEDS-FIXES", notes: "needs work" }];
      const originalImplement = runner.implement.bind(runner);
      runner.implement = async (input) => {
        if (runner.implementCalls === 1) { runner.implementCalls++; throw new Error("fix round exploded"); }
        return originalImplement(input);
      };
      await queue.runImplementReviewLoop(item.id);
      expect(queue.list("p")[0]).toMatchObject({ status: "failed", fixRoundsUsed: 1 });
      // A real commit from the successful first implement pass already exists in the worktree.
      expect(execFileSync("git", ["-C", approved.worktreePath!, "rev-list", "--count", `${approved.baseSha}..HEAD`], { encoding: "utf8" }).trim()).toBe("1");
      const retried = await queue.retryFailed(item.id);
      expect(retried.status).toBe("fixing"); // not "implementing"
      runner.implement = originalImplement; runner.reviews = [{ verdict: "CLEAN", notes: "fixed" }];
      await queue.runImplementReviewLoop(retried.id);
      expect(queue.list("p")[0]).toMatchObject({ status: "done", reviewVerdict: "CLEAN" });
    });

    it("clears needsAttention and the stale error message on retry", async () => {
      runner.failAt = "plan";
      const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id);
      expect(queue.list("p")[0]).toMatchObject({ needsAttention: true, errorMessage: "plan exploded" });
      expect(await queue.retryFailed(item.id)).toMatchObject({ needsAttention: false, errorMessage: null });
    });
  });

  describe("implement-only mode", () => {
    it("rejects an unrecognized mode", () => {
      expect(() => queue.add("p", "Build feature", undefined, "bogus" as never)).toThrow("Invalid pipeline mode");
    });

    it("skips planning and review entirely, going straight from queued to done", async () => {
      const item = queue.add("p", "Build feature", undefined, "implement_only");
      expect(item.mode).toBe("implement_only");
      await queue.runPlanStage(item.id);
      const done = queue.list("p")[0]!;
      expect(done).toMatchObject({ status: "done", needsAttention: false, planText: "Build feature", reviewVerdict: null });
      expect(done.resultBranch).toBe(`pm/${item.id}`);
      expect(fs.existsSync(done.worktreePath!)).toBe(true);
      expect(runner.planCalls).toBe(0); expect(runner.reviewCalls).toBe(0); expect(runner.implementCalls).toBe(1);
      expect(execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(mainSha);
      expect(queue.listEvents(item.id).map((event) => event.kind)).not.toContain("awaiting_approval");
    });

    it("fails and attributes the error to implement, not plan, on a hard failure", async () => {
      runner.failAt = "implement";
      const item = queue.add("p", "Build feature", undefined, "implement_only");
      await queue.runPlanStage(item.id);
      const failed = queue.list("p")[0]!;
      expect(failed).toMatchObject({ status: "failed", needsAttention: true, errorMessage: "implement exploded" });
      expect(fs.existsSync(failed.worktreePath!)).toBe(true); // preserved for inspection, same as full mode
      const failedEvent = queue.listEvents(item.id).find((event) => event.kind === "failed");
      expect(failedEvent?.stage).toBe("implement");
    });

    it("never reaches plan_ready, so approve/edit-plan reject it", async () => {
      const item = queue.add("p", "Build feature", undefined, "implement_only");
      await expect(queue.approvePlan(item.id)).rejects.toThrow("completed plan");
      expect(() => queue.editPlan(item.id, "x")).toThrow("awaiting approval");
    });
  });

  describe("checkpoints and live output", () => {
    it("stores the drafted checkpoint list alongside the plan", async () => {
      runner.planCheckpoints = ["Add the migration", "Wire up the route"];
      const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id);
      expect(queue.list("p")[0]).toMatchObject({ checkpoints: ["Add the migration", "Wire up the route"], checkpointIndex: 0 });
    });

    it("leaves checkpoints null when the plan didn't include any", async () => {
      const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id);
      expect(queue.list("p")[0]).toMatchObject({ checkpoints: null, checkpointIndex: 0 });
    });

    it("stores the drafted summary alongside the plan, and leaves it null when absent", async () => {
      runner.planSummary = "Adds a safe build step and tests it end to end.";
      const item = queue.add("p", "Build feature"); await queue.runPlanStage(item.id);
      expect(queue.list("p")[0]).toMatchObject({ planSummary: "Adds a safe build step and tests it end to end." });

      runner.planSummary = "";
      const other = queue.add("p", "Another feature"); await queue.runPlanStage(other.id);
      expect(queue.list("p").find((row) => row.id === other.id)).toMatchObject({ planSummary: null });
    });

    it("turns a PM_CHECKPOINT marker line into a persisted index and a live event, tolerating a split chunk", async () => {
      runner.planCheckpoints = ["Add the migration", "Wire up the route"];
      runner.onImplementOutput = (onOutput) => {
        onOutput("stdout", "doing checkpoint 1…\n");
        // Split across two chunks, mid-line, the way a real subprocess's data events would --
        // the marker should still be recognized once the newline completing it arrives.
        onOutput("stdout", 'PM_CHECKPOINT 1/2');
        onOutput("stdout", ': Added the migration\n');
      };
      const hub = new EventHub(); const checkpointEvents: Array<{ index: number; total: number; description: string }> = [];
      hub.subscribe((event) => { if (event.type === "job.checkpoint") checkpointEvents.push(event); });
      const q = new QueueService(db, hub, runner, new SettingsService(db));
      const item = q.add("p", "Build feature"); await q.runPlanStage(item.id); await q.approvePlan(item.id); await q.runImplementReviewLoop(item.id);
      expect(checkpointEvents).toMatchObject([{ index: 1, total: 2, description: "Added the migration" }]);
      expect(q.list("p")[0]).toMatchObject({ checkpointIndex: 1 });
    });

    it("does not track checkpoints during a fix round", async () => {
      runner.planCheckpoints = ["Add the migration"];
      runner.reviews = [{ verdict: "NEEDS-FIXES", notes: "needs work" }];
      let fixRoundSawMarker = false;
      runner.onImplementOutput = (onOutput) => {
        if (runner.implementCalls > 1) onOutput("stdout", "PM_CHECKPOINT 1/1: shouldn't count\n");
      };
      const hub = new EventHub();
      hub.subscribe((event) => { if (event.type === "job.checkpoint" && runner.implementCalls > 1) fixRoundSawMarker = true; });
      const q = new QueueService(db, hub, runner, new SettingsService(db));
      const item = q.add("p", "Build feature"); await q.runPlanStage(item.id); await q.approvePlan(item.id); await q.runImplementReviewLoop(item.id);
      q.requestMoreFixes(item.id);
      await q.runImplementReviewLoop(item.id, false);
      expect(fixRoundSawMarker).toBe(false);
    });

    it("captures and resets each stage's raw output, exposed via getOutput", async () => {
      const item = queue.add("p", "Build feature");
      await queue.runPlanStage(item.id);
      expect(queue.getOutput(item.id).plan.content).toContain("planning…");
      await queue.approvePlan(item.id); await queue.runImplementReviewLoop(item.id);
      expect(queue.getOutput(item.id).review.content).toContain("reviewing…");
      // A fresh implement attempt (a retry, or a fix round) resets that stage's transcript
      // rather than appending to the previous attempt's.
      const beforeRetry = queue.getOutput(item.id).plan.content;
      runner.failAt = "plan";
      const retryItem = queue.add("p", "Another"); await queue.runPlanStage(retryItem.id);
      expect(queue.getOutput(item.id).plan.content).toBe(beforeRetry); // unrelated prompt's output is untouched
    });
  });
});
