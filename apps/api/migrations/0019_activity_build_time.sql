-- The ready event that finished a build ('running', or 'setup_done' for a
-- recipe) carries that build's duration, so the activity feed can show
-- "Built in ...". The worker sets it together with server_requests.build_ms.
ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS build_ms INTEGER;

-- Backfill: the first ready event after the latest provision job, the same
-- event 0018 measured build_ms to.
UPDATE activity_events e
SET build_ms = r.build_ms
FROM server_requests r,
  LATERAL (
    SELECT max(created_at) AS started_at FROM provision_jobs
    WHERE request_id = r.id AND action = 'provision'
  ) s
WHERE e.request_id = r.id
  AND r.build_ms IS NOT NULL
  AND e.build_ms IS NULL
  AND e.id = (
    SELECT e2.id FROM activity_events e2
    WHERE e2.request_id = r.id
      AND e2.created_at > s.started_at
      AND e2.action = CASE WHEN r.recipe_id IS NULL THEN 'running' ELSE 'setup_done' END
    ORDER BY e2.created_at, e2.id
    LIMIT 1
  );
