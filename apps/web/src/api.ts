import type { AutoDispatchSettings, BrowseResult, DispatchMode, PipelineDefaults, PipelineEvent, PipelineMode, PipelineOverrides, Project, QueuedPrompt, UsageSnapshot } from "@pm/shared";

const tokenKey = "pm-auth-token";
export const getToken = () => localStorage.getItem(tokenKey) ?? "";
export const setToken = (token: string) => localStorage.setItem(tokenKey, token);

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  // Content-Type is only set when there's actually a body to describe -- Fastify's default
  // JSON parser rejects a request with Content-Type: application/json and an empty body (400,
  // "Body cannot be empty..."), and several no-payload actions (push, approve-plan, refresh,
  // scrape-now) send exactly that if this header is forced on unconditionally.
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? `Request failed (${response.status})`); }
  return response.status === 204 ? undefined as T : response.json();
}

export const api = {
  projects: () => request<Project[]>("/api/projects"),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  browse: (path?: string) => request<BrowseResult>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  addProject: (path: string, name?: string) => request<Project>("/api/projects", { method: "POST", body: JSON.stringify({ path, name }) }),
  removeProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
  refresh: (id: string) => request(`/api/projects/${id}/refresh`, { method: "POST" }),
  addPrompt: (id: string, text: string, overrides?: PipelineOverrides, mode?: PipelineMode, dispatch?: DispatchMode) => request<QueuedPrompt>(`/api/projects/${id}/queue`, { method: "POST", body: JSON.stringify({ text, overrides, mode, dispatch }) }),
  patchPrompt: (id: string, patch: object) => request<QueuedPrompt>(`/api/queue/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  pushPrompt: (id: string) => request(`/api/queue/${id}/push`, { method: "POST" }),
  editPlan: (id: string, text: string) => request<QueuedPrompt>(`/api/queue/${id}/plan`, { method: "PATCH", body: JSON.stringify({ text }) }),
  approvePlan: (id: string) => request(`/api/queue/${id}/approve-plan`, { method: "POST" }),
  retryFailed: (id: string) => request(`/api/queue/${id}/retry`, { method: "POST" }),
  requestFixes: (id: string, instructions?: string) => request(`/api/queue/${id}/request-fixes`, { method: "POST", body: JSON.stringify({ instructions }) }),
  pipelineEvents: (id: string) => request<PipelineEvent[]>(`/api/queue/${id}/events`),
  getPipelineSettings: () => request<PipelineDefaults>("/api/settings/pipeline"),
  setPipelineSettings: (settings: PipelineOverrides) => request<PipelineDefaults>("/api/settings/pipeline", { method: "PUT", body: JSON.stringify(settings) }),
  patchProject: (id: string, pipelineOverrides: PipelineOverrides | null) => request<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ pipelineOverrides }) }),
  setPriority: (id: string, priority: number) => request<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ priority }) }),
  usage: () => request<UsageSnapshot>("/api/usage"),
  logChatGpt: () => request("/api/usage/chatgpt/log", { method: "POST", body: "{}" }),
  scrapeUsageNow: () => request<UsageSnapshot>("/api/usage/scrape-now", { method: "POST" }),
  getAutoDispatch: () => request<AutoDispatchSettings>("/api/settings/auto-dispatch"),
  setAutoDispatch: (patch: Partial<AutoDispatchSettings>) => request<AutoDispatchSettings>("/api/settings/auto-dispatch", { method: "PUT", body: JSON.stringify(patch) }),
};
