-- A short, human-facing readout drafted alongside the plan (see plan-stage prompt in
-- pipeline-runner.ts): what's being added/changed, briefly how, and what's tested. Shown by
-- default on the approval screen instead of the full plan text, which stays available (and
-- still editable/fed to the implement stage verbatim) behind its own toggle. Null for
-- implement_only items (no plan stage) and for plan_ready rows from before this migration.
ALTER TABLE queued_prompts ADD COLUMN plan_summary TEXT;
