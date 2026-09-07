import { useEffect, useState } from "react";
import type { PipelineEvent, PipelineStage, QueuedPrompt, QueueStatus } from "@pm/shared";
import { api } from "../api.js";
import { TerminalPanel } from "./TerminalPanel.js";

export const labels: Record<QueueStatus, string> = {
  queued: "Queued", planning: "Planning", plan_ready: "Plan ready — approve", implementing: "Implementing",
  reviewing: "Reviewing", fixing: "Applying fixes", done: "Review clean", review_exhausted: "Needs attention — fixes exhausted",
  failed: "Failed — needs attention", cancelled: "Cancelled",
};

type StageState = "" | "active" | "complete" | "failed" | "skip";
type Stages = Record<"plan" | "implement" | "review", StageState>;

// Single source of truth for what the three-stage timeline shows: one switch over the
// authoritative `status`, not independently-hand-maintained index/threshold arithmetic.
// A 'failed' status is disambiguated using fields that are already on the row (no schema
// change needed) so a plan-stage failure never renders Implement as falsely complete.
function stageStates(item: QueuedPrompt): Stages {
  // Implement-only mode never produces a plan draft or a review verdict, so those two
  // stages always render as skipped rather than tracking a status they'll never reach.
  if (item.mode === "implement_only") {
    switch (item.status) {
      case "implementing": return { plan: "skip", implement: "active", review: "skip" };
      case "done": return { plan: "skip", implement: "complete", review: "skip" };
      case "failed": return { plan: "skip", implement: "failed", review: "skip" };
      default: return { plan: "skip", implement: "", review: "skip" }; // queued or cancelled
    }
  }
  switch (item.status) {
    case "queued": return { plan: "", implement: "", review: "" };
    case "planning": return { plan: "active", implement: "", review: "" };
    case "plan_ready": return { plan: "complete", implement: "", review: "" };
    case "implementing": case "fixing": return { plan: "complete", implement: "active", review: "" };
    case "reviewing": return { plan: "complete", implement: "complete", review: "active" };
    case "review_exhausted": return { plan: "complete", implement: "complete", review: "failed" };
    case "done": return { plan: "complete", implement: "complete", review: "complete" };
    case "failed":
      if (!item.worktreePath) return { plan: "failed", implement: "", review: "" };
      if (!item.reviewVerdict) return { plan: "complete", implement: "failed", review: "" };
      return { plan: "complete", implement: "complete", review: "failed" };
    default: return { plan: "", implement: "", review: "" }; // cancelled
  }
}

// Which stage's transcript is most likely to actually have something worth reading right now --
// used only to pick the Live-terminal panel's initial tab, so opening it doesn't default to an
// empty "Implement" view while a plan is still being drafted.
function currentStage(item: QueuedPrompt): PipelineStage {
  switch (item.status) {
    case "queued": case "planning": case "plan_ready": return "plan";
    case "implementing": case "fixing": return "implement";
    case "reviewing": case "review_exhausted": case "done": return "review";
    case "failed": return item.reviewVerdict ? "review" : item.worktreePath ? "implement" : "plan";
    default: return "implement"; // cancelled
  }
}

function Timeline({ item }: { item: QueuedPrompt }) {
  const states = stageStates(item);
  return <div className="pipeline-timeline">
    {([["plan", "Plan"], ["implement", "Implement"], ["review", "Review"]] as const).map(([key, label]) => (
      <span className={states[key]} key={key}><i />{label}</span>
    ))}
    {item.fixRoundsUsed > 0 && <small>{item.fixRoundsUsed} fix round{item.fixRoundsUsed === 1 ? "" : "s"}</small>}
  </div>;
}

