import type { Project, QueuedPrompt, UsageSnapshot } from "@pm/shared";

const tokenKey = "pm-auth-token";
export const getToken = () => localStorage.getItem(tokenKey) ?? "";
export const setToken = (token: string) => localStorage.setItem(tokenKey, token);

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}`, ...init.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? `Request failed (${response.status})`); }
  return response.status === 204 ? undefined as T : response.json();
}

export const api = {
  projects: () => request<Project[]>("/api/projects"),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  addProject: (path: string, name?: string) => request<Project>("/api/projects", { method: "POST", body: JSON.stringify({ path, name }) }),
  removeProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
  refresh: (id: string) => request(`/api/projects/${id}/refresh`, { method: "POST" }),
  addPrompt: (id: string, text: string) => request<QueuedPrompt>(`/api/projects/${id}/queue`, { method: "POST", body: JSON.stringify({ text }) }),
  patchPrompt: (id: string, patch: object) => request<QueuedPrompt>(`/api/queue/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  pushPrompt: (id: string) => request(`/api/queue/${id}/push`, { method: "POST" }),
  usage: () => request<UsageSnapshot>("/api/usage"),
  logChatGpt: () => request("/api/usage/chatgpt/log", { method: "POST", body: "{}" }),
};
