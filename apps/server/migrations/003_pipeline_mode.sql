-- Adds a per-item pipeline mode. 'full' is the existing supervised Plan -> Implement -> Review
-- loop; 'implement_only' skips the plan draft/approval checkpoint and the independent review,
-- so Codex implements the raw prompt directly. Existing rows default to 'full', preserving
-- today's behavior exactly.
ALTER TABLE queued_prompts ADD COLUMN mode TEXT NOT NULL DEFAULT 'full' CHECK(mode IN ('full','implement_only'));
