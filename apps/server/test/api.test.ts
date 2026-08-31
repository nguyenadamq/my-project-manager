import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import type { Config } from "../src/config.js";
import type { PipelineRunner } from "../src/services/pipeline-runner.js";

let root: string; let repo: string;
const runner: PipelineRunner = {
  plan: async () => "# Plan",
  implement: async () => "implemented",
  review: async () => ({ verdict: "CLEAN", notes: "clean" }),
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-api-")); repo = path.join(root, "repo"); fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Fixture\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const config = (): Config => ({ host: "127.0.0.1", port: 0, databasePath: path.join(root, "test.db"), authToken: "secret", allowedRoots: [root], concurrency: 1, syncDebounceMs: 0, chatgptWeeklyLimit: 100, chatgptResetDay: 1, claudeFiveHourLimit: 1000, cliTimeoutMs: 60_000, claudeCliPath: "claude", codexCliPath: "codex", usageScrapeEnabled: false, usageScrapeIntervalMs: 600_000, chromeCdpUrl: "http://127.0.0.1:9222", claudeProjectsPath: path.join(root, "no-claude-projects") });

// The pipeline runs in the background after a 202/201, so tests poll the item's own status
// rather than guessing at a sleep long enough for a worktree add plus two subprocess stubs.
async function waitFor(app: Awaited<ReturnType<typeof buildApp>>, projectId: string, promptId: string, done: (status: string) => boolean, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    const detail = await app.inject({ url: `/api/projects/${projectId}`, headers: { authorization: "Bearer secret" } });
    status = detail.json().queue.find((item: { id: string }) => item.id === promptId)?.status ?? "";
    if (done(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return status;
}

describe("API", () => {
  it("enforces authentication", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "a.db")), runner, startWatcher: false });
    expect((await app.inject({ url: "/api/projects" })).statusCode).toBe(401); await app.close();
  });
  it("registers a repo and queues a prompt", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "b.db")), runner, startWatcher: false });
    const auth = { authorization: "Bearer secret" };
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { path: repo } });
    expect(created.statusCode).toBe(201); const project = created.json();
    const queued = await app.inject({ method: "POST", url: `/api/projects/${project.id}/queue`, headers: auth, payload: { text: "Improve docs", overrides: { implement: { effort: "high" } } } });
    expect(queued.statusCode).toBe(201); expect(queued.json().position).toBe(1); expect(queued.json().runOverrides.implement.effort).toBe("high");
    const detail = await app.inject({ url: `/api/projects/${project.id}`, headers: auth });
    expect(detail.json().queue[0].runOverrides.implement.effort).toBe("high"); expect(detail.json().queue[0].needsAttention).toBe(false);
    expect(fs.readFileSync(path.join(repo, ".git", "hooks", "post-commit"), "utf8")).toContain("my-project-manager-trigger");
    // The dashboard list endpoint carries each project's queue too, not just the single-project
    // detail view -- otherwise "what's queued and why isn't it moving" is invisible without
    // opening every project one at a time.
    const list = await app.inject({ url: "/api/projects", headers: auth });
    expect(list.json()[0].queue[0].text).toBe("Improve docs");
    await app.close();
  });
  it("round-trips global and project pipeline settings", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "settings.db")), runner, startWatcher: false }); const auth = { authorization: "Bearer secret" };
    const changed = await app.inject({ method: "PUT", url: "/api/settings/pipeline", headers: auth, payload: { plan: { effort: "medium" } } });
    expect(changed.statusCode).toBe(200); expect(changed.json().plan).toEqual({ model: "sonnet", effort: "medium" });
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { path: repo } }); const project = created.json();
    const patched = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: auth, payload: { pipelineOverrides: { review: { model: "opus" } } } });
    expect(patched.statusCode).toBe(200); expect(patched.json().pipelineOverrides.review.model).toBe("opus"); await app.close();
  });
  it("rejects plan approval before the approval gate", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "approval.db")), runner, startWatcher: false }); const auth = { authorization: "Bearer secret" };
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { path: repo } }); const project = created.json();
    const queued = await app.inject({ method: "POST", url: `/api/projects/${project.id}/queue`, headers: auth, payload: { text: "Improve docs" } });
    const response = await app.inject({ method: "POST", url: `/api/queue/${queued.json().id}/approve-plan`, headers: auth }); expect(response.statusCode).toBe(400); await app.close();
  });
  // Instant dispatch is the "just go" path: adding the prompt is the only action, no separate
  // push. It still runs the same pipeline in the same isolated worktree -- this asserts it
  // actually reaches a terminal state on its own, not merely that the field round-trips.
  it("starts an instant-dispatch prompt without a separate push", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "instant.db")), runner, startWatcher: false }); const auth = { authorization: "Bearer secret" };
    const project = (await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { path: repo } })).json();
    const queued = await app.inject({ method: "POST", url: `/api/projects/${project.id}/queue`, headers: auth, payload: { text: "Ship it", mode: "implement_only", dispatch: "instant" } });
    expect(queued.statusCode).toBe(201); expect(queued.json().dispatch).toBe("instant");
    const settled = await waitFor(app, project.id, queued.json().id, (status) => status === "done" || status === "failed");
    expect(settled).toBe("done");
    await app.close();
  });

  it("leaves a queued-dispatch prompt waiting until it is pushed", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "queued.db")), runner, startWatcher: false }); const auth = { authorization: "Bearer secret" };
    const project = (await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { path: repo } })).json();
    const queued = await app.inject({ method: "POST", url: `/api/projects/${project.id}/queue`, headers: auth, payload: { text: "Later", mode: "implement_only" } });
    expect(queued.json().dispatch).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const detail = await app.inject({ url: `/api/projects/${project.id}`, headers: auth });
    expect(detail.json().queue[0].status).toBe("queued");
    await app.close();
  });

  it("browses allowed roots so a project can be picked instead of typed", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "browse.db")), runner, startWatcher: false }); const auth = { authorization: "Bearer secret" };
    const roots = await app.inject({ url: "/api/browse", headers: auth });
    expect(roots.statusCode).toBe(200); expect(roots.json().path).toBeNull();
    const listing = await app.inject({ url: `/api/browse?path=${encodeURIComponent(root)}`, headers: auth });
    expect(listing.json().entries.find((entry: { name: string }) => entry.name === "repo")).toMatchObject({ isGitRepo: true, isRegistered: false });
    const outside = await app.inject({ url: `/api/browse?path=${encodeURIComponent(os.tmpdir())}`, headers: auth });
    expect(outside.statusCode).toBe(400);
    await app.close();
  });

  // A client that sets Content-Type: application/json globally (curl -H, a shared fetch
  // wrapper) would otherwise get "Body cannot be empty..." from Fastify's stock parser before
  // routing, on every route that legitimately takes no payload.
  it("accepts a no-payload request that still declares a JSON content type", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "empty-body.db")), runner, startWatcher: false });
    const auth = { authorization: "Bearer secret", "content-type": "application/json" };
    const project = (await app.inject({ method: "POST", url: "/api/projects", headers: { authorization: "Bearer secret" }, payload: { path: repo } })).json();
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/projects", headers: auth })).json()).toHaveLength(0);
    await app.close();
  });

  it("still rejects a malformed JSON body", async () => {
    const app = await buildApp(config(), { db: createDatabase(path.join(root, "bad-body.db")), runner, startWatcher: false });
    const response = await app.inject({ method: "POST", url: "/api/projects", headers: { authorization: "Bearer secret", "content-type": "application/json" }, payload: "{not json" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects repository paths outside the allow-list", async () => {
    const cfg = config(); cfg.allowedRoots = [path.join(root, "elsewhere")];
    const app = await buildApp(cfg, { db: createDatabase(path.join(root, "c.db")), runner, startWatcher: false });
    const response = await app.inject({ method: "POST", url: "/api/projects", headers: { authorization: "Bearer secret" }, payload: { path: repo } });
    expect(response.statusCode).toBe(400); expect(response.json().error).toContain("outside"); await app.close();
  });
});
