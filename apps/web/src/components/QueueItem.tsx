import { useEffect, useState } from "react";
import type { PipelineEvent, QueuedPrompt, QueueStatus } from "@pm/shared";
import { api } from "../api.js";

const labels: Record<QueueStatus, string> = {
  queued: "Queued", planning: "Planning", plan_ready: "Plan ready — approve", implementing: "Implementing",
  reviewing: "Reviewing", fixing: "Applying fixes", done: "Review clean", review_exhausted: "Needs attention — fixes exhausted",
  failed: "Failed — needs attention", cancelled: "Cancelled",
};

function Timeline({ item }: { item: QueuedPrompt }) {
  const order: QueueStatus[] = ["queued", "planning", "plan_ready", "implementing", "fixing", "reviewing", "done"];
  const index = item.status === "review_exhausted" || item.status === "failed" ? 5 : order.indexOf(item.status);
  return <div className="pipeline-timeline">
    {(["Plan", "Implement", "Review"] as const).map((stage, stageIndex) => {
      const threshold = [1, 3, 5][stageIndex]!;
      const complete = stageIndex === 0 ? index >= 2 : stageIndex === 1 ? index >= 5 : item.status === "done";
      return <span className={complete ? "complete" : index >= threshold ? "active" : ""} key={stage}><i />{stage}</span>;
    })}
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
    <header><span className={`status ${item.status}`}>{labels[item.status]}</span>{item.needsAttention && <strong className="attention-flag">Action required</strong>}</header>
    <p>{item.text}</p><Timeline item={item}/>
    {item.status === "plan_ready" && <div className="plan-editor"><label>Review and edit the plan<textarea value={plan} onChange={(event) => setPlan(event.target.value)} /></label><div className="row"><button onClick={() => void action(() => api.editPlan(item.id, plan))}>Save edit</button><button className="approve" onClick={() => void action(() => api.approvePlan(item.id))}>Approve &amp; implement</button></div>{item.planOriginalText !== item.planText && <small>Edited from Claude's original draft</small>}</div>}
    {item.status === "review_exhausted" && <div className="review-attention"><strong>Independent review still found issues.</strong><pre>{item.reviewNotes}</pre><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Optional guidance for the next fix round"/><button onClick={() => void action(() => api.requestFixes(item.id, instructions))}>Request another fix round</button></div>}
    {item.resultDiffSummary && <pre>{item.resultDiffSummary}</pre>}{item.errorMessage && <p className="error">{item.errorMessage}</p>}
    <div className="row actions">
      {item.status === "queued" && <><button onClick={() => void action(() => api.pushPrompt(item.id))}>Start planning</button><button className="ghost" aria-label="Move up" onClick={() => void action(() => api.patchPrompt(item.id, { position: item.position - 1 }))}>↑</button><button className="ghost" aria-label="Move down" onClick={() => void action(() => api.patchPrompt(item.id, { position: item.position + 1 }))}>↓</button></>}
      {["queued", "plan_ready", "review_exhausted", "failed"].includes(item.status) && <button className="ghost" onClick={() => void action(() => api.patchPrompt(item.id, { status: "cancelled" }))}>Cancel</button>}
      <button className="ghost event-toggle" onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide activity" : "View activity"}</button>
    </div>
    {expanded && <ol className="event-log">{events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.stage} · {event.kind.replaceAll("_", " ")}</strong><p>{event.message}</p></div></li>)}</ol>}
  </article>;
}
