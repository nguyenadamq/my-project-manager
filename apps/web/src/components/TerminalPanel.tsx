import { useEffect, useRef, useState } from "react";
import type { PipelineStage } from "@pm/shared";
import { api } from "../api.js";

const STAGES: Array<{ key: PipelineStage; label: string }> = [
  { key: "plan", label: "Plan" }, { key: "implement", label: "Implement" }, { key: "review", label: "Review" },
];
// Client-side cap on top of the server's own per-stage cap (see queue.ts's OUTPUT_CAP) -- keeps
// a very long-running stage from growing this view's DOM/state without bound while it's open.
const MAX_CLIENT_CHARS = 200_000;

type StageContent = Record<PipelineStage, string>;
const empty: StageContent = { plan: "", implement: "", review: "" };

// A collapsed-by-default, bounded-height raw CLI transcript for one queue item -- nested inside
// QueueItem's own toggle so opening it never grows the surrounding page; it scrolls internally
// instead. Fetches each stage's persisted transcript once on open, then tails live chunks
// forwarded over the websocket (see App.tsx's "job.output" CustomEvent) for whichever stage is
// currently running.
export function TerminalPanel({ promptId, defaultStage = "implement", onError }: { promptId: string; defaultStage?: PipelineStage; onError: (message: string) => void }) {
  const [stage, setStage] = useState<PipelineStage>(defaultStage);
  const [content, setContent] = useState<StageContent>(empty);
  const [truncated, setTruncated] = useState<Record<PipelineStage, boolean>>({ plan: false, implement: false, review: false });
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.pipelineOutput(promptId).then((data) => {
      if (cancelled) return;
      setContent({ plan: data.plan.content, implement: data.implement.content, review: data.review.content });
      setTruncated({ plan: data.plan.truncated, implement: data.implement.truncated, review: data.review.truncated });
    }).catch((error) => onError((error as Error).message));
    const listener = (raw: Event) => {
      const detail = (raw as CustomEvent<{ promptId: string; stage: PipelineStage; chunk: string }>).detail;
      if (detail.promptId !== promptId) return;
      setContent((current) => {
        const next = current[detail.stage] + detail.chunk;
        return { ...current, [detail.stage]: next.length > MAX_CLIENT_CHARS ? next.slice(next.length - MAX_CLIENT_CHARS) : next };
      });
    };
    window.addEventListener("job.output", listener);
    return () => { cancelled = true; window.removeEventListener("job.output", listener); };
  }, [promptId, onError]);

  useEffect(() => { if (autoScroll && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [content, stage, autoScroll]);

  return <div className="terminal-panel">
    <div className="terminal-tabs">
      {STAGES.map(({ key, label }) => <button type="button" key={key} className={key === stage ? "active" : ""} onClick={() => setStage(key)}>{label}</button>)}
      <label className="terminal-autoscroll"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)}/> Auto-scroll</label>
    </div>
    {truncated[stage] && <small className="muted">Earlier output was trimmed to keep this view responsive.</small>}
    <pre className="terminal-body" ref={bodyRef}>{content[stage] || "No output yet for this stage."}</pre>
  </div>;
}
