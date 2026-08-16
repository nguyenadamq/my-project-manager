import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import type { Db } from "../db.js";
import type { EventHub } from "../events.js";
import { collectBaseline, collectDelta, getRepoMetadata } from "./git.js";

type FeatureDelta = { title: string; description: string; status: "shipped" | "in_progress" };
type Synthesis = { overallSummaryMd: string; latestFeatureMd: string; features: FeatureDelta[] };

function deterministicSynthesis(name: string, sha: string, material: string): Synthesis {
  const commits = material.split("\n").filter((line) => /^[a-f0-9]{7,40}\s/.test(line)).slice(0, 12);
  return {
    overallSummaryMd: `# ${name}\n\nRepository summary at \`${sha.slice(0, 8)}\`.\n\n${commits.map((c) => `- ${c}`).join("\n") || "- Initial repository snapshot"}`,
    latestFeatureMd: commits[0] ?? `Synchronized ${sha.slice(0, 8)}`,
    features: commits.slice(0, 8).map((c) => ({ title: c.replace(/^[a-f0-9]+\s+/, ""), description: c, status: "shipped" })),
  };
}

async function aiSynthesis(name: string, previous: string, material: string): Promise<Synthesis | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  const response = await client.messages.create({
    model: material.length > 40_000 || !previous ? "claude-sonnet-4-20250514" : "claude-3-5-haiku-latest",
    max_tokens: 2500,
    messages: [{ role: "user", content: `Summarize repository ${name}. Return only JSON matching {overallSummaryMd:string,latestFeatureMd:string,features:[{title,description,status:"shipped"|"in_progress"}]}. Preserve relevant prior facts.\nPRIOR:\n${previous}\nCHANGES:\n${material}` }],
  });
  const text = response.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("AI synthesis returned no text");
  return JSON.parse(text.text.replace(/^```json\s*|\s*```$/g, "")) as Synthesis;
}

export class SummaryService {
  private active = new Set<string>();
  constructor(private db: Db, private events: EventHub) {}

  async sync(projectId: string, force = false): Promise<void> {
    if (this.active.has(projectId)) return;
    const project = this.db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as any;
    if (!project) throw new Error("Project not found");
    this.active.add(projectId);
    try {
      const { sha } = await getRepoMetadata(project.path);
      if (!force && sha === project.last_synced_sha) return;
      const material = project.last_synced_sha ? await collectDelta(project.path, project.last_synced_sha, sha) : await collectBaseline(project.path);
      const previous = (this.db.prepare("SELECT overall_summary_md FROM feature_summaries WHERE project_id=?").get(projectId) as any)?.overall_summary_md ?? "";
      const result = await aiSynthesis(project.name, previous, material) ?? deterministicSynthesis(project.name, sha, material);
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`INSERT INTO feature_summaries(project_id,commit_sha,generated_at,overall_summary_md,latest_feature_md,model) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET commit_sha=excluded.commit_sha,generated_at=excluded.generated_at,overall_summary_md=excluded.overall_summary_md,latest_feature_md=excluded.latest_feature_md,model=excluded.model`).run(projectId, sha, now, result.overallSummaryMd, result.latestFeatureMd, process.env.ANTHROPIC_API_KEY ? "anthropic" : "deterministic");
        this.db.prepare("DELETE FROM features WHERE project_id=?").run(projectId);
        const insert = this.db.prepare("INSERT INTO features(id,project_id,title,description,added_at_sha,status) VALUES(?,?,?,?,?,?)");
        for (const f of result.features) insert.run(nanoid(), projectId, f.title, f.description, sha, f.status);
        this.db.prepare("UPDATE projects SET last_synced_sha=?,last_synced_at=? WHERE id=?").run(sha, now, projectId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.events.emit({ type: "sync.updated", projectId });
    } finally { this.active.delete(projectId); }
  }
}
