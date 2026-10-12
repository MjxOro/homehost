-- Provisioning benchmarks.
--   server_requests.build_ms: latest provision request (approval or retry) ->
--     box ready (running, or setup done when a recipe was chosen). The web UI
--     shows it as "Built in ...".
--   provision_jobs.timings: per-phase durations of a job's final attempt,
--     written by the worker and read by scripts/provision-bench.ts.
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS build_ms INTEGER;
ALTER TABLE provision_jobs ADD COLUMN IF NOT EXISTS timings JSONB;

-- Backfill boxes built before this migration from the job and activity logs:
-- the start is the latest provision job, the end the first ready event after it.
UPDATE server_requests r
SET build_ms = (extract(epoch FROM b.ready_at - b.started_at) * 1000)::int
FROM (
  SELECT s.request_id, s.started_at,
    (SELECT min(e.created_at) FROM activity_events e
      WHERE e.request_id = s.request_id
        AND e.created_at > s.started_at
        AND e.action = CASE WHEN rr.recipe_id IS NULL THEN 'running' ELSE 'setup_done' END
    ) AS ready_at
  FROM (
    SELECT request_id, max(created_at) AS started_at
    FROM provision_jobs WHERE action = 'provision'
    GROUP BY request_id
  ) s
  JOIN server_requests rr ON rr.id = s.request_id
) b
WHERE b.request_id = r.id AND b.ready_at IS NOT NULL AND r.build_ms IS NULL;
