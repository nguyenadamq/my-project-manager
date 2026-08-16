import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

export function createDatabase(filename: string): Db {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const migration = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations/001_initial.sql");
  db.exec(fs.readFileSync(migration, "utf8"));
  return db;
}
