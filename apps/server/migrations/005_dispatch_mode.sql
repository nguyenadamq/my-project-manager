-- Adds a per-item dispatch mode. 'queued' is the existing behaviour: the item waits in the
-- project queue for an explicit Start or for auto-dispatch to pick it up. 'instant' starts the
-- pipeline as soon as the prompt is added -- same worktree isolation, same concurrency slot,
-- it just doesn't wait to be chosen. Existing rows default to 'queued', preserving today's
-- behaviour exactly.
ALTER TABLE queued_prompts ADD COLUMN dispatch TEXT NOT NULL DEFAULT 'queued' CHECK(dispatch IN ('instant','queued'));
