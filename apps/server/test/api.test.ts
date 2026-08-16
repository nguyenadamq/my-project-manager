import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import type { Config } from "../src/config.js";
import type { PromptRunner } from "../src/services/queue.js";

let root: string; let repo: string;
const runner: PromptRunner = { run: async () => ({ branch: "pm/fake", summary: "verified" }) };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-api-")); repo = path.join(root, "repo"); fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Fixture\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const config = (): Config => ({ host: "127.0.0.1", port: 0, databasePath: path.join(root, "test.db"), authToken: "secret", allowedRoots: [root], concurrency: 1, syncDebounceMs: 0, chatgptWeeklyLimit: 100, chatgptResetDay: 1, claudeFiveHourLimit: 1000 });

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
    const queued = await app.inject({ method: "POST", url: `/api/projects/${project.id}/queue`, headers: auth, payload: { text: "Improve docs" } });
    expect(queued.statusCode).toBe(201); expect(queued.json().position).toBe(1);
    expect(fs.readFileSync(path.join(repo, ".git", "hooks", "post-commit"), "utf8")).toContain("my-project-manager-trigger");
    await app.close();
  });
  it("rejects repository paths outside the allow-list", async () => {
    const cfg = config(); cfg.allowedRoots = [path.join(root, "elsewhere")];
    const app = await buildApp(cfg, { db: createDatabase(path.join(root, "c.db")), runner, startWatcher: false });
    const response = await app.inject({ method: "POST", url: "/api/projects", headers: { authorization: "Bearer secret" }, payload: { path: repo } });
    expect(response.statusCode).toBe(400); expect(response.json().error).toContain("outside"); await app.close();
  });
});
