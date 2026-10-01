-- Plan ids follow one "<kind>-<size>" scheme: the small container plan was
-- "game-small" and is now "container-small". Existing requests keep resolving
-- to their plan name. Idempotent: safe to re-apply.
UPDATE server_requests SET plan_id = 'container-small' WHERE plan_id = 'game-small';
