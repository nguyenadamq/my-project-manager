import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/events.js";
import { SummaryService } from "../src/services/summaries.js";
import { TriggerWatcher } from "../src/services/watcher.js";
import { migrationSql } from "./helpers/migrations.js";

let db: DatabaseSync; let root: string; let repo: string; let watcher: TriggerWatcher | null;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const sql of migrationSql()) db.exec(sql);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-watcher-"));
  repo = path.join(root, "repo"); fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "x");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
  // Matches production ordering: installPostCommitHook() always creates `.pm/` at registration
  // time, before the watcher ever attaches to `.pm/trigger` (either at server boot, for an
  // already-registered project, or via addProject() for a newly-registered one). Watching a
  // path whose parent directory doesn't exist yet is a real chokidar gap -- confirmed directly:
  // an "add" event for a file created after `chokidar.watch()` was called on its not-yet-real
  // parent directory never fires at all, even seconds later -- so getting this order right in
  // the test matters, not just cosmetically.
  fs.mkdirSync(path.join(repo, ".pm"), { recursive: true });
  watcher = null;
});
afterEach(async () => { await watcher?.stop(); fs.rmSync(root, { recursive: true, force: true }); });

// A live end-to-end pipeline run surfaced this for real: completing a job writes `.pm/trigger`
// in the project's own repo (see queue.ts's complete()) to nudge a debounced summary refresh,
// and deleting that project from the UI shortly afterward -- well within an ordinary debounce
// window -- used to crash the entire server outright when the timer fired against a row that no
// longer existed.
describe("TriggerWatcher", () => {
  it("does not crash the process when a project is deleted before its debounced sync fires", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO projects(id,name,path,status,added_at) VALUES('p','Test',?,'active',?)").run(repo, now);
    const summaries = new SummaryService(db, new EventHub());
    // Debounce must be long enough that the OS-level file watcher has definitely noticed the
    // trigger file and armed the timer (see the wait below) while the timer itself is still
    // pending -- too short and the sync fires (successfully, against a project that still
    // exists) before the delete below ever lands, which would pass even against the old,
    // unguarded code for the wrong reason.
    watcher = new TriggerWatcher(db, summaries, 300);
    watcher.start();
    // chokidar's own watch setup is asynchronous; writing the trigger file before it has
    // finished attaching to `.pm/` is a real gap -- confirmed directly -- where the write is
    // simply never seen, at all, no matter how long the test then waits.
    await new Promise((resolve) => setTimeout(resolve, 100));

    fs.writeFileSync(path.join(repo, ".pm", "trigger"), "trigger\n");
    // Give the OS-level file watcher time to notice the new file and arm the debounce timer,
    // then delete the project row well before that timer elapses -- this is the exact race a
    // real user hits by deleting a project shortly after a job completes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    db.prepare("DELETE FROM projects WHERE id='p'").run();

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      // The timer was armed at ~150ms and fires 300ms later (~450ms); wait well past that.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
    }
  });

  it("removeProject cancels a pending debounce timer for that project", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO projects(id,name,path,status,added_at) VALUES('p','Test',?,'active',?)").run(repo, now);
    let syncCalls = 0;
    const summaries = { sync: async () => { syncCalls++; } } as unknown as SummaryService;
    watcher = new TriggerWatcher(db, summaries, 300);
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    fs.writeFileSync(path.join(repo, ".pm", "trigger"), "trigger\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    watcher.removeProject(repo);
    // Past when the (cancelled) 300ms timer armed at ~150ms would otherwise have fired.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(syncCalls).toBe(0);
  });
});
