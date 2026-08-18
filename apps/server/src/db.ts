import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

export function createDatabase(filename: string, migrationsDir?: string): Db {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const dir = migrationsDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const rows = db.prepare("SELECT filename FROM schema_migrations").all() as { filename: string }[];
    const applied = new Set(rows.map((row) => row.filename));
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      // The migration's DDL and the "mark it applied" bookkeeping commit together as one
      // transaction (SQLite supports transactional DDL) so a crash mid-migration can never
      // leave a partially-applied, non-idempotent migration that fails to reapply on restart.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations(filename, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw new Error(`Migration ${file} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return db;
  } catch (error) {
    // Don't leak an open (and, on Windows, locked) handle to the database file on failure --
    // the caller gets a clean error and the file is immediately safe to reopen/retry against.
    db.close();
    throw error;
  }
}
