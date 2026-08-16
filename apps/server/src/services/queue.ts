import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type { QueuedPrompt } from "@pm/shared";
import type { Db } from "../db.js";
import type { EventHub } from "../events.js";
import { git, writeTrigger } from "./git.js";

const exec = promisify(execFile);
const selectQueue = `SELECT id,project_id projectId,text,position,status,created_at createdAt,started_at startedAt,finished_at finishedAt,result_branch resultBranch,result_diff_summary resultDiffSummary,error_message errorMessage FROM queued_prompts`;

export interface PromptRunner { run(repo: string, promptId: string, prompt: string): Promise<{ branch: string; summary: string }>; }

export class ClaudePromptRunner implements PromptRunner {
  async run(repo: string, promptId: string, prompt: string) {
    const branch = `pm/${promptId}`;
    const worktree = path.join(repo, ".pm", "worktrees", promptId);
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    await exec("git", ["-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"]);
    try {
      await exec("claude", ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits"], { cwd: worktree, maxBuffer: 8_000_000 });
      const status = await git(worktree, ["status", "--porcelain"]);
      if (status) {
        await git(worktree, ["add", "-A"]);
        await git(worktree, ["commit", "-m", `pm: execute prompt ${promptId}`]);
      }
      const summary = await git(worktree, ["diff", "--stat", "HEAD~1", "HEAD"]).catch(() => "No file changes were produced.");
      return { branch, summary };
    } catch (error) {
      throw new Error(`Claude Code job failed; worktree retained at ${worktree}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class QueueService {
  private runningProjects = new Set<string>();
  private runningGlobal = 0;
  constructor(private db: Db, private events: EventHub, private runner: PromptRunner, private concurrency = 1) {}

  list(projectId: string): QueuedPrompt[] { return this.db.prepare(`${selectQueue} WHERE project_id=? ORDER BY position,created_at`).all(projectId) as unknown as QueuedPrompt[]; }
  add(projectId: string, text: string): QueuedPrompt {
    if (!text.trim()) throw new Error("Prompt text is required");
    const exists = this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId);
    if (!exists) throw new Error("Project not found");
    const position = ((this.db.prepare("SELECT COALESCE(MAX(position),0) value FROM queued_prompts WHERE project_id=?").get(projectId) as any).value as number) + 1;
    const id = nanoid(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO queued_prompts(id,project_id,text,position,status,created_at) VALUES(?,?,?,?, 'queued',?)").run(id, projectId, text.trim(), position, now);
    this.events.emit({ type: "queue.updated", projectId });
    return this.db.prepare(`${selectQueue} WHERE id=?`).get(id) as unknown as QueuedPrompt;
  }
  update(id: string, patch: { text?: string; position?: number; status?: "cancelled" }): QueuedPrompt {
    const current = this.db.prepare(`${selectQueue} WHERE id=?`).get(id) as QueuedPrompt | undefined;
    if (!current) throw new Error("Prompt not found");
    if (current.status === "running") throw new Error("A running prompt cannot be edited");
    const count = Number((this.db.prepare("SELECT COUNT(*) value FROM queued_prompts WHERE project_id=?").get(current.projectId) as any).value);
    const position = patch.position === undefined ? current.position : Math.max(1, Math.min(count, patch.position));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (position < current.position) this.db.prepare("UPDATE queued_prompts SET position=position+1 WHERE project_id=? AND position>=? AND position<?").run(current.projectId, position, current.position);
      if (position > current.position) this.db.prepare("UPDATE queued_prompts SET position=position-1 WHERE project_id=? AND position>? AND position<=?").run(current.projectId, current.position, position);
      this.db.prepare("UPDATE queued_prompts SET text=?,position=?,status=? WHERE id=?").run(patch.text?.trim() || current.text, position, patch.status ?? current.status, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.events.emit({ type: "queue.updated", projectId: current.projectId });
    return this.db.prepare(`${selectQueue} WHERE id=?`).get(id) as unknown as QueuedPrompt;
  }
  async push(id: string): Promise<void> {
    const item = this.db.prepare(`${selectQueue} WHERE id=?`).get(id) as QueuedPrompt | undefined;
    if (!item || item.status !== "queued") throw new Error("Queued prompt not found");
    if (this.runningProjects.has(item.projectId) || this.runningGlobal >= this.concurrency) throw new Error("Worker is at its concurrency limit");
    const project = this.db.prepare("SELECT path FROM projects WHERE id=?").get(item.projectId) as { path: string } | undefined;
    if (!project) throw new Error("Project not found");
    this.runningProjects.add(item.projectId); this.runningGlobal++;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE queued_prompts SET status='running',started_at=? WHERE id=?").run(now, id);
    this.events.emit({ type: "job.progress", projectId: item.projectId, promptId: id, status: "running" });
    try {
      const result = await this.runner.run(project.path, id, item.text);
      this.db.prepare("UPDATE queued_prompts SET status='done',finished_at=?,result_branch=?,result_diff_summary=? WHERE id=?").run(new Date().toISOString(), result.branch, result.summary, id);
      this.db.prepare("INSERT INTO usage_events(id,tool,kind,timestamp,note) VALUES(?, 'claude_code','job',?,?)").run(nanoid(), new Date().toISOString(), id);
      await writeTrigger(project.path);
      this.events.emit({ type: "job.progress", projectId: item.projectId, promptId: id, status: "done" });
    } catch (error) {
      this.db.prepare("UPDATE queued_prompts SET status='failed',finished_at=?,error_message=? WHERE id=?").run(new Date().toISOString(), error instanceof Error ? error.message : String(error), id);
      this.events.emit({ type: "job.progress", projectId: item.projectId, promptId: id, status: "failed" });
    } finally {
      this.runningProjects.delete(item.projectId); this.runningGlobal--;
      this.events.emit({ type: "queue.updated", projectId: item.projectId });
    }
  }
}
