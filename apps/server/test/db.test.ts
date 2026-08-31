import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";
import { migrationFiles } from "./helpers/migrations.js";

describe("migration runner", () => {
  it("applies each migration exactly once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-db-")); const file = path.join(root, "pm.db");
    const first = createDatabase(file); first.close(); const second = createDatabase(file);
    const rows = second.prepare("SELECT filename FROM schema_migrations ORDER BY filename").all() as { filename: string }[];
    expect(rows.map((row) => row.filename)).toEqual(migrationFiles()); second.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it("rolls back a failing migration atomically so it can be retried cleanly", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-db-bad-")); const file = path.join(root, "pm.db");
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-migrations-"));
    fs.writeFileSync(path.join(migrationsDir, "001_initial.sql"), fs.readFileSync(path.resolve("migrations/001_initial.sql"), "utf8"));
    // A statement that succeeds, followed by one that is invalid: proves the whole file
    // commits or rolls back as one unit, never leaving `demo` behind half-applied.
    fs.writeFileSync(path.join(migrationsDir, "002_broken.sql"), "CREATE TABLE demo(id TEXT); THIS IS NOT VALID SQL;");

    expect(() => createDatabase(file, migrationsDir)).toThrow(/rolled back/);

    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='demo'").get()).toBeUndefined();
    const applied = (db.prepare("SELECT filename FROM schema_migrations").all() as { filename: string }[]).map((row) => row.filename);
    expect(applied).toEqual(["001_initial.sql"]); // the broken migration was not recorded as applied
    db.close();

    // Fixing the file and retrying should now succeed cleanly from where it left off.
    fs.writeFileSync(path.join(migrationsDir, "002_broken.sql"), "CREATE TABLE demo(id TEXT);");
    const retried = createDatabase(file, migrationsDir);
    expect(retried.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='demo'").get()).toBeDefined();
    retried.close();
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(migrationsDir, { recursive: true, force: true });
  });
});
