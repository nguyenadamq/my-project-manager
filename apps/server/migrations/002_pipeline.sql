PRAGMA foreign_keys = OFF;

CREATE TABLE queued_prompts_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','planning','plan_ready','implementing','reviewing','fixing',
    'done','review_exhausted','failed','cancelled'
  )),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_branch TEXT,
  result_diff_summary TEXT,
  error_message TEXT,
  needs_attention INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  base_sha TEXT,
  plan_text TEXT,
  plan_original_text TEXT,
  plan_approved_at TEXT,
  fix_rounds_used INTEGER NOT NULL DEFAULT 0,
  review_verdict TEXT CHECK(review_verdict IN ('CLEAN','NEEDS-FIXES') OR review_verdict IS NULL),
  review_notes TEXT,
  run_overrides TEXT,
  plan_model TEXT, plan_effort TEXT,
  implement_model TEXT, implement_effort TEXT,
  review_model TEXT, review_effort TEXT
);

INSERT INTO queued_prompts_new (
  id, project_id, text, position, status, created_at, started_at, finished_at,
  result_branch, result_diff_summary, error_message, needs_attention
)
SELECT id, project_id, text, position,
  CASE status WHEN 'running' THEN 'failed' ELSE status END,
  created_at, started_at, finished_at, result_branch, result_diff_summary,
  CASE WHEN status='running' THEN COALESCE(error_message, 'Interrupted by server restart during the pipeline upgrade; requeue this prompt.') ELSE error_message END,
  CASE WHEN status='running' THEN 1 ELSE 0 END
FROM queued_prompts;

DROP TABLE queued_prompts;
ALTER TABLE queued_prompts_new RENAME TO queued_prompts;
CREATE INDEX IF NOT EXISTS queue_project_position ON queued_prompts(project_id, position);
CREATE INDEX IF NOT EXISTS queue_needs_attention ON queued_prompts(project_id, needs_attention) WHERE needs_attention = 1;

ALTER TABLE projects ADD COLUMN pipeline_overrides TEXT;

CREATE TABLE IF NOT EXISTS pipeline_events (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES queued_prompts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('plan','implement','review','system')),
  kind TEXT NOT NULL CHECK(kind IN (
    'started','output','completed','failed','awaiting_approval','approved',
    'fix_round_started','verdict','attention','cancelled'
  )),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_events_prompt ON pipeline_events(prompt_id, created_at);
PRAGMA foreign_keys = ON;
