import { useEffect, useState } from "react";
import type { PipelineEvent, QueuedPrompt, QueueStatus } from "@pm/shared";
import { api } from "../api.js";

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
  const [instructions, setInstructions] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  useEffect(() => setPlan(item.planText ?? ""), [item.planText]);
  useEffect(() => {
    if (expanded) void api.pipelineEvents(item.id).then(setEvents).catch((error) => onError(error.message));
    const listener = (raw: Event) => {
      const event = (raw as CustomEvent<PipelineEvent>).detail;
      if (event.promptId === item.id) setEvents((current) => current.some((row) => row.id === event.id) ? current : [...current, event]);
    };
    window.addEventListener("pipeline-event", listener); return () => window.removeEventListener("pipeline-event", listener);
  }, [expanded, item.id, onError]);
  const action = async (work: () => Promise<unknown>) => { try { await work(); reload(); } catch (error) { onError((error as Error).message); } };
  return <article className={`queue-item ${item.needsAttention ? "attention" : ""}`}>
    <header><span className={`status ${item.status}`}>{labels[item.status]}</span>{item.mode === "implement_only" && <span className="mode-badge">Implement only</span>}{item.dispatch === "instant" && <span className="mode-badge instant">Instant</span>}{item.needsAttention && <strong className="attention-flag">Action required</strong>}</header>
    <p>{item.text}</p><Timeline item={item}/>
    {item.status === "plan_ready" && <div className="plan-editor"><label>Review and edit the plan<textarea value={plan} onChange={(event) => setPlan(event.target.value)} /></label><div className="row"><button onClick={() => void action(() => api.editPlan(item.id, plan))}>Save edit</button><button className="approve" onClick={() => void action(() => api.approvePlan(item.id))}>Approve &amp; implement</button></div>{item.planOriginalText !== item.planText && <small>Edited from Claude's original draft</small>}</div>}
    {item.status === "review_exhausted" && <div className="review-attention"><strong>Independent review still found issues.</strong><pre>{item.reviewNotes}</pre><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Optional guidance for the next fix round"/><button onClick={() => void action(() => api.requestFixes(item.id, instructions))}>Request another fix round</button></div>}
    {item.resultDiffSummary && <pre>{item.resultDiffSummary}</pre>}{item.errorMessage && <p className="error">{item.errorMessage}</p>}
    <div className="row actions">
      {item.status === "queued" && <><button onClick={() => void action(() => api.pushPrompt(item.id))}>{item.mode === "implement_only" ? "Start implementing" : "Start planning"}</button><button className="ghost" aria-label="Move up" onClick={() => void action(() => api.patchPrompt(item.id, { position: item.position - 1 }))}>↑</button><button className="ghost" aria-label="Move down" onClick={() => void action(() => api.patchPrompt(item.id, { position: item.position + 1 }))}>↓</button></>}
      {item.status === "failed" && <button onClick={() => void action(() => api.retryFailed(item.id))}>{item.worktreePath ? "Retry from worktree" : "Retry"}</button>}
      {["queued", "plan_ready", "review_exhausted", "failed"].includes(item.status) && <button className="ghost" onClick={() => void action(() => api.patchPrompt(item.id, { status: "cancelled" }))}>Cancel</button>}
      <button className="ghost event-toggle" onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide activity" : "View activity"}</button>
    </div>
    {expanded && <ol className="event-log">{events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.stage} · {event.kind.replaceAll("_", " ")}</strong><p>{event.message}</p></div></li>)}</ol>}
  </article>;
}
