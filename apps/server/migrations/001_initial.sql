PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  repo_remote TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  added_at TEXT NOT NULL,
  last_synced_sha TEXT,
  last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS feature_summaries (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  overall_summary_md TEXT NOT NULL,
  latest_feature_md TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  added_at_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('shipped','in_progress'))
);
CREATE TABLE IF NOT EXISTS queued_prompts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_branch TEXT,
  result_diff_summary TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS queue_project_position ON queued_prompts(project_id, position);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL CHECK(tool IN ('claude_code','chatgpt')),
  kind TEXT NOT NULL CHECK(kind IN ('message','job','manual_log')),
  timestamp TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
