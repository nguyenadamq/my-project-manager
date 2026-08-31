import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowseService } from "../src/services/browse.js";
import type { Config } from "../src/config.js";
import { migrationSql } from "./helpers/migrations.js";

let db: DatabaseSync; let root: string; let browse: BrowseService;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-browse-")));
  fs.mkdirSync(path.join(root, "workspace", "repo-a"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace", "plain-folder"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace", ".hidden"), { recursive: true });
  execFileSync("git", ["init", "-b", "main", path.join(root, "workspace", "repo-a")]);
  db = new DatabaseSync(":memory:");
  for (const sql of migrationSql()) db.exec(sql);
  browse = new BrowseService(db, { allowedRoots: [path.join(root, "workspace")] } as Config);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("BrowseService", () => {
  it("starts at the allowed roots when given no path", async () => {
    const result = await browse.browse();
    expect(result.path).toBeNull();
    expect(result.parent).toBeNull();
    expect(result.entries.map((entry) => entry.path)).toEqual([path.join(root, "workspace")]);
  });

  it("lists sub-folders, flagging which are Git repositories", async () => {
    const result = await browse.browse(path.join(root, "workspace"));
    expect(result.entries.map((entry) => entry.name)).toEqual(["plain-folder", "repo-a"]);
    expect(result.entries.find((entry) => entry.name === "repo-a")?.isGitRepo).toBe(true);
    expect(result.entries.find((entry) => entry.name === "plain-folder")?.isGitRepo).toBe(false);
  });

  it("hides noise directories and dotfolders that can never be a project root", async () => {
    const names = (await browse.browse(path.join(root, "workspace"))).entries.map((entry) => entry.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".hidden");
  });

  it("describes the folder being listed so the picker knows if it is itself addable", async () => {
    const result = await browse.browse(path.join(root, "workspace", "repo-a"));
    expect(result.current).toMatchObject({ name: "repo-a", isGitRepo: true, isRegistered: false });
  });

  it("marks an already-registered repository so it can't be added twice", async () => {
    const repo = path.join(root, "workspace", "repo-a");
    db.prepare("INSERT INTO projects (id,name,path,status,added_at) VALUES ('p1','repo-a',?,'active','now')").run(repo);
    const result = await browse.browse(path.join(root, "workspace"));
    expect(result.entries.find((entry) => entry.name === "repo-a")?.isRegistered).toBe(true);
  });

  // The picker is an authenticated read-only listing, but it still reveals folder names, so it
  // has to honour exactly the same allow-list that gates registration itself.
  it("refuses to list anything outside PM_ALLOWED_ROOTS", async () => {
    await expect(browse.browse(root)).rejects.toThrow(/outside PM_ALLOWED_ROOTS/);
  });

  it("offers no way up out of an allowed root", async () => {
    expect((await browse.browse(path.join(root, "workspace"))).parent).toBeNull();
    expect((await browse.browse(path.join(root, "workspace", "repo-a"))).parent).toBe(path.join(root, "workspace"));
  });

  it("reports a missing folder rather than returning an empty listing", async () => {
    await expect(browse.browse(path.join(root, "workspace", "nope"))).rejects.toThrow(/not found/i);
  });
});
