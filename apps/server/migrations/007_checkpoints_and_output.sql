-- Checkpoint list drafted alongside the plan (see plan-stage prompt in pipeline-runner.ts) and
-- the running index Codex has self-reported finishing during the current, non-fix implement
-- attempt. Both null/0 for implement_only items (no plan stage) and for any row from before
-- this migration -- that just means "no progress bar to show".
ALTER TABLE queued_prompts ADD COLUMN checkpoints TEXT;
ALTER TABLE queued_prompts ADD COLUMN checkpoint_index INTEGER NOT NULL DEFAULT 0;

-- One row per (prompt, stage): the running CLI transcript for that stage, capped and reset at
-- the start of each attempt (see QueueService.resetOutput/captureOutput) so it always reflects
-- the current or most recent run of that stage, not every retry concatenated together.
CREATE TABLE IF NOT EXISTS pipeline_output (
  prompt_id TEXT NOT NULL REFERENCES queued_prompts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('plan','implement','review')),
  content TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (prompt_id, stage)
);
