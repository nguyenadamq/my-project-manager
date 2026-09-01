import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageGauge, UsageSnapshot } from "@pm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoDispatchService, AutoDispatchSettingsStore, orderCandidates, requiredPoolsOk } from "../src/services/auto-dispatch.js";
import { EventHub } from "../src/events.js";
import { migrationSql } from "./helpers/migrations.js";
import type { ImplementInput, PipelineRunner, PlanInput, ReviewInput } from "../src/services/pipeline-runner.js";
import { QueueService } from "../src/services/queue.js";
import { SettingsService } from "../src/services/settings.js";

const migrations = migrationSql();

function gauge(percent: number, source: UsageGauge["source"] = "live"): UsageGauge { return { percent, resetAt: null, source, checkedAt: null }; }
function snapshot(overrides: Partial<Omit<UsageSnapshot, "recommendation">> = {}): UsageSnapshot {
  return { claudeSession: gauge(10), claudeWeekly: gauge(10), codexFiveHour: gauge(10), codexWeekly: gauge(10), recommendation: "", ...overrides };
}

describe("requiredPoolsOk", () => {
  it("implement-only mode only needs Codex pools under the threshold", () => {
    const usage = snapshot({ claudeSession: gauge(99) }); // Claude frozen, Codex fine
    expect(requiredPoolsOk({ mode: "implement_only" }, usage, 85)).toBe(true);
    expect(requiredPoolsOk({ mode: "full" }, usage, 85)).toBe(false);
  });
  it("full mode needs both Claude and Codex pools under the threshold", () => {
    const usage = snapshot({ codexFiveHour: gauge(90) }); // Codex frozen, Claude fine
    expect(requiredPoolsOk({ mode: "full" }, usage, 85)).toBe(false);
    expect(requiredPoolsOk({ mode: "implement_only" }, usage, 85)).toBe(false);
  });
  it("an 'unknown' pool never blocks dispatch by itself", () => {
    const usage = snapshot({ claudeSession: gauge(0, "unknown"), claudeWeekly: gauge(0, "unknown"), codexFiveHour: gauge(0, "unknown"), codexWeekly: gauge(0, "unknown") });
    expect(requiredPoolsOk({ mode: "full" }, usage, 85)).toBe(true);
  });
});

class FakeRunner implements PipelineRunner {
  async plan(_input: PlanInput) { return { text: "# Plan\nDo it.", reviewPrompt: "Check it was done." }; }
  async implement(input: ImplementInput) { fs.writeFileSync(path.join(input.worktree, "change.txt"), "done\n"); return "done"; }
  async review(_input: ReviewInput) { return { verdict: "CLEAN" as const, notes: "ok" }; }
}

let db: DatabaseSync; let queue: QueueService; let root: string; let repoA: string; let repoB: string; let tasks: Promise<unknown>[];
// AutoDispatchService hands its fire-and-forget dispatch to this scheduler (exactly like
// app.ts's own `schedule` helper does for the equivalent HTTP routes) specifically so tests
// can await the real completion signal instead of guessing with a sleep or polling the DB row
// -- a too-short guess previously let afterEach close the database out from under a
// still-running dispatch (a `git worktree add`/commit in flight), surfacing as "database is
// not open" unhandled rejections and an EBUSY deleting the temp dir on Windows.
function makeService(store: AutoDispatchSettingsStore) { return new AutoDispatchService(db, queue, store, (task) => tasks.push(task)); }

