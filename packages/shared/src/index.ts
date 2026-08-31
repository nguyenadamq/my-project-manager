export type ProjectStatus = "active" | "archived";
export type QueueStatus = "queued" | "planning" | "plan_ready" | "implementing" | "reviewing" | "fixing" | "done" | "review_exhausted" | "failed" | "cancelled";
export type PipelineStage = "plan" | "implement" | "review";
// "full" is the supervised Plan -> Implement -> Review loop. "implement_only" skips the plan
// draft/approval checkpoint and the independent review entirely: Codex implements the raw
// prompt directly in the isolated worktree and the item goes straight to 'done' or 'failed'.
export type PipelineMode = "full" | "implement_only";
// How a queued prompt gets started. "queued" is the default: it waits in the project's queue
// until a human presses Start or auto-dispatch picks it up when there's usage headroom.
// "instant" starts the moment it's added -- it still runs through the same pipeline, in the
// same isolated worktree, under the same global concurrency slot; it just skips the wait.
export type DispatchMode = "instant" | "queued";
export interface StageConfig { model: string; effort: string }
export interface PipelineDefaults { plan: StageConfig; implement: StageConfig; review: StageConfig }
export type PipelineOverrides = Partial<{ [K in PipelineStage]: Partial<StageConfig> }>;

// Single source of truth for both the server's validation (settings.ts) and the web UI's
// model/effort dropdowns, so a model added here is automatically selectable and automatically
// accepted -- no separate list to keep in sync. DEFAULT_PIPELINE reflects what actually works
// well with a same-machine `claude` + `codex` subscription-CLI setup like this app's own.
export const PIPELINE_MODELS = ["sonnet", "opus", "haiku", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"];
export const PIPELINE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const DEFAULT_PIPELINE: PipelineDefaults = {
  plan: { model: "sonnet", effort: "high" },
  implement: { model: "gpt-5.6-sol", effort: "medium" },
  review: { model: "sonnet", effort: "medium" },
};

export interface Feature {
  id: string;
  projectId: string;
  title: string;
  description: string;
  addedAtSha: string;
  status: "shipped" | "in_progress";
}

export interface QueuedPrompt {
  id: string;
  projectId: string;
  text: string;
  position: number;
  status: QueueStatus;
  mode: PipelineMode;
  dispatch: DispatchMode;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultBranch: string | null;
  resultDiffSummary: string | null;
  errorMessage: string | null;
  needsAttention: boolean;
  worktreePath: string | null;
  baseSha: string | null;
  planText: string | null;
  planOriginalText: string | null;
  planApprovedAt: string | null;
  fixRoundsUsed: number;
  reviewVerdict: "CLEAN" | "NEEDS-FIXES" | null;
  reviewNotes: string | null;
  runOverrides: PipelineOverrides | null;
  planModel: string | null;
  planEffort: string | null;
  implementModel: string | null;
  implementEffort: string | null;
  reviewModel: string | null;
  reviewEffort: string | null;
}

export interface PipelineEvent {
  id: string;
  promptId: string;
  projectId: string;
  stage: PipelineStage | "system";
  kind: "started" | "output" | "completed" | "failed" | "awaiting_approval" | "approved" | "fix_round_started" | "verdict" | "attention" | "cancelled";
  message: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  repoRemote: string | null;
  status: ProjectStatus;
  addedAt: string;
  lastSyncedSha: string | null;
  lastSyncedAt: string | null;
  overallSummaryMd?: string;
  latestFeatureMd?: string;
  features?: Feature[];
  queue?: QueuedPrompt[];
  pipelineOverrides?: PipelineOverrides | null;
  needsAttentionCount?: number;
  priority: number;
}

// "live" is a real number just scraped from the account's own usage page (see
// usage-scraper.ts); "estimated" is computed locally from proxies (local transcript token
// counts, a manual tally) because no live reading is fresh enough; "unknown" means neither
// is available yet.
export type UsageSource = "live" | "estimated" | "unknown";

export interface UsageGauge {
  percent: number; // 0-100, always normalized to "% used" regardless of how the source reports it
  resetAt: string | null;
  source: UsageSource;
  checkedAt: string | null;
}

export interface UsageSnapshot {
  claudeSession: UsageGauge;
  claudeWeekly: UsageGauge;
  codexFiveHour: UsageGauge;
  codexWeekly: UsageGauge;
  recommendation: string;
}

// One directory as seen by the folder picker, always inside an allowed root.
export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  isRegistered: boolean;
}

export interface BrowseResult {
  // null when listing the allowed roots themselves -- i.e. there is nowhere further up to go.
  path: string | null;
  parent: string | null;
  // The folder currently being listed, described the same way its children are, so the picker
  // can tell whether the folder you are standing in is itself a registrable repository.
  current: BrowseEntry | null;
  entries: BrowseEntry[];
}

export interface AutoDispatchSettings {
  enabled: boolean;
  // A candidate is skipped (left for a human to start by hand) while any pool it would use
  // is at or above this percentage, even if other pools have room.
  maxPercentUsed: number;
}

export type RealtimeEvent =
  | { type: "sync.updated"; projectId: string }
  | { type: "queue.updated"; projectId: string }
  | { type: "job.progress"; projectId: string; promptId: string; status: QueueStatus }
  | { type: "usage.updated" }
  | { type: "pipeline.event"; projectId: string; promptId: string; event: PipelineEvent };
