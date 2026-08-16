import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Project, QueuedPrompt, UsageSnapshot } from "@pm/shared";
import { api, getToken, setToken } from "./api.js";

const relative = (value: string | null | undefined) => value ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round((Date.parse(value) - Date.now()) / 60_000), "minute") : "never";

function Meter({ label, gauge, tone }: { label: string; gauge: UsageSnapshot["claude"]; tone: string }) {
  return <article className="meter-card">
    <div className="meter-head"><span>{label}</span><strong>{gauge.percent}%</strong></div>
    <div className="meter-track"><div style={{ width: `${gauge.percent}%`, background: tone }} /></div>
    <small>{gauge.used.toLocaleString()} / {gauge.limit.toLocaleString()} {gauge.estimated && "· estimate"}</small>
  </article>;
}

function QueueItem({ item, reload }: { item: QueuedPrompt; reload: () => void }) {
  const run = async () => { await api.pushPrompt(item.id); reload(); };
  const cancel = async () => { await api.patchPrompt(item.id, { status: "cancelled" }); reload(); };
  const move = async (change: number) => { await api.patchPrompt(item.id, { position: item.position + change }); reload(); };
  return <div className="queue-item">
    <div><span className={`status ${item.status}`}>{item.status}</span><p>{item.text}</p></div>
    {item.resultDiffSummary && <pre>{item.resultDiffSummary}</pre>}
    {item.errorMessage && <p className="error">{item.errorMessage}</p>}
    <div className="row actions">{item.status === "queued" && <><button onClick={run}>Push through</button><button className="ghost" aria-label="Move up" onClick={() => void move(-1)}>↑</button><button className="ghost" aria-label="Move down" onClick={() => void move(1)}>↓</button><button className="ghost" onClick={cancel}>Cancel</button></>}</div>
  </div>;
}

function ProjectDetail({ id, close }: { id: string; close: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [prompt, setPrompt] = useState(""); const [error, setError] = useState("");
  const load = useCallback(() => { void api.project(id).then(setProject).catch((e) => setError(e.message)); }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);
    socket.onmessage = load; return () => socket.close();
  }, [load]);
  const addPrompt = async (event: FormEvent) => { event.preventDefault(); if (!prompt.trim()) return; try { await api.addPrompt(id, prompt); setPrompt(""); load(); } catch (e) { setError((e as Error).message); } };
  if (!project) return <main><button className="back" onClick={close}>← Projects</button><p>{error || "Loading project…"}</p></main>;
  return <main className="detail">
    <button className="back" onClick={close}>← Projects</button>
    <header className="project-hero"><div><span className="eyebrow">Active project</span><h1>{project.name}</h1><code>{project.path}</code></div><button onClick={() => void api.refresh(id).then(load)}>Refresh</button></header>
    <section className="latest"><span>Latest checkpoint</span><h2>{project.latestFeatureMd || "Initial summary is being prepared."}</h2><small>Last synced {relative(project.lastSyncedAt)}</small></section>
    <div className="detail-grid">
      <section className="panel"><div className="section-head"><div><span className="eyebrow">Repository</span><h2>Feature map</h2></div><span className="count">{project.features?.length ?? 0}</span></div>
        {project.features?.length ? project.features.map((feature) => <article className="feature" key={feature.id}><span className={`dot ${feature.status}`} /><div><strong>{feature.title}</strong><p>{feature.description}</p></div></article>) : <p className="muted">Features will appear after the first sync.</p>}
      </section>
      <section className="panel"><div className="section-head"><div><span className="eyebrow">Agent work</span><h2>Prompt queue</h2></div><span className="count">{project.queue?.filter((q) => q.status === "queued").length ?? 0}</span></div>
        <form className="prompt-form" onSubmit={addPrompt}><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the next change…"/><button>Add to queue</button></form>
        <div className="queue">{project.queue?.map((item) => <QueueItem key={item.id} item={item} reload={load}/>)}</div>
      </section>
    </div>{error && <div className="toast">{error}</div>}
  </main>;
}

export function App() {
  const [tokenReady, setTokenReady] = useState(Boolean(getToken())); const [tokenInput, setTokenInput] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null); const [showAdd, setShowAdd] = useState(false); const [repoPath, setRepoPath] = useState(""); const [error, setError] = useState("");
  const load = useCallback(async () => { try { const [p, u] = await Promise.all([api.projects(), api.usage()]); setProjects(p); setUsage(u); setError(""); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { if (tokenReady) void load(); }, [tokenReady, load]);
  if (!tokenReady) return <div className="login"><div className="brand-mark">PM</div><span className="eyebrow">Private workspace</span><h1>Your projects,<br/>moving forward.</h1><p>Enter the access token configured on your host machine.</p><form onSubmit={(e) => { e.preventDefault(); setToken(tokenInput); setTokenReady(true); }}><input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="Access token" autoFocus/><button>Unlock workspace</button></form></div>;
  if (selected) return <ProjectDetail id={selected} close={() => { setSelected(null); void load(); }}/>;
  const add = async (e: FormEvent) => { e.preventDefault(); try { await api.addProject(repoPath); setRepoPath(""); setShowAdd(false); await load(); } catch (err) { setError((err as Error).message); } };
  return <main>
    <nav><div className="brand"><div className="brand-mark">PM</div><div><strong>Project Manager</strong><small>Local command center</small></div></div><button className="ghost" onClick={() => { localStorage.clear(); location.reload(); }}>Lock</button></nav>
    <header className="dashboard-head"><div><span className="eyebrow">Workspace overview</span><h1>Keep the work<br/><em>in motion.</em></h1></div><button className="primary" onClick={() => setShowAdd(true)}>+ Add project</button></header>
    {usage && <section className="usage-grid"><Meter label="Claude · rolling 5h" gauge={usage.claude} tone="#ef7d50"/><Meter label="ChatGPT · weekly" gauge={usage.chatgpt} tone="#9bc9b7"/><article className="recommendation"><span>Routing note</span><p>{usage.recommendation}</p><button className="link" onClick={() => void api.logChatGpt().then(load)}>Log ChatGPT message +</button></article></section>}
    <section className="projects"><div className="section-head"><div><span className="eyebrow">Registered repositories</span><h2>Working projects</h2></div><span className="count">{projects.length}</span></div>
      <div className="project-grid">{projects.map((project, index) => <button className="project-card" key={project.id} onClick={() => setSelected(project.id)}><span className="index">{String(index + 1).padStart(2, "0")}</span><div className="project-title"><h3>{project.name}</h3><span className={`status ${project.lastSyncedAt ? "done" : "queued"}`}>{project.lastSyncedAt ? "up to date" : "sync pending"}</span></div><p>{project.latestFeatureMd || "Ready for the initial repository scan."}</p><footer><span>Synced {relative(project.lastSyncedAt)}</span><b>↗</b></footer></button>)}</div>
      {!projects.length && <div className="empty"><strong>No projects registered yet.</strong><p>Add a local Git repository to start building its feature map.</p></div>}
    </section>
    {showAdd && <div className="modal-backdrop" onClick={() => setShowAdd(false)}><form className="modal" onSubmit={add} onClick={(e) => e.stopPropagation()}><span className="eyebrow">Register repository</span><h2>Add a working project</h2><label>Absolute path<input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="F:\\code\\my-app" autoFocus/></label><div className="row"><button>Add project</button><button type="button" className="ghost" onClick={() => setShowAdd(false)}>Cancel</button></div></form></div>}
    {error && <div className="toast">{error}</div>}
  </main>;
}
