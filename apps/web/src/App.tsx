import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PIPELINE_EFFORTS, PIPELINE_MODELS, type DispatchMode, type PipelineEvent, type PipelineMode, type PipelineOverrides, type PipelineStage, type Project, type UsageGauge, type UsageSnapshot } from "@pm/shared";
import { api, getToken, setToken } from "./api.js";
import { QueueItem, labels as queueLabels } from "./components/QueueItem.js";
import { PipelineSettings, ProjectPipelineSettings } from "./components/PipelineSettings.js";
import { FolderPicker } from "./components/FolderPicker.js";

const stages: PipelineStage[] = ["plan", "implement", "review"];
const relative = (value: string | null | undefined) => value ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round((Date.parse(value) - Date.now()) / 60_000), "minute") : "never";

function Meter({ label, gauge, tone }: { label: string; gauge: UsageGauge; tone: string }) {
  const sourceLabel = gauge.source === "live" ? "live" : gauge.source === "estimated" ? "estimate" : "not connected";
  return <article className="meter-card"><div className="meter-head"><span>{label}</span><strong>{gauge.percent}%</strong></div><div className="meter-track"><div style={{ width: `${gauge.percent}%`, background: tone }}/></div><small>{sourceLabel}{gauge.resetAt && ` · resets ${relative(gauge.resetAt)}`}</small></article>;
}

function ProjectDetail({ id, close }: { id: string; close: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<PipelineMode>("full");
  const [dispatch, setDispatch] = useState<DispatchMode>("queued");
  const [overrides, setOverrides] = useState<PipelineOverrides>({});
  const [useOverrides, setUseOverrides] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [error, setError] = useState("");
  const reportError = useCallback((message: string) => setError(message), []);
  const load = useCallback(() => { void api.project(id).then(setProject).catch((cause) => setError(cause.message)); }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as { type: string; event?: PipelineEvent };
        if (event.type === "pipeline.event" && event.event) window.dispatchEvent(new CustomEvent("pipeline-event", { detail: event.event }));
      } catch { /* reload remains the compatibility baseline */ }
      load();
    };
    return () => socket.close();
  }, [load]);
  const addPrompt = async (event: FormEvent) => {
    event.preventDefault(); if (!prompt.trim()) return;
    try { await api.addPrompt(id, prompt, useOverrides ? overrides : undefined, mode, dispatch); setPrompt(""); setMode("full"); setOverrides({}); setUseOverrides(false); load(); } catch (cause) { setError((cause as Error).message); }
  };
  const setOverride = (stage: PipelineStage, field: "model" | "effort", value: string) => setOverrides((current) => ({ ...current, [stage]: { ...current[stage], [field]: value || undefined } }));
  // Every mutating action here goes through this, not a bare `.then(load)` -- an unhandled
  // rejection (e.g. Refresh's summary sync throwing) previously failed completely silently,
  // the same class of bug the home-page "Check usage now"/"Start" actions had.
  const action = async (work: () => Promise<unknown>) => { try { await work(); load(); } catch (cause) { setError((cause as Error).message); } };
  if (!project) return <main><button className="back" onClick={close}>← Projects</button><p>{error || "Loading project…"}</p></main>;
  return <main className="detail">
    <button className="back" onClick={close}>← Projects</button>
    <header className="project-hero"><div><span className="eyebrow">Active project</span><h1>{project.name}</h1><code>{project.path}</code></div><div className="project-actions"><button className="ghost" onClick={() => setShowProjectSettings(true)}>Pipeline overrides</button><button onClick={() => void action(() => api.refresh(id))}>Refresh</button></div></header>
    <section className="latest"><span>Latest checkpoint</span><h2>{project.latestFeatureMd || "Initial summary is being prepared."}</h2><small>Last synced {relative(project.lastSyncedAt)}</small></section>
    <div className="detail-grid">
      <section className="panel"><div className="section-head"><div><span className="eyebrow">Repository</span><h2>Feature map</h2></div><span className="count">{project.features?.length ?? 0}</span></div>{project.features?.length ? project.features.map((feature) => <article className="feature" key={feature.id}><span className={`dot ${feature.status}`}/><div><strong>{feature.title}</strong><p>{feature.description}</p></div></article>) : <p className="muted">Features will appear after the first sync.</p>}</section>
      <section className="panel"><div className="section-head"><div><span className="eyebrow">Supervised agent work</span><h2>Prompt queue</h2></div><span className="count">{project.queue?.filter((item) => item.status === "queued").length ?? 0}</span></div>
        <form className="prompt-form" onSubmit={addPrompt}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the next change…"/>
          <fieldset className="mode-select"><legend>Pipeline mode</legend>
            <label><input type="radio" name="mode" checked={mode === "full"} onChange={() => setMode("full")}/> Plan → Implement → Review <small>Claude drafts a plan you approve, Codex implements it, Claude reviews the diff independently.</small></label>
            <label><input type="radio" name="mode" checked={mode === "implement_only"} onChange={() => setMode("implement_only")}/> Implement only <small>Skips the plan approval checkpoint and the independent review — Codex acts on your prompt directly in the isolated worktree.</small></label>
          </fieldset>
          <fieldset className="mode-select"><legend>When to run</legend>
            <label><input type="radio" name="dispatch" checked={dispatch === "queued"} onChange={() => setDispatch("queued")}/> Queue it <small>Waits its turn. Start it yourself, or let auto-dispatch pick it up across projects by priority as soon as the agents have usage headroom.</small></label>
            <label><input type="radio" name="dispatch" checked={dispatch === "instant"} onChange={() => setDispatch("instant")}/> Run instantly <small>Starts the moment you add it — same isolated worktree, it just doesn't wait to be chosen.</small></label>
          </fieldset>
          <details open={useOverrides} onToggle={(event) => setUseOverrides((event.currentTarget as HTMLDetailsElement).open)}><summary>Model overrides (optional)</summary><div className="override-grid">{(mode === "implement_only" ? (["implement"] as const) : stages).map((stage) => <fieldset key={stage}><legend>{stage}</legend><label>Model<select value={overrides[stage]?.model ?? ""} onChange={(event) => setOverride(stage, "model", event.target.value)}><option value="">Use default</option>{PIPELINE_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}</select></label><label>Effort<select value={overrides[stage]?.effort ?? ""} onChange={(event) => setOverride(stage, "effort", event.target.value)}><option value="">Use default</option>{PIPELINE_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label></fieldset>)}</div></details><button>{dispatch === "instant" ? "Add & run now" : "Add to queue"}</button></form>
        <div className="queue">{project.queue?.map((item) => <QueueItem key={item.id} item={item} reload={load} onError={reportError}/>)}</div>
      </section>
    </div>{showProjectSettings && <ProjectPipelineSettings projectId={id} initial={project.pipelineOverrides} close={() => setShowProjectSettings(false)} saved={load} onError={reportError}/>} {error && <div className="toast" onClick={() => setError("")}>{error}</div>}
  </main>;
}

