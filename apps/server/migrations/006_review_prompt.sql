-- The plan stage now drafts a bespoke review prompt alongside the implementation plan, in the
-- same model call, instead of the review stage improvising generic instructions each time --
-- the reviewer's criteria are informed by the same repository context the planner already
-- read, and a fix round no longer needs the review stage to re-derive it from scratch.
-- Nullable with no default: an in-flight plan_ready row from before this migration has no
-- review_prompt, and review() falls back to its old generic instructions when it's empty.
ALTER TABLE queued_prompts ADD COLUMN review_prompt TEXT;
ALTER TABLE queued_prompts ADD COLUMN review_prompt_original_text TEXT;
