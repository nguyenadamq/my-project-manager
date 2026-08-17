import { useEffect, useState, type FormEvent } from "react";
import type { PipelineDefaults, PipelineOverrides, PipelineStage } from "@pm/shared";
import { api } from "../api.js";

const stages: PipelineStage[] = ["plan", "implement", "review"];

export function PipelineSettings({ close, onError }: { close: () => void; onError: (message: string) => void }) {
  const [settings, setSettings] = useState<PipelineDefaults | null>(null);
  useEffect(() => { void api.getPipelineSettings().then(setSettings).catch((error) => onError(error.message)); }, [onError]);
  const save = async (event: FormEvent) => { event.preventDefault(); if (!settings) return; try { await api.setPipelineSettings(settings); close(); } catch (error) { onError((error as Error).message); } };
  return <div className="modal-backdrop" onClick={close}><form className="modal settings-modal" onSubmit={save} onClick={(event) => event.stopPropagation()}><span className="eyebrow">Pipeline defaults</span><h2>Plan → Implement → Review</h2><p className="muted">Runs snapshot these choices when planning begins.</p>{settings ? stages.map((stage) => <fieldset key={stage}><legend>{stage}</legend><label>Model<input value={settings[stage].model} onChange={(event) => setSettings({ ...settings, [stage]: { ...settings[stage], model: event.target.value } })}/></label><label>Effort<input value={settings[stage].effort} onChange={(event) => setSettings({ ...settings, [stage]: { ...settings[stage], effort: event.target.value } })}/></label></fieldset>) : <p>Loading settings…</p>}<div className="row"><button disabled={!settings}>Save defaults</button><button type="button" className="ghost" onClick={close}>Cancel</button></div></form></div>;
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
  return <div className="modal-backdrop" onClick={close}><form className="modal settings-modal" onSubmit={save} onClick={(event) => event.stopPropagation()}><span className="eyebrow">Project overrides</span><h2>Plan → Implement → Review</h2><p className="muted">Leave a field blank to inherit the global default. Individual runs can override these choices again.</p>{stages.map((stage) => <fieldset key={stage}><legend>{stage}</legend><label>Model<input placeholder="Use global default" value={settings[stage]?.model ?? ""} onChange={(event) => setField(stage, "model", event.target.value)}/></label><label>Effort<input placeholder="Use global default" value={settings[stage]?.effort ?? ""} onChange={(event) => setField(stage, "effort", event.target.value)}/></label></fieldset>)}<div className="row"><button>Save overrides</button><button type="button" className="ghost" onClick={() => void clear()}>Use all defaults</button><button type="button" className="ghost" onClick={close}>Cancel</button></div></form></div>;
}