export function App() {
  const [tokenReady, setTokenReady] = useState(Boolean(getToken())); const [tokenInput, setTokenInput] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null); const [showAdd, setShowAdd] = useState(false); const [showSettings, setShowSettings] = useState(false); const [error, setError] = useState(""); const [checkingUsage, setCheckingUsage] = useState(false);
  const reportError = useCallback((message: string) => setError(message), []);
  const load = useCallback(async () => { try { const [projectList, snapshot] = await Promise.all([api.projects(), api.usage()]); setProjects(projectList); setUsage(snapshot); setError(""); } catch (cause) { setError((cause as Error).message); } }, []);
  // A scrape can take anywhere from a couple seconds to tens of seconds (opening real pages
  // over CDP); the button needs to visibly say so and, critically, actually surface a failure
  // -- the previous version had neither, so a slow or failed check looked identical to nothing
  // having happened at all.
  const checkUsageNow = async () => { setCheckingUsage(true); try { setUsage(await api.scrapeUsageNow()); setError(""); } catch (cause) { setError((cause as Error).message); } finally { setCheckingUsage(false); } };
  const action = async (work: () => Promise<unknown>) => { try { await work(); await load(); } catch (cause) { setError((cause as Error).message); } };
  useEffect(() => { if (tokenReady) void load(); }, [tokenReady, load]);
  if (!tokenReady) return <div className="login"><div className="brand-mark">PM</div><span className="eyebrow">Private workspace</span><h1>Your projects,<br/>moving forward.</h1><p>Enter the access token configured on your host machine.</p><form onSubmit={(event) => { event.preventDefault(); setToken(tokenInput); setTokenReady(true); }}><input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="Access token" autoFocus/><button>Unlock workspace</button></form></div>;
  if (selected) return <ProjectDetail id={selected} close={() => { setSelected(null); void load(); }}/>;
  return <main>
    <nav><div className="brand"><div className="brand-mark">PM</div><div><strong>Project Manager</strong><small>Local command center</small></div></div><div className="nav-actions"><button className="ghost" onClick={() => setShowSettings(true)}>Pipeline settings</button><button className="ghost" onClick={() => { localStorage.clear(); location.reload(); }}>Lock</button></div></nav>
    <header className="dashboard-head"><div><span className="eyebrow">Workspace overview</span><h1>Keep the work<br/><em>in motion.</em></h1></div><button className="primary" onClick={() => setShowAdd(true)}>+ Add project</button></header>
    {usage && <section className="usage-grid">
      <Meter label="Claude · session" gauge={usage.claudeSession} tone="#ef7d50"/>
      <Meter label="Claude · weekly" gauge={usage.claudeWeekly} tone="#ef7d50"/>
      <Meter label="Codex · 5h" gauge={usage.codexFiveHour} tone="#9bc9b7"/>
      <Meter label="Codex · weekly" gauge={usage.codexWeekly} tone="#9bc9b7"/>
      <article className="recommendation"><span>Routing note</span><p>{usage.recommendation}</p><div className="row"><button className="link" disabled={checkingUsage} onClick={() => void checkUsageNow()}>{checkingUsage ? "Checking…" : "Check usage now"}</button><button className="link" onClick={() => void action(() => api.logChatGpt())}>Log ChatGPT message +</button></div></article>
    </section>}
    <section className="projects"><div className="section-head"><div><span className="eyebrow">Registered repositories</span><h2>Working projects</h2></div><span className="count">{projects.length}</span></div><div className="project-grid">{projects.map((project, index) => <article className={`project-card ${project.needsAttentionCount ? "attention" : ""}`} key={project.id} onClick={() => setSelected(project.id)} role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setSelected(project.id)}>
      <div className="row card-top"><span className="index">{String(index + 1).padStart(2, "0")}</span><div className="priority-stepper" onClick={(event) => event.stopPropagation()}><button className="ghost" aria-label="Lower priority" onClick={() => void action(() => api.setPriority(project.id, project.priority - 1))}>−</button><span title="Priority — higher runs first when auto-dispatch has a choice">{project.priority}</span><button className="ghost" aria-label="Raise priority" onClick={() => void action(() => api.setPriority(project.id, project.priority + 1))}>+</button></div></div>
      {Boolean(project.needsAttentionCount) && <span className="attention-badge">{project.needsAttentionCount} need{project.needsAttentionCount === 1 ? "s" : ""} attention</span>}<div className="project-title"><h3>{project.name}</h3><span className={`status ${project.lastSyncedAt ? "done" : "queued"}`}>{project.lastSyncedAt ? "up to date" : "sync pending"}</span></div><p>{project.latestFeatureMd || "Ready for the initial repository scan."}</p>
      {Boolean(project.queue?.length) && <div className="card-queue" onClick={(event) => event.stopPropagation()}>
        {project.queue!.slice(0, 3).map((item) => <div className="card-queue-item" key={item.id}>
          <span className={`status ${item.status}`}>{queueLabels[item.status]}</span>
          <span className="card-queue-text">{item.text}</span>
          {item.status === "queued" && <button className="ghost tiny" onClick={() => void action(() => api.pushPrompt(item.id))}>Start</button>}
        </div>)}
        {project.queue!.length > 3 && <small>+{project.queue!.length - 3} more — open the project to see all</small>}
      </div>}
      <footer><span>Synced {relative(project.lastSyncedAt)}</span><b>↗</b></footer></article>)}</div>{!projects.length && <div className="empty"><strong>No projects registered yet.</strong><p>Add a local Git repository to start building its feature map.</p></div>}</section>
    {showAdd && <FolderPicker close={() => setShowAdd(false)} added={() => void load()} onError={reportError}/>}
    {showSettings && <PipelineSettings close={() => setShowSettings(false)} onError={reportError}/>} {error && <div className="toast" onClick={() => setError("")}>{error}</div>}
  </main>;
}
