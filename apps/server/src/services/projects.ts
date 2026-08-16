import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Project } from "@pm/shared";
import type { Db } from "../db.js";
import type { Config } from "../config.js";
import { assertGitRepository, getRepoMetadata, installPostCommitHook } from "./git.js";

const mapProject = (row: any): Project => ({
  id: row.id, name: row.name, path: row.path, repoRemote: row.repo_remote, status: row.status,
  addedAt: row.added_at, lastSyncedSha: row.last_synced_sha, lastSyncedAt: row.last_synced_at,
  overallSummaryMd: row.overall_summary_md ?? undefined, latestFeatureMd: row.latest_feature_md ?? undefined,
});

export class ProjectService {
  constructor(private db: Db, private config: Config) {}

  list(): Project[] {
    return (this.db.prepare(`SELECT p.*, s.overall_summary_md, s.latest_feature_md FROM projects p LEFT JOIN feature_summaries s ON s.project_id=p.id ORDER BY p.added_at DESC`).all() as any[]).map(mapProject);
  }

  get(id: string): Project | null {
    const row = this.db.prepare(`SELECT p.*, s.overall_summary_md, s.latest_feature_md FROM projects p LEFT JOIN feature_summaries s ON s.project_id=p.id WHERE p.id=?`).get(id);
    if (!row) return null;
    const project = mapProject(row);
    project.features = this.db.prepare("SELECT id, project_id projectId, title, description, added_at_sha addedAtSha, status FROM features WHERE project_id=? ORDER BY title").all(id) as any;
    project.queue = this.db.prepare("SELECT id, project_id projectId, text, position, status, created_at createdAt, started_at startedAt, finished_at finishedAt, result_branch resultBranch, result_diff_summary resultDiffSummary, error_message errorMessage FROM queued_prompts WHERE project_id=? ORDER BY position, created_at").all(id) as any;
    return project;
  }

  async add(inputPath: string, name?: string): Promise<Project> {
    const requested = path.resolve(inputPath);
    const real = await fs.realpath(requested);
    if (!this.config.allowedRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) throw new Error("Project path is outside PM_ALLOWED_ROOTS");
    await assertGitRepository(real);
    const metadata = await getRepoMetadata(real);
    if (metadata.root !== real) throw new Error("Path must be the repository root");
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO projects (id,name,path,repo_remote,status,added_at) VALUES (?,?,?,?, 'active', ?)").run(id, name?.trim() || path.basename(real), real, metadata.remote, now);
    await installPostCommitHook(real);
    return this.get(id)!;
  }

  remove(id: string): boolean { return this.db.prepare("DELETE FROM projects WHERE id=?").run(id).changes > 0; }
}
