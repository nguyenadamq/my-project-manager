-- Adds project priority (auto-dispatch tie-breaking, dashboard ordering) and a small cache
-- table for live-scraped usage readings (see usage-scraper.ts). auto_dispatch settings reuse
-- the existing generic settings(key,value) table, the same pattern as 'pipeline.defaults'.
ALTER TABLE projects ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS live_usage (
  pool TEXT PRIMARY KEY CHECK(pool IN ('claude_session','claude_weekly','codex_five_hour','codex_weekly')),
  percent_used INTEGER NOT NULL,
  resets_at TEXT,
  checked_at TEXT NOT NULL,
  error TEXT
);
