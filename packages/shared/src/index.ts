export type ProjectStatus = "active" | "archived";
export type QueueStatus = "queued" | "running" | "done" | "failed" | "cancelled";

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
  | { type: "usage.updated" };
