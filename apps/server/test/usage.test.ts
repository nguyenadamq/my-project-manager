import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { EventHub } from "../src/events.js";
import { UsageService, weeklyWindow } from "../src/services/usage.js";
import { migrationSql } from "./helpers/migrations.js";

describe("weekly usage window", () => {
  it("anchors to the configured reset weekday", () => {
    const { start, end } = weeklyWindow(new Date("2026-08-15T12:00:00"), 1);
    expect(start.getDay()).toBe(1); expect(end.getDay()).toBe(1);
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it("starts today when today is reset day", () => {
    const now = new Date("2026-08-17T16:00:00"); const { start } = weeklyWindow(now, 1);
    expect(start.getDate()).toBe(17); expect(start.getHours()).toBe(0);
  });
});

describe("UsageService.snapshot", () => {
  let db: DatabaseSync; let root: string; let usage: UsageService;
  let config: Config;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-usage-"));
    // Isolated from whatever the machine running these tests actually has in its real
    // ~/.claude/projects -- otherwise estimateClaudeSession's real-usage fallback makes this
    // suite non-deterministic (and slow) depending on the developer's own recent Claude usage.
    config = { host: "127.0.0.1", port: 0, databasePath: "", authToken: "x", allowedRoots: [], concurrency: 1, syncDebounceMs: 0, chatgptWeeklyLimit: 100, chatgptResetDay: 1, claudeFiveHourLimit: 1000, cliTimeoutMs: 1000, claudeCliPath: "claude", codexCliPath: "codex", usageScrapeEnabled: true, usageScrapeIntervalMs: 600_000, chromeCdpUrl: "http://127.0.0.1:9222", claudeProjectsPath: path.join(root, "no-claude-projects") };
    db = new DatabaseSync(":memory:");
    for (const sql of migrationSql()) db.exec(sql);
    usage = new UsageService(db, config, new EventHub());
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("reports 'unknown' for every pool when nothing has ever been scraped or estimated", async () => {
    const snapshot = await usage.snapshot(new Date());
    expect(snapshot.claudeWeekly).toMatchObject({ source: "unknown", percent: 0 });
    expect(snapshot.codexFiveHour).toMatchObject({ source: "unknown", percent: 0 });
    expect(snapshot.recommendation).toMatch(/isn't connected yet/);
  });

  it("prefers a fresh live reading over the estimate/unknown fallback", async () => {
    const now = new Date();
    db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES('claude_session',42,NULL,?,NULL)").run(now.toISOString());
    const snapshot = await usage.snapshot(now);
    expect(snapshot.claudeSession).toMatchObject({ source: "live", percent: 42 });
  });

  it("falls back to unknown once a live reading is older than 2x the scrape interval", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - config.usageScrapeIntervalMs * 3);
    db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES('codex_weekly',10,NULL,?,NULL)").run(stale.toISOString());
    const snapshot = await usage.snapshot(now);
    expect(snapshot.codexWeekly.source).not.toBe("live");
  });

  it("ignores a live row recorded as an error", async () => {
    const now = new Date();
    db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES('claude_weekly',0,NULL,?,'not logged in')").run(now.toISOString());
    const snapshot = await usage.snapshot(now);
    expect(snapshot.claudeWeekly.source).toBe("unknown");
  });

  // The reported symptom these exist for: "Check usage now" appeared to do nothing. A scrape
  // that couldn't reach Chrome recorded its error, the snapshot then dropped that error, and the
  // gauge quietly kept showing the local estimate -- indistinguishable from a successful check.
  it("explains why a pool fell back rather than silently showing the estimate", async () => {
    const now = new Date();
    db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES('claude_session',0,NULL,?,?)")
      .run(now.toISOString(), "Couldn't reach Chrome at http://127.0.0.1:9222");
    const snapshot = await usage.snapshot(now);
    expect(snapshot.claudeSession.source).not.toBe("live");
    expect(snapshot.claudeSession.detail).toContain("Couldn't reach Chrome");
  });

  it("says so when the only reading on hand is too old to trust", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - config.usageScrapeIntervalMs * 3);
    db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES('claude_weekly',42,NULL,?,NULL)").run(stale.toISOString());
    const snapshot = await usage.snapshot(now);
    expect(snapshot.claudeWeekly.source).toBe("unknown");
    expect(snapshot.claudeWeekly.detail).toMatch(/minutes old/);
  });

  it("leaves detail null when the reading is genuinely live", async () => {
    const now = new Date();
    db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES('claude_session',42,NULL,?,NULL)").run(now.toISOString());
    const snapshot = await usage.snapshot(now);
    expect(snapshot.claudeSession).toMatchObject({ source: "live", percent: 42, detail: null });
  });

  it("estimates codex weekly from the manual log tally as a last resort", async () => {
    usage.logChatGpt("checked manually");
    const snapshot = await usage.snapshot(new Date());
    expect(snapshot.codexWeekly).toMatchObject({ source: "estimated" });
    expect(snapshot.codexWeekly.percent).toBeGreaterThan(0);
  });
});
