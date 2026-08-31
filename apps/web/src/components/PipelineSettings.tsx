import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_PIPELINE, PIPELINE_EFFORTS, PIPELINE_MODELS, type AutoDispatchSettings, type PipelineDefaults, type PipelineOverrides, type PipelineStage } from "@pm/shared";
import { api } from "../api.js";

const stages: PipelineStage[] = ["plan", "implement", "review"];

function ModelSelect({ stage, value, onChange }: { stage: PipelineStage; value: string; onChange: (value: string) => void }) {
  const recommended = DEFAULT_PIPELINE[stage].model;
  return <select value={value} onChange={(event) => onChange(event.target.value)}>
    {PIPELINE_MODELS.map((model) => <option key={model} value={model}>{model}{model === recommended ? " (recommended)" : ""}</option>)}
  </select>;
}

function EffortSelect({ stage, value, onChange }: { stage: PipelineStage; value: string; onChange: (value: string) => void }) {
  const recommended = DEFAULT_PIPELINE[stage].effort;
  return <select value={value} onChange={(event) => onChange(event.target.value)}>
    {PIPELINE_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}{effort === recommended ? " (recommended)" : ""}</option>)}
  </select>;
}

function AutoDispatchSection() {
  const [settings, setSettings] = useState<AutoDispatchSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void api.getAutoDispatch().then(setSettings).catch((cause) => setError(cause.message)); }, []);
  const update = (patch: Partial<AutoDispatchSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next); // optimistic; reconciled below
    void api.setAutoDispatch(patch).then(setSettings).catch((cause) => { setError(cause.message); setSettings(settings); });
  };
  if (!settings) return <fieldset><legend>Auto-dispatch</legend><p className="muted">{error || "Loading…"}</p></fieldset>;
  return <fieldset className="auto-dispatch">
    <legend>Auto-dispatch</legend>
    <label className="row toggle-row"><input type="checkbox" checked={settings.enabled} onChange={(event) => update({ enabled: event.target.checked })}/> Automatically start the next queued or approved-plan item — across every project, highest priority first — whenever there's usage headroom. Full-mode plans are approved and implemented unattended, not just implement-only ones.</label>
    <label>Don't start work needing a pool at or above<input type="number" min={1} max={100} value={settings.maxPercentUsed} onChange={(event) => update({ maxPercentUsed: Number(event.target.value) })}/>% used</label>
    {error && <small className="error">{error}</small>}
  </fieldset>;
}

export function PipelineSettings({ close, onError }: { close: () => void; onError: (message: string) => void }) {
  const [settings, setSettings] = useState<PipelineDefaults | null>(null);
  useEffect(() => { void api.getPipelineSettings().then(setSettings).catch((error) => onError(error.message)); }, [onError]);
  const save = async (event: FormEvent) => { event.preventDefault(); if (!settings) return; try { await api.setPipelineSettings(settings); close(); } catch (error) { onError((error as Error).message); } };
  return <div className="modal-backdrop" onClick={close}><form className="modal settings-modal" onSubmit={save} onClick={(event) => event.stopPropagation()}><span className="eyebrow">Pipeline defaults</span><h2>Plan → Implement → Review</h2><p className="muted">Runs snapshot these choices when planning begins. Recommendations assume the same Claude Code + Codex CLI subscription setup this app uses.</p>{settings ? stages.map((stage) => <fieldset key={stage}><legend>{stage}</legend><label>Model<ModelSelect stage={stage} value={settings[stage].model} onChange={(value) => setSettings({ ...settings, [stage]: { ...settings[stage], model: value } })}/></label><label>Effort<EffortSelect stage={stage} value={settings[stage].effort} onChange={(value) => setSettings({ ...settings, [stage]: { ...settings[stage], effort: value } })}/></label></fieldset>) : <p>Loading settings…</p>}<AutoDispatchSection/><div className="row"><button disabled={!settings}>Save defaults</button><button type="button" className="ghost" onClick={close}>Cancel</button></div></form></div>;
}

export function ProjectPipelineSettings({ projectId, initial, close, saved, onError }: { projectId: string; initial: PipelineOverrides | null | undefined; close: () => void; saved: () => void; onError: (message: string) => void }) {
  const [settings, setSettings] = useState<PipelineOverrides>(initial ?? {});
  const setField = (stage: PipelineStage, field: "model" | "effort", value: string) => setSettings((current) => ({ ...current, [stage]: { ...current[stage], [field]: value || undefined } }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try { await api.patchProject(projectId, settings); saved(); close(); } catch (error) { onError((error as Error).message); }
  };
  const clear = async () => {
    try { await api.patchProject(projectId, null); saved(); close(); } catch (error) { onError((error as Error).message); }
  };
  return <div className="modal-backdrop" onClick={close}><form className="modal settings-modal" onSubmit={save} onClick={(event) => event.stopPropagation()}><span className="eyebrow">Project overrides</span><h2>Plan → Implement → Review</h2><p className="muted">Leave a field on "Use global default" to inherit it. Individual runs can override these choices again.</p>{stages.map((stage) => <fieldset key={stage}><legend>{stage}</legend><label>Model<select value={settings[stage]?.model ?? ""} onChange={(event) => setField(stage, "model", event.target.value)}><option value="">Use global default</option>{PIPELINE_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}</select></label><label>Effort<select value={settings[stage]?.effort ?? ""} onChange={(event) => setField(stage, "effort", event.target.value)}><option value="">Use global default</option>{PIPELINE_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label></fieldset>)}<div className="row"><button>Save overrides</button><button type="button" className="ghost" onClick={() => void clear()}>Use all defaults</button><button type="button" className="ghost" onClick={close}>Cancel</button></div></form></div>;
}
