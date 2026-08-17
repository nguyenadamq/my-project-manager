import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

export function createDatabase(filename: string): Db {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const rows = db.prepare("SELECT filename FROM schema_migrations").all() as { filename: string }[];
  const applied = new Set(rows.map((row) => row.filename));
  for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    db.prepare("INSERT INTO schema_migrations(filename, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  }
  return db;
}
