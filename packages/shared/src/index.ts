export type ProjectStatus = "active" | "archived";
export type QueueStatus = "queued" | "planning" | "plan_ready" | "implementing" | "reviewing" | "fixing" | "done" | "review_exhausted" | "failed" | "cancelled";
export type PipelineStage = "plan" | "implement" | "review";
export interface StageConfig { model: string; effort: string }
export interface PipelineDefaults { plan: StageConfig; implement: StageConfig; review: StageConfig }
export type PipelineOverrides = Partial<{ [K in PipelineStage]: Partial<StageConfig> }>;

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
}

export interface UsageGauge {
  used: number;
  limit: number;
  percent: number;
  resetAt: string | null;
  estimated: boolean;
}

export interface UsageSnapshot {
  claude: UsageGauge;
  chatgpt: UsageGauge;
  recommendation: string;
}

export type RealtimeEvent =
  | { type: "sync.updated"; projectId: string }
  | { type: "queue.updated"; projectId: string }
  | { type: "job.progress"; projectId: string; promptId: string; status: QueueStatus }
  | { type: "usage.updated" }
  | { type: "pipeline.event"; projectId: string; promptId: string; event: PipelineEvent };
