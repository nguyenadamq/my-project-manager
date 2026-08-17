import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";

describe("migration runner", () => {
  it("applies each migration exactly once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-db-")); const file = path.join(root, "pm.db");
    const first = createDatabase(file); first.close(); const second = createDatabase(file);
    const rows = second.prepare("SELECT filename FROM schema_migrations ORDER BY filename").all() as { filename: string }[];
    expect(rows.map((row) => row.filename)).toEqual(["001_initial.sql", "002_pipeline.sql"]); second.close(); fs.rmSync(root, { recursive: true, force: true });
  });
});
