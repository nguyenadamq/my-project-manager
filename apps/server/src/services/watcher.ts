import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import type { Db } from "../db.js";
import type { SummaryService } from "./summaries.js";

export class TriggerWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private db: Db, private summaries: SummaryService, private debounceMs: number) {}
  start() {
    const projects = this.db.prepare("SELECT id,path FROM projects WHERE status='active'").all() as { id: string; path: string }[];
    const paths = projects.map((p) => path.join(p.path, ".pm", "trigger"));
    this.watcher = chokidar.watch(paths, { ignoreInitial: true });
    this.watcher.on("add", (file) => this.schedule(file)).on("change", (file) => this.schedule(file));
  }
  addProject(repo: string) { void this.watcher?.add(path.join(repo, ".pm", "trigger")); }
  removeProject(repo: string) { void this.watcher?.unwatch(path.join(repo, ".pm", "trigger")); }
  private schedule(file: string) {
    const project = this.db.prepare("SELECT id FROM projects WHERE path=?").get(path.dirname(path.dirname(file))) as { id: string } | undefined;
    if (!project) return;
    const old = this.timers.get(project.id); if (old) clearTimeout(old);
    this.timers.set(project.id, setTimeout(() => { this.timers.delete(project.id); void this.summaries.sync(project.id); }, this.debounceMs));
  }
  async stop() { for (const timer of this.timers.values()) clearTimeout(timer); await this.watcher?.close(); }
}