beforeEach(() => {
  tasks = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-autodispatch-"));
  const makeRepo = (name: string) => {
    const repo = path.join(root, name); fs.mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "# Fixture\n");
    execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
    return repo;
  };
  repoA = makeRepo("a"); repoB = makeRepo("b");
  db = new DatabaseSync(":memory:"); for (const migration of migrations) db.exec(migration);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,path,status,added_at,priority) VALUES('low','Low',?,'active',?,0)").run(repoA, now);
  db.prepare("INSERT INTO projects(id,name,path,status,added_at,priority) VALUES('high','High',?,'active',?,10)").run(repoB, now);
  queue = new QueueService(db, new EventHub(), new FakeRunner(), new SettingsService(db));
});
afterEach(async () => { await Promise.allSettled(tasks); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("AutoDispatchSettingsStore", () => {
  it("defaults to disabled with an 85% threshold", () => {
    expect(new AutoDispatchSettingsStore(db).get()).toEqual({ enabled: false, maxPercentUsed: 85 });
  });
  it("persists a patch and rejects an out-of-range threshold", () => {
    const store = new AutoDispatchSettingsStore(db);
    expect(store.set({ enabled: true, maxPercentUsed: 50 })).toEqual({ enabled: true, maxPercentUsed: 50 });
    expect(store.get()).toEqual({ enabled: true, maxPercentUsed: 50 });
    expect(() => store.set({ maxPercentUsed: 0 })).toThrow(/between 1 and 100/);
    expect(() => store.set({ maxPercentUsed: 101 })).toThrow(/between 1 and 100/);
  });
});

describe("orderCandidates", () => {
  const queued = (mode: "full" | "implement_only", id: string) => ({ id, status: "queued" as const, mode });
  const planReady = (id: string) => ({ id, status: "plan_ready" as const, mode: "full" as const });

  it("finishes work already planned before starting anything new", () => {
    const ordered = orderCandidates([queued("implement_only", "new"), planReady("half-done")], snapshot());
    expect(ordered.map((candidate) => candidate.id)).toEqual(["half-done", "new"]);
  });

  it("spends from the emptier budget last: Claude under pressure sends Codex-only work first", () => {
    const usage = snapshot({ claudeSession: gauge(70), claudeWeekly: gauge(70), codexFiveHour: gauge(10), codexWeekly: gauge(10) });
    const ordered = orderCandidates([queued("full", "needs-claude"), queued("implement_only", "codex-only")], usage);
    expect(ordered.map((candidate) => candidate.id)).toEqual(["codex-only", "needs-claude"]);
  });

  it("reverses that preference when Codex is the constrained side", () => {
    const usage = snapshot({ claudeSession: gauge(10), claudeWeekly: gauge(10), codexFiveHour: gauge(70), codexWeekly: gauge(70) });
    const ordered = orderCandidates([queued("implement_only", "codex-only"), queued("full", "needs-claude")], usage);
    expect(ordered.map((candidate) => candidate.id)).toEqual(["needs-claude", "codex-only"]);
  });

  it("leaves the queue's own order alone when neither side is under more pressure", () => {
    const ordered = orderCandidates([queued("full", "first"), queued("implement_only", "second")], snapshot());
    expect(ordered.map((candidate) => candidate.id)).toEqual(["first", "second"]);
  });

  // "unknown" means not measured yet, which is not evidence of pressure -- it must not be read
  // as 0% and tip the cheaper-mode preference on the strength of a missing reading.
  it("treats an unmeasured pool as no pressure rather than an empty one", () => {
    const usage = snapshot({ claudeSession: gauge(0, "unknown"), claudeWeekly: gauge(0, "unknown"), codexFiveHour: gauge(40), codexWeekly: gauge(40) });
    const ordered = orderCandidates([queued("implement_only", "codex-only"), queued("full", "needs-claude")], usage);
    expect(ordered.map((candidate) => candidate.id)).toEqual(["needs-claude", "codex-only"]);
  });
});

describe("AutoDispatchService.tick", () => {
  it("does nothing while disabled", async () => {
    queue.add("low", "Build feature", undefined, "implement_only");
    await makeService(new AutoDispatchSettingsStore(db)).tick(snapshot());
    await Promise.allSettled(tasks);
    expect(queue.list("low")[0]!.status).toBe("queued");
  });

  it("prefers the higher-priority project's item, then starts it", async () => {
    const lowItem = queue.add("low", "Low priority work", undefined, "implement_only");
    const highItem = queue.add("high", "High priority work", undefined, "implement_only");
    const store = new AutoDispatchSettingsStore(db); store.set({ enabled: true });
    await makeService(store).tick(snapshot());
    await Promise.allSettled(tasks);
    expect(queue.list("high").find((item) => item.id === highItem.id)!.status).toBe("done");
    expect(queue.list("low").find((item) => item.id === lowItem.id)!.status).toBe("queued");
  });

  it("skips a full-mode candidate whose required pools are frozen and falls through to one that fits", async () => {
    const fullModeItem = queue.add("high", "Needs everything", undefined, "full"); // will be blocked
    const implementOnly = queue.add("low", "Implement only fallback", undefined, "implement_only");
    const store = new AutoDispatchSettingsStore(db); store.set({ enabled: true, maxPercentUsed: 85 });
    // Claude frozen: blocks the full-mode item but not the implement-only one.
    await makeService(store).tick(snapshot({ claudeSession: gauge(99) }));
    await Promise.allSettled(tasks);
    expect(queue.list("low").find((item) => item.id === implementOnly.id)!.status).toBe("done");
    expect(queue.list("high").find((item) => item.id === fullModeItem.id)!.status).toBe("queued"); // still waiting -- full mode needs Claude too
  });

  // An instant-dispatch item is started by the add route while its row still reads 'queued' --
  // exactly what tick() scans for -- so without a guard the next tick would start a second run
  // of the same item.
  it("does not start a second run for an item whose pipeline is already in flight", async () => {
    const item = queue.add("high", "Instant work", undefined, "implement_only", "instant");
    const inFlight = queue.runPlanStage(item.id);
    const store = new AutoDispatchSettingsStore(db); store.set({ enabled: true });
    await makeService(store).tick(snapshot());
    await inFlight;
    await Promise.allSettled(tasks);
    expect(queue.list("high").find((row) => row.id === item.id)!.status).toBe("done");
    // One implement pass, not two: a duplicate run would have committed a second time.
    expect(fs.readdirSync(path.join(repoB, ".pm", "worktrees"))).toHaveLength(1);
  });

  it("auto-approves a full-mode plan sitting in plan_ready when capacity allows", async () => {
    const item = queue.add("low", "Build feature"); // full mode
    await queue.runPlanStage(item.id);
    expect(queue.list("low")[0]!.status).toBe("plan_ready");
    const store = new AutoDispatchSettingsStore(db); store.set({ enabled: true });
    await makeService(store).tick(snapshot());
    await Promise.allSettled(tasks);
    expect(queue.list("low").find((row) => row.id === item.id)!.status).toBe("done");
  });
});
