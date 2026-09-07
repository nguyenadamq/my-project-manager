import { nanoid } from "nanoid";
import type { DispatchMode, PipelineDefaults, PipelineEvent, PipelineMode, PipelineOverrides, PipelineStage, QueuedPrompt, QueueStatus } from "@pm/shared";
import type { Db } from "../db.js";
import type { EventHub } from "../events.js";
import { createWorktree, git, writeTrigger } from "./git.js";
import type { PipelineRunner } from "./pipeline-runner.js";
import type { SettingsService } from "./settings.js";

const activeStatuses: QueueStatus[] = ["planning", "implementing", "reviewing", "fixing"];
export const selectQueue = `SELECT id,project_id projectId,text,position,status,mode,dispatch,created_at createdAt,started_at startedAt,finished_at finishedAt,result_branch resultBranch,result_diff_summary resultDiffSummary,error_message errorMessage,needs_attention needsAttention,worktree_path worktreePath,base_sha baseSha,plan_text planText,plan_original_text planOriginalText,plan_summary planSummary,review_prompt reviewPrompt,review_prompt_original_text reviewPromptOriginalText,plan_approved_at planApprovedAt,fix_rounds_used fixRoundsUsed,review_verdict reviewVerdict,review_notes reviewNotes,run_overrides runOverrides,plan_model planModel,plan_effort planEffort,implement_model implementModel,implement_effort implementEffort,review_model reviewModel,review_effort reviewEffort,checkpoints,checkpoint_index checkpointIndex FROM queued_prompts`;

export function mapPrompt(row: Record<string, unknown> | undefined): QueuedPrompt | null {
  if (!row) return null;
  return {
    ...row,
    needsAttention: Boolean(row.needsAttention),
    runOverrides: row.runOverrides ? JSON.parse(String(row.runOverrides)) as PipelineOverrides : null,
    checkpoints: row.checkpoints ? JSON.parse(String(row.checkpoints)) as string[] : null,
  } as QueuedPrompt;
}

export class QueueService {
  // Ids whose plan stage has been kicked off but hasn't claimed its concurrency slot yet. An
  // instant-dispatch item is started by the add route the moment it's created, while its row
  // still reads 'queued' -- exactly the state auto-dispatch looks for -- so without this the
  // next tick could start a second run for the same item. (The post-slot status re-check below
  // would still make that harmless, but it would sit holding a slot to discover it.)
  private starting = new Set<string>();
  private runningProjects = new Set<string>();
  private runningGlobal = 0;
  private slotWaiters: Array<() => void> = [];
  // Holds each (promptId,stage)'s trailing partial line between chunks, so a PM_CHECKPOINT
  // marker split across two "data" events is still recognized once the newline that completes
  // it arrives. Cleared by resetOutput at the start of every fresh attempt for that stage.
  private outputBuffers = new Map<string, string>();
  // Per-stage transcript cap (see pipeline_output migration): generous enough for a real
  // implement/review pass, small enough that a runaway or looping agent can't grow a job's row
  // without bound.
  private static readonly OUTPUT_CAP = 500_000;

  // Fired after every "completed"/"verdict"/"failed" pipeline event -- i.e. right after each
  // real plan/implement/review CLI turn against Claude or Codex finishes, win or lose. This is
  // the hook cli-usage-scraper.ts's on-demand reading is meant to run from: piggybacking on a
  // turn that already just happened is free, and far fresher than any fixed polling interval.
  constructor(private db: Db, private events: EventHub, private runner: PipelineRunner, private settings: SettingsService, private concurrency = 1, private onCliTurnFinished: () => void = () => {}) {}

  private get(id: string) { return mapPrompt(this.db.prepare(`${selectQueue} WHERE id=?`).get(id) as Record<string, unknown> | undefined); }
  list(projectId: string): QueuedPrompt[] { return (this.db.prepare(`${selectQueue} WHERE project_id=? ORDER BY position,created_at`).all(projectId) as Record<string, unknown>[]).map((row) => mapPrompt(row)!); }