export function QueueItem({ item, reload, onError }: { item: QueuedPrompt; reload: () => void; onError: (message: string) => void }) {
  const [plan, setPlan] = useState(item.planText ?? "");
  const [reviewPrompt, setReviewPrompt] = useState(item.reviewPrompt ?? "");
  const [instructions, setInstructions] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<"activity" | "terminal">("activity");
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [checkpointIndex, setCheckpointIndex] = useState(item.checkpointIndex);
  const [checkpointNote, setCheckpointNote] = useState("");
  useEffect(() => setPlan(item.planText ?? ""), [item.planText]);
  useEffect(() => setReviewPrompt(item.reviewPrompt ?? ""), [item.reviewPrompt]);
  useEffect(() => setCheckpointIndex(item.checkpointIndex), [item.checkpointIndex]);
  // Live increments (see App.tsx's "job.checkpoint" CustomEvent) update this row directly --
  // the checkpoint marker is a best-effort progress report from the same agent doing the
  // implementation work, not an independently verified count.
  useEffect(() => {
    const listener = (raw: Event) => {
      const detail = (raw as CustomEvent<{ promptId: string; index: number; description: string }>).detail;
      if (detail.promptId !== item.id) return;
      setCheckpointIndex(detail.index); setCheckpointNote(detail.description);
    };
    window.addEventListener("job.checkpoint", listener);
    return () => window.removeEventListener("job.checkpoint", listener);
  }, [item.id]);
  useEffect(() => {
    if (detailsOpen) void api.pipelineEvents(item.id).then(setEvents).catch((error) => onError(error.message));
    const listener = (raw: Event) => {
      const event = (raw as CustomEvent<PipelineEvent>).detail;
      if (event.promptId === item.id) setEvents((current) => current.some((row) => row.id === event.id) ? current : [...current, event]);
    };
    window.addEventListener("pipeline-event", listener); return () => window.removeEventListener("pipeline-event", listener);
  }, [detailsOpen, item.id, onError]);
  const action = async (work: () => Promise<unknown>) => { try { await work(); reload(); } catch (error) { onError((error as Error).message); } };
  return <article className={`queue-item ${item.needsAttention ? "attention" : ""}`}>
    <header><span className={`status ${item.status}`}>{labels[item.status]}</span>{item.mode === "implement_only" && <span className="mode-badge">Implement only</span>}{item.dispatch === "instant" && <span className="mode-badge instant">Instant</span>}{item.needsAttention && <strong className="attention-flag">Action required</strong>}</header>
    <p>{item.text}</p><Timeline item={item}/>
    {Boolean(item.checkpoints?.length) && <div className="checkpoint-progress">
      <div className="checkpoint-track"><div style={{ width: `${Math.round((checkpointIndex / item.checkpoints!.length) * 100)}%` }}/></div>
      <small>{checkpointIndex}/{item.checkpoints!.length} checkpoints{checkpointNote ? ` — ${checkpointNote}` : ""}</small>
    </div>}
    {item.status === "plan_ready" && <div className="plan-editor">
      {/* The concise readout is what you actually review by default -- what's being added,
          briefly how, and what's tested. The full plan text is still what gets approved and fed
          to Codex verbatim, so it (and the review instructions) stay one click away, not hidden
          entirely -- just not the first thing flooding this screen. */}
      {item.planSummary
        ? <div className="plan-summary"><strong>What this plan does</strong><p>{item.planSummary}</p></div>
        : <p className="muted">This plan didn't include a short summary — review the full plan below.</p>}
      <details open={!item.planSummary}>
        <summary>Review &amp; edit the full plan{item.reviewPrompt !== null ? " and review instructions" : ""}</summary>
        <label>Plan text<textarea value={plan} onChange={(event) => setPlan(event.target.value)} /></label>
        <div className="row"><button onClick={() => void action(() => api.editPlan(item.id, plan))}>Save plan edit</button></div>
        {item.planOriginalText !== item.planText && <small>Edited from Claude's original draft</small>}
        {item.reviewPrompt !== null && <>
          <label>Review instructions (given to the independent reviewer)<textarea value={reviewPrompt} onChange={(event) => setReviewPrompt(event.target.value)} /></label>
          <div className="row"><button onClick={() => void action(() => api.editReviewPrompt(item.id, reviewPrompt))}>Save review-instructions edit</button></div>
          {item.reviewPromptOriginalText !== item.reviewPrompt && <small>Edited from Claude's original draft</small>}
        </>}
      </details>
      <div className="row"><button className="approve" onClick={() => void action(() => api.approvePlan(item.id))}>Approve &amp; implement</button></div>
    </div>}
    {item.status === "review_exhausted" && <div className="review-attention"><strong>Independent review still found issues.</strong><pre>{item.reviewNotes}</pre><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Optional guidance for the next fix round"/><button onClick={() => void action(() => api.requestFixes(item.id, instructions))}>Request another fix round</button></div>}
    {item.resultDiffSummary && <pre>{item.resultDiffSummary}</pre>}{item.errorMessage && <p className="error">{item.errorMessage}</p>}
    <div className="row actions">
      {item.status === "queued" && <><button onClick={() => void action(() => api.pushPrompt(item.id))}>{item.mode === "implement_only" ? "Start implementing" : "Start planning"}</button><button className="ghost" aria-label="Move up" onClick={() => void action(() => api.patchPrompt(item.id, { position: item.position - 1 }))}>↑</button><button className="ghost" aria-label="Move down" onClick={() => void action(() => api.patchPrompt(item.id, { position: item.position + 1 }))}>↓</button></>}
      {item.status === "failed" && <button onClick={() => void action(() => api.retryFailed(item.id))}>{item.worktreePath ? "Retry from worktree" : "Retry"}</button>}
      {["queued", "plan_ready", "review_exhausted", "failed"].includes(item.status) && <button className="ghost" onClick={() => void action(() => api.patchPrompt(item.id, { status: "cancelled" }))}>Cancel</button>}
      <button className="ghost event-toggle" onClick={() => setDetailsOpen((value) => !value)}>{detailsOpen ? "Hide details" : "Details"}</button>
    </div>
    {/* One toggle, not two -- the curated activity log and the raw live terminal are both just
        different views onto "what is this job doing", so they share a single collapsed-by-
        default panel with an internal tab switch instead of each cluttering the actions row
        with its own always-visible button. */}
    {detailsOpen && <div className="details-panel">
      <div className="details-tabs">
        <button type="button" className={detailsTab === "activity" ? "active" : ""} onClick={() => setDetailsTab("activity")}>Activity</button>
        <button type="button" className={detailsTab === "terminal" ? "active" : ""} onClick={() => setDetailsTab("terminal")}>Live terminal</button>
      </div>
      {detailsTab === "activity" && <ol className="event-log">{events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.stage} · {event.kind.replaceAll("_", " ")}</strong><p>{event.message}</p></div></li>)}</ol>}
      {detailsTab === "terminal" && <TerminalPanel promptId={item.id} defaultStage={currentStage(item)} onError={onError}/>}
    </div>}
  </article>;
}
