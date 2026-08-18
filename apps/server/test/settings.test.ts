import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PIPELINE, SettingsService } from "../src/services/settings.js";

const migrations = ["001_initial.sql", "002_pipeline.sql"].map((file) => fs.readFileSync(path.resolve("migrations", file), "utf8"));
let db: DatabaseSync; let settings: SettingsService;
beforeEach(() => { db = new DatabaseSync(":memory:"); for (const migration of migrations) db.exec(migration); settings = new SettingsService(db); });

describe("pipeline settings", () => {
  it("uses the pinned defaults when nothing is stored", () => expect(settings.getGlobalDefaults()).toEqual(DEFAULT_PIPELINE));
  it("deep-merges patches without clobbering sibling fields", () => {
    const next = settings.setGlobalDefaults({ plan: { effort: "medium" } });
    expect(next.plan).toEqual({ model: "sonnet", effort: "medium" }); expect(next.implement).toEqual(DEFAULT_PIPELINE.implement);
  });
  it("resolves global, project, and run values per field", () => {
    settings.setGlobalDefaults({ plan: { effort: "medium" }, implement: { model: "gpt-5.5" } });
    const resolved = settings.resolve(JSON.stringify({ plan: { model: "opus" } }), JSON.stringify({ plan: { effort: "high" }, review: { model: "haiku" } }));
    expect(resolved.plan).toEqual({ model: "opus", effort: "high" }); expect(resolved.implement.model).toBe("gpt-5.5"); expect(resolved.review.model).toBe("haiku");
  });
  it("rejects an explicit empty model or effort instead of silently accepting it", () => {
    expect(() => settings.setGlobalDefaults({ plan: { model: "" } })).toThrow(/cannot be empty/);
    expect(() => settings.validate({ review: { effort: "" } })).toThrow(/cannot be empty/);
    // A field that is simply absent (not provided at all) is still a valid "inherit" signal.
    expect(() => settings.validate({ plan: {} })).not.toThrow();
  });
});