  // Called once at server startup (see app.ts). Any row still sitting in one of activeStatuses
  // at that moment cannot actually be running -- this process just started, and holds no
  // in-memory job for it -- so it can only mean the previous process died mid-run: a crash, a
  // kill, a machine restart. Left alone it would sit there forever, looking "in progress" while
  // nothing is actually driving it. Marking each one failed (with needsAttention set) surfaces
  // it immediately and makes the existing retry endpoint able to pick it back up: implement/
  // review failures resume from the worktree already on disk, planning failures start over from
  // queued.
  recoverInterruptedJobs(): number {
    const stuck = this.db.prepare(`SELECT id FROM queued_prompts WHERE status IN (${activeStatuses.map(() => "?").join(",")})`).all(...activeStatuses) as { id: string }[];
    for (const { id } of stuck) {
      const item = this.get(id);
      if (!item) continue;
      const stage: PipelineStage = item.status === "planning" ? "plan" : item.status === "reviewing" ? "review" : "implement";
      this.fail(item, stage, new Error("Interrupted by a server restart before this stage finished. Retry to resume."));
    }
    return stuck.length;
  }

  add(projectId: string, text: string, runOverrides?: PipelineOverrides, mode: PipelineMode = "full", dispatch: DispatchMode = "queued"): QueuedPrompt {
    if (!text.trim()) throw new Error("Prompt text is required");
    if (mode !== "full" && mode !== "implement_only") throw new Error("Invalid pipeline mode");
    if (dispatch !== "instant" && dispatch !== "queued") throw new Error("Invalid dispatch mode");
    if (!this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("Project not found");
    if (runOverrides) this.settings.validate(runOverrides);
    const position = Number((this.db.prepare("SELECT COALESCE(MAX(position),0) value FROM queued_prompts WHERE project_id=?").get(projectId) as { value: number }).value) + 1;
    const id = nanoid(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO queued_prompts(id,project_id,text,position,status,mode,dispatch,created_at,run_overrides) VALUES($id,$projectId,$text,$position,'queued',$mode,$dispatch,$createdAt,$overrides)").run({ $id: id, $projectId: projectId, $text: text.trim(), $position: position, $mode: mode, $dispatch: dispatch, $createdAt: now, $overrides: runOverrides ? JSON.stringify(runOverrides) : null });
    this.events.emit({ type: "queue.updated", projectId });
    return this.get(id)!;
  }

  update(id: string, patch: { text?: string; position?: number; status?: "cancelled" }): QueuedPrompt {
    const current = this.get(id); if (!current) throw new Error("Prompt not found");
    if (activeStatuses.includes(current.status)) throw new Error("An active pipeline cannot be edited");
    if (patch.status === "cancelled" && !["queued", "plan_ready", "review_exhausted", "failed"].includes(current.status)) throw new Error("This prompt cannot be cancelled now");
    const count = Number((this.db.prepare("SELECT COUNT(*) value FROM queued_prompts WHERE project_id=?").get(current.projectId) as { value: number }).value);
    const position = patch.position === undefined ? current.position : Math.max(1, Math.min(count, patch.position));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (position < current.position) this.db.prepare("UPDATE queued_prompts SET position=position+1 WHERE project_id=? AND position>=? AND position<?").run(current.projectId, position, current.position);
      if (position > current.position) this.db.prepare("UPDATE queued_prompts SET position=position-1 WHERE project_id=? AND position>? AND position<=?").run(current.projectId, current.position, position);
      this.db.prepare("UPDATE queued_prompts SET text=?,position=?,status=?,needs_attention=? WHERE id=?").run(patch.text?.trim() || current.text, position, patch.status ?? current.status, patch.status === "cancelled" ? 0 : Number(current.needsAttention), id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (patch.status === "cancelled") this.logEvent(current, "system", "cancelled", "Pipeline cancelled by the user.");
    this.events.emit({ type: "queue.updated", projectId: current.projectId });
    return this.get(id)!;
  }

  editPlan(id: string, text: string) {
    const item = this.get(id); if (!item || item.status !== "plan_ready") throw new Error("Plan can only be edited while awaiting approval");
    if (!text.trim()) throw new Error("Plan text is required");
    this.db.prepare("UPDATE queued_prompts SET plan_text=? WHERE id=?").run(text.trim(), id);
    this.logEvent(item, "plan", "output", "The user edited Claude's draft plan.");
    this.events.emit({ type: "queue.updated", projectId: item.projectId });
    return this.get(id)!;
  }

  editReviewPrompt(id: string, text: string) {
    const item = this.get(id); if (!item || item.status !== "plan_ready") throw new Error("Review instructions can only be edited while awaiting approval");
    if (!text.trim()) throw new Error("Review instructions are required");
    this.db.prepare("UPDATE queued_prompts SET review_prompt=? WHERE id=?").run(text.trim(), id);
    this.logEvent(item, "plan", "output", "The user edited the review instructions.");
    this.events.emit({ type: "queue.updated", projectId: item.projectId });
    return this.get(id)!;
  }

  async runPlanStage(id: string): Promise<void> {
    const item = this.get(id); if (!item || item.status !== "queued") throw new Error("Queued prompt not found");
    if (this.starting.has(id)) return; // already kicked off and waiting for a slot
    this.starting.add(id);
    const project = this.db.prepare("SELECT path,pipeline_overrides pipelineOverrides FROM projects WHERE id=?").get(item.projectId) as { path: string; pipelineOverrides: string | null } | undefined;
    if (!project) throw new Error("Project not found");
    const config = this.settings.resolve(project.pipelineOverrides, item.runOverrides ? JSON.stringify(item.runOverrides) : null);
    // Snapshot the resolved config now, but do NOT flip status off 'queued' yet: the item
    // must stay cancellable/editable (see update()'s activeStatuses guard) for as long as
    // it's merely waiting behind another job for a free concurrency slot, not actually
    // running. Only claim it once the slot is actually acquired, immediately before the
    // subprocess call that could hang.
    this.db.prepare("UPDATE queued_prompts SET plan_model=?,plan_effort=?,implement_model=?,implement_effort=?,review_model=?,review_effort=? WHERE id=?").run(config.plan.model, config.plan.effort, config.implement.model, config.implement.effort, config.review.model, config.review.effort, id);
    const release = await this.acquireSlot(item.projectId);
    try {
      const current = this.get(id);
      if (!current || current.status !== "queued") return; // cancelled while waiting for a slot
      this.starting.delete(id); // claimed: the row's own status now guards against a second run
      if (current.mode === "implement_only") { await this.runImplementOnly(current, project.path, config); return; }
      this.db.prepare("UPDATE queued_prompts SET status='planning',started_at=?,needs_attention=0,error_message=NULL WHERE id=?").run(new Date().toISOString(), id);
      this.progress(current, "planning"); this.logEvent(current, "plan", "started", `Planning with ${config.plan.model} (${config.plan.effort}).`);
      this.resetOutput(id, "plan");
      const plan = await this.runner.plan({ repo: project.path, prompt: current.text, ...config.plan, onOutput: (stream, chunk) => this.captureOutput(current, "plan", stream, chunk, false) });
      const checkpoints = plan.checkpoints ?? [];
      this.db.prepare("UPDATE queued_prompts SET status='plan_ready',plan_text=?,plan_original_text=?,plan_summary=?,review_prompt=?,review_prompt_original_text=?,checkpoints=?,checkpoint_index=0,needs_attention=1 WHERE id=?").run(plan.text, plan.text, plan.summary?.trim() || null, plan.reviewPrompt, plan.reviewPrompt, checkpoints.length ? JSON.stringify(checkpoints) : null, id);
      this.logEvent(current, "plan", "completed", "Draft plan completed.");
      this.logEvent(current, "plan", "awaiting_approval", "Plan is ready for human review and approval.");
      this.progress(current, "plan_ready");
    } catch (error) {
      // Attribute the failure the same way runImplementReviewLoop does: whichever stage the
      // row's own status says was in flight (set synchronously right before the risky call).
      const current = this.get(id) ?? item;
      this.fail(current, current.status === "implementing" ? "implement" : "plan", error);
    } finally { this.starting.delete(id); release(); }
  }

  // Implement-only mode: no plan draft, no approval checkpoint, no independent review. Codex
  // implements the raw prompt text directly in the same isolated worktree/branch the full
  // pipeline uses, then the item goes straight to 'done' (or 'failed' on any error). Runs
  // under the slot already acquired by the caller, so it never needs a second push/approve
  // round-trip from the UI.
  private async runImplementOnly(item: QueuedPrompt, repo: string, config: PipelineDefaults): Promise<void> {
    this.db.prepare("UPDATE queued_prompts SET status='implementing',started_at=?,needs_attention=0,error_message=NULL,plan_text=? WHERE id=?").run(new Date().toISOString(), item.text, item.id);
    this.progress(item, "implementing");
    this.logEvent(item, "implement", "started", `Implementing with ${config.implement.model} (${config.implement.effort}). Plan and review are skipped in implement-only mode.`);
    const created = await createWorktree(repo, item.id);
    this.db.prepare("UPDATE queued_prompts SET worktree_path=?,result_branch=?,base_sha=?,plan_approved_at=? WHERE id=?").run(created.worktree, created.branch, created.baseSha, new Date().toISOString(), item.id);
    const current = this.get(item.id)!;
    this.resetOutput(item.id, "implement");
    // No plan stage in implement_only mode, so there is no drafted checkpoint list to report
    // against -- Codex works from the raw prompt directly, with no progress bar to feed.
    const summary = await this.runner.implement({ worktree: created.worktree, planText: item.text, model: config.implement.model, effort: config.implement.effort, onOutput: (stream, chunk) => this.captureOutput(current, "implement", stream, chunk, false) });
    const dirty = await git(created.worktree, ["status", "--porcelain"]);
    if (dirty) { await git(created.worktree, ["add", "-A"]); await git(created.worktree, ["commit", "-m", `pm: implement ${item.id}`]); }
    this.logEvent(current, "implement", "output", summary);
    this.logEvent(current, "implement", "completed", dirty ? "Implementation changes committed to the pipeline branch." : "Implementation completed without uncommitted changes.");
    await this.complete(current, repo);
  }

  async approvePlan(id: string): Promise<QueuedPrompt> {
    // The authorization check and the claim are the same synchronous, conditional UPDATE --
    // there is no separate check-then-write gap for a second, near-simultaneous approve call
    // to land in. Whichever call's synchronous statement runs first flips the row to
    // 'implementing' and gets changes===1; any other call (now or seconds later) matches
    // zero rows and fails fast with a clear message instead of racing `git worktree add`
    // for the same branch/path.
    const claim = this.db.prepare("UPDATE queued_prompts SET status='implementing',needs_attention=0 WHERE id=? AND status='plan_ready'").run(id);
    if (claim.changes === 0) throw new Error(this.get(id) ? "Only a completed plan can be approved" : "Prompt not found");
    const item = this.get(id)!;
    const project = this.db.prepare("SELECT path FROM projects WHERE id=?").get(item.projectId) as { path: string } | undefined;
    if (!project) { this.db.prepare("UPDATE queued_prompts SET status='plan_ready',needs_attention=1 WHERE id=?").run(id); throw new Error("Project not found"); }
    try {
      const created = await createWorktree(project.path, id);
      this.db.prepare("UPDATE queued_prompts SET worktree_path=?,result_branch=?,base_sha=?,plan_approved_at=? WHERE id=?").run(created.worktree, created.branch, created.baseSha, new Date().toISOString(), id);
      this.logEvent(item, "plan", "approved", "Plan approved; isolated worktree created.");
      this.progress(item, "implementing");
      return this.get(id)!;
    } catch (error) {
      // Revert the claim so the plan is retriable rather than stuck in a half-approved state.
      this.db.prepare("UPDATE queued_prompts SET status='plan_ready',needs_attention=1 WHERE id=?").run(id);
      throw error;
    }
  }

  async runImplementReviewLoop(id: string, automaticFixes = true): Promise<void> {
    let item = this.get(id);
    if (!item || !["implementing", "fixing"].includes(item.status) || !item.worktreePath || !item.baseSha || !item.planText) throw new Error("Pipeline is not ready to implement");
    const project = this.db.prepare("SELECT path FROM projects WHERE id=?").get(item.projectId) as { path: string } | undefined;
    if (!project) throw new Error("Project not found");
    const release = await this.acquireSlot(item.projectId);
    try {
      while (true) {
        item = this.get(id)!;
        // A separate `const` so the onOutput closures below capture a definitely-non-null
        // reference -- TS can't carry the narrowing from `item = this.get(id)!` on the mutable
        // `let item` into a closure that might run after a later reassignment.
        const current = item;
        const isFix = current.status === "fixing";
        this.db.prepare("UPDATE queued_prompts SET status=? WHERE id=?").run(isFix ? "fixing" : "implementing", id);
        this.progress(item, isFix ? "fixing" : "implementing");
        this.logEvent(item, "implement", isFix ? "fix_round_started" : "started", isFix ? `Starting fix round ${item.fixRoundsUsed}.` : `Implementing with ${item.implementModel} (${item.implementEffort}).`);
        this.resetOutput(id, "implement");
        // Checkpoint tracking only applies to the initial pass: a fix round works from review
        // feedback, not the original checkpoint list, so re-tracking against it here would be
        // meaningless (and checkpoint_index already reflects the first pass's progress).
        if (!isFix) this.db.prepare("UPDATE queued_prompts SET checkpoint_index=0 WHERE id=?").run(id);
        const summary = await this.runner.implement({ worktree: item.worktreePath!, planText: item.planText!, model: item.implementModel!, effort: item.implementEffort!, resume: isFix, feedback: item.reviewNotes ?? undefined, checkpoints: isFix ? undefined : (item.checkpoints ?? undefined), onOutput: (stream, chunk) => this.captureOutput(current, "implement", stream, chunk, !isFix) });
        const dirty = await git(item.worktreePath!, ["status", "--porcelain"]);
        if (dirty) {
          await git(item.worktreePath!, ["add", "-A"]);
          await git(item.worktreePath!, ["commit", "-m", isFix ? `pm: fix round ${item.fixRoundsUsed} for ${id}` : `pm: implement ${id}`]);
        }
        this.logEvent(item, "implement", "output", summary);
        this.logEvent(item, "implement", "completed", dirty ? "Implementation changes committed to the pipeline branch." : "Implementation completed without uncommitted changes.");

        this.db.prepare("UPDATE queued_prompts SET status='reviewing' WHERE id=?").run(id);
        this.progress(item, "reviewing"); this.logEvent(item, "review", "started", `Reviewing with ${item.reviewModel} (${item.reviewEffort}).`);
        this.resetOutput(id, "review");
        // A configurable project test command was considered; v1 gates on a successful Codex exit before independent review.
        const review = await this.runner.review({ worktree: item.worktreePath!, planText: item.planText!, reviewPrompt: item.reviewPrompt ?? "", baseRef: item.baseSha!, model: item.reviewModel!, effort: item.reviewEffort!, onOutput: (stream, chunk) => this.captureOutput(current, "review", stream, chunk, false) });
        this.db.prepare("UPDATE queued_prompts SET review_verdict=?,review_notes=? WHERE id=?").run(review.verdict, review.notes, id);
        this.logEvent(item, "review", "verdict", `${review.verdict}\n${review.notes}`);
        if (review.verdict === "CLEAN") { await this.complete(item, project.path); return; }

        item = this.get(id)!;
        if (automaticFixes && item.fixRoundsUsed < 2) {
          const nextRound = item.fixRoundsUsed + 1;
          this.db.prepare("UPDATE queued_prompts SET status='fixing',fix_rounds_used=? WHERE id=?").run(nextRound, id);
          continue;
        }
        this.exhaust(item); return;
      }
    } catch (error) {
      // Attribute the failure to whichever stage the row's own status says was in flight
      // when it threw (set synchronously right before each risky call above), rather than
      // a separately-tracked flag that a future stage added to this loop could forget to update.
      const current = this.get(id) ?? item;
      this.fail(current, current.status === "reviewing" ? "review" : "implement", error);
    } finally { release(); }
  }

  requestMoreFixes(id: string, instructions?: string): QueuedPrompt {
    const item = this.get(id); if (!item || item.status !== "review_exhausted") throw new Error("Additional fixes can only be requested after review is exhausted");
    const round = item.fixRoundsUsed + 1;
    const feedback = [item.reviewNotes, instructions?.trim()].filter(Boolean).join("\n\nAdditional human instructions:\n");
    this.db.prepare("UPDATE queued_prompts SET status='fixing',fix_rounds_used=?,review_notes=?,needs_attention=0 WHERE id=?").run(round, feedback, id);
    this.logEvent(item, "implement", "fix_round_started", `Human requested fix round ${round}.`);
    this.progress(item, "fixing"); return this.get(id)!;
  }

  // A failed item previously had no way back except Cancel -- the only recovery was manually
  // re-adding the same prompt text as a brand-new item, losing its history. Whether a worktree
  // already exists tells us how much progress survives: nothing durable was created if it
  // failed during planning (worktreePath is still null), so it goes back to 'queued' for a
  // normal push. If it failed during implement/review the worktree/branch/plan are already
  // real and valid, so this resumes the implement/review loop directly from there -- but which
  // status it resumes into matters: runImplementReviewLoop treats 'implementing' as "run a
  // *fresh* `codex exec` with the original plan text" and 'fixing' as "`codex exec resume
  // --last` with feedback". Resuming as 'implementing' after Codex had already committed once
  // (review crashed, or a fix round failed) would fire a brand-new session at an already-
  // implemented worktree instead of continuing it -- likely duplicate or conflicting work.
  // Checking the worktree's real commit history (not fixRoundsUsed, which only increments on
  // a *new* fix round and stays 0 if e.g. the very first review crashed) is what actually
  // answers "does a prior Codex session exist here to resume".
  async retryFailed(id: string): Promise<QueuedPrompt> {
    const item = this.get(id); if (!item || item.status !== "failed") throw new Error("Only a failed item can be retried");
    if (!item.worktreePath) {
      this.db.prepare("UPDATE queued_prompts SET status='queued',needs_attention=0,error_message=NULL,finished_at=NULL,started_at=NULL WHERE id=?").run(id);
      this.logEvent(item, "plan", "started", "Human requested a retry; starting over.");
      this.progress(item, "queued");
      return this.get(id)!;
    }
    const hasPriorCommit = Number(await git(item.worktreePath, ["rev-list", "--count", `${item.baseSha}..HEAD`]).catch(() => "0")) > 0;
    const nextStatus = hasPriorCommit ? "fixing" : "implementing";
    this.db.prepare("UPDATE queued_prompts SET status=?,needs_attention=0,error_message=NULL,finished_at=NULL WHERE id=?").run(nextStatus, id);
    this.logEvent(item, "implement", "started", hasPriorCommit ? "Human requested a retry; resuming the existing Codex session from the last commit." : "Human requested a retry; running a fresh implement pass on the existing worktree.");
    this.progress(item, nextStatus);
    return this.get(id)!;
  }

  listEvents(promptId: string): PipelineEvent[] {
    return this.db.prepare("SELECT id,prompt_id promptId,project_id projectId,stage,kind,message,created_at createdAt FROM pipeline_events WHERE prompt_id=? ORDER BY created_at,id").all(promptId) as unknown as PipelineEvent[];
  }

  private async complete(item: QueuedPrompt, repo: string) {
    const stat = await git(item.worktreePath!, ["diff", "--stat", item.baseSha!, "HEAD"]).catch(() => "No diff summary available.");
    this.db.prepare("UPDATE queued_prompts SET status='done',finished_at=?,needs_attention=0,result_diff_summary=? WHERE id=?").run(new Date().toISOString(), stat, item.id);
    this.db.prepare("INSERT INTO usage_events(id,tool,kind,timestamp,note) VALUES(?, 'claude_code','job',?,?)").run(nanoid(), new Date().toISOString(), item.id);
    await writeTrigger(repo);
    this.logEvent(item, "review", "completed", "Independent review passed. Branch is ready for human inspection."); this.progress(item, "done");
  }

  private exhaust(item: QueuedPrompt) {
    this.db.prepare("UPDATE queued_prompts SET status='review_exhausted',needs_attention=1 WHERE id=?").run(item.id);
    this.logEvent(item, "review", "attention", "Automatic fix limit reached; human direction is required."); this.progress(item, "review_exhausted");
  }

  private fail(item: QueuedPrompt, stage: PipelineStage, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.db.prepare("UPDATE queued_prompts SET status='failed',finished_at=?,needs_attention=1,error_message=? WHERE id=?").run(new Date().toISOString(), message, item.id);
    this.logEvent(item, stage, "failed", message); this.logEvent(item, "system", "attention", "Pipeline failed and needs human attention."); this.progress(item, "failed");
  }

  private progress(item: QueuedPrompt, status: QueueStatus) {
    this.events.emit({ type: "job.progress", projectId: item.projectId, promptId: item.id, status });
    this.events.emit({ type: "queue.updated", projectId: item.projectId });
  }

  private logEvent(item: Pick<QueuedPrompt, "id" | "projectId">, stage: PipelineStage | "system", kind: PipelineEvent["kind"], message: string) {
    const event: PipelineEvent = { id: nanoid(), promptId: item.id, projectId: item.projectId, stage, kind, message, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO pipeline_events(id,prompt_id,project_id,stage,kind,message,created_at) VALUES(?,?,?,?,?,?,?)").run(event.id, event.promptId, event.projectId, event.stage, event.kind, event.message, event.createdAt);
    this.events.emit({ type: "pipeline.event", projectId: event.projectId, promptId: event.promptId, event });
    if (kind === "completed" || kind === "verdict" || kind === "failed") this.onCliTurnFinished();
  }

  // Called once, right before the risky runner call, so a stage's transcript always reflects
  // its current or most recent attempt -- not this attempt appended after a previous one that
  // failed or is being retried.
  private resetOutput(promptId: string, stage: PipelineStage) {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO pipeline_output(prompt_id,stage,content,truncated,updated_at) VALUES(?,?,'',0,?) ON CONFLICT(prompt_id,stage) DO UPDATE SET content='',truncated=0,updated_at=excluded.updated_at").run(promptId, stage, now);
    this.outputBuffers.delete(`${promptId}:${stage}`);
  }

  getOutput(promptId: string): Record<PipelineStage, { content: string; truncated: boolean }> {
    const rows = this.db.prepare("SELECT stage, content, truncated FROM pipeline_output WHERE prompt_id=?").all(promptId) as { stage: PipelineStage; content: string; truncated: number }[];
    const result: Record<PipelineStage, { content: string; truncated: boolean }> = { plan: { content: "", truncated: false }, implement: { content: "", truncated: false }, review: { content: "", truncated: false } };
    for (const row of rows) result[row.stage] = { content: row.content, truncated: Boolean(row.truncated) };
    return result;
  }

  // Passed as `onOutput` into the runner's plan/implement/review calls: persists the growing,
  // capped transcript for this stage and forwards the raw chunk live over the websocket
  // (job.output). When `trackCheckpoints` is set (the initial, non-fix implement pass only --
  // see runImplementReviewLoop), it also line-buffers stdout looking for the PM_CHECKPOINT
  // marker Codex is asked to echo (see buildImplementStdin) and turns a match into a persisted
  // checkpoint_index update plus a live job.checkpoint event.
  private captureOutput(item: Pick<QueuedPrompt, "id" | "projectId">, stage: PipelineStage, stream: "stdout" | "stderr", chunk: string, trackCheckpoints: boolean) {
    const row = this.db.prepare("SELECT content, truncated FROM pipeline_output WHERE prompt_id=? AND stage=?").get(item.id, stage) as { content: string; truncated: number } | undefined;
    let content = (row?.content ?? "") + chunk;
    let truncated = Boolean(row?.truncated);
    if (content.length > QueueService.OUTPUT_CAP) { content = content.slice(content.length - QueueService.OUTPUT_CAP); truncated = true; }
    const now = new Date().toISOString();
    if (row) this.db.prepare("UPDATE pipeline_output SET content=?,truncated=?,updated_at=? WHERE prompt_id=? AND stage=?").run(content, Number(truncated), now, item.id, stage);
    else this.db.prepare("INSERT INTO pipeline_output(prompt_id,stage,content,truncated,updated_at) VALUES(?,?,?,?,?)").run(item.id, stage, content, Number(truncated), now);
    this.events.emit({ type: "job.output", projectId: item.projectId, promptId: item.id, stage, stream, chunk });

    if (!trackCheckpoints || stream !== "stdout") return;
    const key = `${item.id}:${stage}`;
    const pending = (this.outputBuffers.get(key) ?? "") + chunk;
    const lines = pending.split(/\r?\n/);
    this.outputBuffers.set(key, lines.pop() ?? ""); // keep the trailing partial line for next time
    for (const line of lines) {
      const match = /^PM_CHECKPOINT\s+(\d+)\s*\/\s*(\d+)\s*:\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const index = Number(match[1]); const total = Number(match[2]); const description = match[3]!.trim();
      this.db.prepare("UPDATE queued_prompts SET checkpoint_index=? WHERE id=?").run(index, item.id);
      this.events.emit({ type: "job.checkpoint", projectId: item.projectId, promptId: item.id, index, total, description });
    }
  }

  private async acquireSlot(projectId: string): Promise<() => void> {
    while (this.runningProjects.has(projectId) || this.runningGlobal >= this.concurrency) await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.runningProjects.add(projectId); this.runningGlobal++;
    return () => {
      this.runningProjects.delete(projectId); this.runningGlobal--;
      const waiters = this.slotWaiters.splice(0); for (const wake of waiters) wake();
    };
  }
}
