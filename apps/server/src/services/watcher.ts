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
  // Unwatching the trigger file alone leaves any debounce timer already in flight for this
  // project (see schedule() below) free to fire later against a row that a caller is about to
  // delete -- clearing it here, while the caller still holds the project (app.ts's DELETE route
  // looks it up before removing it), closes that race at the source rather than only surviving
  // it once schedule()'s own catch below is reached.
  removeProject(repo: string) {
    void this.watcher?.unwatch(path.join(repo, ".pm", "trigger"));
    const project = this.db.prepare("SELECT id FROM projects WHERE path=?").get(repo) as { id: string } | undefined;
    if (!project) return;
    const timer = this.timers.get(project.id);
    if (timer) { clearTimeout(timer); this.timers.delete(project.id); }
  }
  private schedule(file: string) {
    const project = this.db.prepare("SELECT id FROM projects WHERE path=?").get(path.dirname(path.dirname(file))) as { id: string } | undefined;
    if (!project) return;
    const old = this.timers.get(project.id); if (old) clearTimeout(old);
    this.timers.set(project.id, setTimeout(() => {
      this.timers.delete(project.id);
      // Fire-and-forget by design (nothing awaits a debounced sync), but that means an
      // unhandled rejection here previously crashed the whole process outright -- reproduced
      // live by deleting a project while its debounce window was still open: the project row
      // was gone by the time this fired, sync() threw "Project not found", and Node's default
      // unhandled-rejection behavior is to terminate the process. Swallowing here matches the
      // same "log, don't crash" contract app.ts's own schedule() helper gives every other
      // background task in this app -- a debounced summary refresh losing its race with a
      // deletion is an expected outcome, not a failure worth taking the server down for.
      this.summaries.sync(project.id).catch((error) => console.error("[watcher] debounced summary sync failed:", error));
    }, this.debounceMs));
  }
  async stop() { for (const timer of this.timers.values()) clearTimeout(timer); await this.watcher?.close(); }
}
