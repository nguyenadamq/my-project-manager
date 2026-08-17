import type { PipelineDefaults, PipelineOverrides, PipelineStage } from "@pm/shared";
import type { Db } from "../db.js";

export const DEFAULT_PIPELINE: PipelineDefaults = {
  plan: { model: "sonnet", effort: "high" },
  implement: { model: "gpt-5.6-sol", effort: "medium" },
  review: { model: "sonnet", effort: "medium" },
};

export const PIPELINE_MODELS = ["sonnet", "opus", "haiku", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"];
export const PIPELINE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const stages: PipelineStage[] = ["plan", "implement", "review"];

function parse(value: string | null | undefined): PipelineOverrides {
  if (!value) return {};
  try { return JSON.parse(value) as PipelineOverrides; } catch { throw new Error("Stored pipeline settings are invalid JSON"); }
}

function merge(base: PipelineDefaults, ...layers: PipelineOverrides[]): PipelineDefaults {
  const result = structuredClone(base);
  for (const layer of layers) for (const stage of stages) result[stage] = { ...result[stage], ...(layer[stage] ?? {}) };
  return result;
}

function validate(overrides: PipelineOverrides) {
  for (const stage of stages) {
    const value = overrides[stage];
    if (value?.model && !PIPELINE_MODELS.includes(value.model)) throw new Error(`Unsupported ${stage} model: ${value.model}`);
    if (value?.effort && !PIPELINE_EFFORTS.includes(value.effort)) throw new Error(`Unsupported ${stage} effort: ${value.effort}`);
  }
}

export class SettingsService {
  constructor(private db: Db) {}
  getGlobalDefaults(): PipelineDefaults {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='pipeline.defaults'").get() as { value: string } | undefined;
    return merge(DEFAULT_PIPELINE, parse(row?.value));
  }
  setGlobalDefaults(patch: PipelineOverrides): PipelineDefaults {
    validate(patch);
    const next = merge(this.getGlobalDefaults(), patch);
    this.db.prepare("INSERT INTO settings(key,value) VALUES('pipeline.defaults',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
    return next;
  }
  resolve(projectJson?: string | null, runJson?: string | null): PipelineDefaults {
    const project = parse(projectJson), run = parse(runJson); validate(project); validate(run);
    return merge(this.getGlobalDefaults(), project, run);
  }
  validate(overrides: PipelineOverrides) { validate(overrides); }
}
