import type { AutoDispatchSettings, UsageSnapshot } from "@pm/shared";
import type { Db } from "../db.js";
import type { QueueService } from "./queue.js";

export const DEFAULT_AUTO_DISPATCH: AutoDispatchSettings = { enabled: false, maxPercentUsed: 85 };

interface Candidate { id: string; status: "queued" | "plan_ready"; mode: "full" | "implement_only" }

// A pool with no live/estimated reading yet ("unknown") never blocks dispatch -- usage tracking
// is an enhancement layered on top of the existing concurrency-slot gate in QueueService, not a
// new hard requirement, so auto-dispatch still works (just without the smart gating) before
// `pnpm usage:chrome` has ever been run.
function underThreshold(gauge: UsageSnapshot[keyof Omit<UsageSnapshot, "recommendation">], maxPercentUsed: number): boolean {
  return gauge.source === "unknown" || gauge.percent < maxPercentUsed;
}

// Which pools a candidate would draw from before it reaches a terminal state, so a full-mode
// item is never started (or auto-approved) unless there's room to actually finish it, not just
// begin it -- see the walkthrough in the chat: checking only the pool for the *next* stage
// would let a plan get approved and then stall mid-review with Claude frozen.
export function requiredPoolsOk(candidate: Pick<Candidate, "mode">, usage: UsageSnapshot, maxPercentUsed: number): boolean {
  const codexOk = underThreshold(usage.codexFiveHour, maxPercentUsed) && underThreshold(usage.codexWeekly, maxPercentUsed);
  if (candidate.mode === "implement_only") return codexOk;
  const claudeOk = underThreshold(usage.claudeSession, maxPercentUsed) && underThreshold(usage.claudeWeekly, maxPercentUsed);
  return codexOk && claudeOk;
}

// How close to its ceiling the most-constrained pool backing a given agent is. An "unknown"
// pool contributes nothing: it means "not measured yet", which is not evidence of pressure.
function pressure(...gauges: UsageSnapshot[keyof Omit<UsageSnapshot, "recommendation">][]): number {
  const known = gauges.filter((gauge) => gauge.source !== "unknown");
  return known.length ? Math.max(...known.map((gauge) => gauge.percent)) : 0;
}

// Orders the candidates that *could* run into the order they *should* run in. Two rules on top
// of the SQL's project-priority/FIFO base order, both about not wasting tokens:
//
//  1. Finish before starting. A 'plan_ready' item has already had a plan drafted and paid for;
//     leaving it to go stale behind brand-new work risks re-planning it later against a moved
//     repository. Anything already half-done goes first.
//  2. Spend from whichever budget is emptier last. A 'full' item draws on both Claude (plan +
//     review) and Codex (implement); an 'implement_only' item draws on Codex alone. So when
//     Claude's windows are under more pressure than Codex's, the single-pool items go first,
//     leaving Claude's remaining headroom for the work that genuinely needs it. When Claude has
//     the freer budget the preference reverses, and when the two are level neither is preferred
//     and plain FIFO decides.
//
// Ties keep their SQL order (JS sort is stable), so project priority and queue position still
// decide everything these two rules don't.
export function orderCandidates<T extends Pick<Candidate, "status" | "mode">>(candidates: T[], usage: UsageSnapshot): T[] {
  const claude = pressure(usage.claudeSession, usage.claudeWeekly);
  const codex = pressure(usage.codexFiveHour, usage.codexWeekly);
  const cheaperFirst = claude === codex ? 0 : claude > codex ? 1 : -1;
  const rank = (candidate: T): { finish: number; cost: number } => ({
    finish: candidate.status === "plan_ready" ? 0 : 1,
    cost: cheaperFirst * (candidate.mode === "implement_only" ? -1 : 1),
  });
  return [...candidates].sort((a, b) => {
    const left = rank(a), right = rank(b);
    return left.finish - right.finish || left.cost - right.cost;
  });
}

export class AutoDispatchSettingsStore {
  constructor(private db: Db) {}
  get(): AutoDispatchSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='auto_dispatch'").get() as { value: string } | undefined;
    if (!row) return DEFAULT_AUTO_DISPATCH;
    try { return { ...DEFAULT_AUTO_DISPATCH, ...JSON.parse(row.value) } as AutoDispatchSettings; } catch { return DEFAULT_AUTO_DISPATCH; }
  }
  set(patch: Partial<AutoDispatchSettings>): AutoDispatchSettings {
    const next = { ...this.get(), ...patch };
    if (typeof next.maxPercentUsed !== "number" || next.maxPercentUsed < 1 || next.maxPercentUsed > 100) throw new Error("maxPercentUsed must be between 1 and 100");
    this.db.prepare("INSERT INTO settings(key,value) VALUES('auto_dispatch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
    return next;
  }
}

// Registers a fire-and-forget background task so its caller can track/await it (app.ts's own
// `schedule` helper does exactly this for the equivalent HTTP routes, feeding the same
// `background` set its shutdown hook awaits before closing the database) -- without this, a
// server shutdown (or, in a test, the next db.close()) can race a still-running dispatched job
// and throw "database is not open" out of a detached promise nothing is watching.
export type Scheduler = (task: Promise<unknown>) => void;

export class AutoDispatchService {
  constructor(private db: Db, private queue: QueueService, private settingsStore: AutoDispatchSettingsStore, private schedule: Scheduler = (task) => { void task; }) {}

  // Runs one decision per call: find the single highest-priority, oldest-waiting candidate
  // across every project whose required pools currently have room, and start it. Deliberately
  // dispatches at most one item per tick rather than draining every eligible candidate at
  // once -- the existing concurrency-slot gate in QueueService still serializes actual
  // execution, but this keeps each tick's decision easy to reason about, and lets a fresh
  // usage reading land between dispatches instead of planning a whole batch against one
  // now-stale snapshot.
  async tick(usage: UsageSnapshot): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.enabled) return;
    const candidates = this.db.prepare(`
      SELECT q.id id, q.status status, q.mode mode
      FROM queued_prompts q JOIN projects p ON p.id = q.project_id
      WHERE q.status IN ('queued','plan_ready')
      ORDER BY p.priority DESC, q.position ASC, q.created_at ASC
    `).all() as unknown as Candidate[];
    const next = orderCandidates(candidates, usage).find((candidate) => requiredPoolsOk(candidate, usage, settings.maxPercentUsed));
    if (!next) return;
    try {
      // Handed to `schedule` rather than awaited directly: planning/implementing/reviewing can
      // run for minutes, and (like the equivalent HTTP routes in app.ts) this tick only needs
      // to kick the stage off. QueueService's own methods already record success/failure on
      // the row and never reject once a stage is actually running, so `schedule` is purely for
      // shutdown/cleanup tracking, not error handling.
      if (next.status === "queued") {
        this.schedule(this.queue.runPlanStage(next.id));
      } else {
        await this.queue.approvePlan(next.id);
        this.schedule(this.queue.runImplementReviewLoop(next.id));
      }
    } catch {
      // approvePlan can still reject synchronously (a concurrent human approval/cancel raced
      // it, the project was removed, etc.); the row is left in a retriable state by
      // approvePlan itself, so the next tick simply reconsiders it -- nothing to do here but
      // avoid crashing this interval's tick on an unhandled rejection.
    }
  }
}
