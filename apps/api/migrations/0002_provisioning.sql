-- Milestone 2 provisioning: instance linkage, widened state machines, worker outbox.
-- Idempotent: safe to re-apply; the ledger runner applies each file once.
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS instance_name TEXT UNIQUE;
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS ipv4 TEXT;

ALTER TABLE server_requests DROP CONSTRAINT IF EXISTS server_requests_status_check;
ALTER TABLE server_requests ADD CONSTRAINT server_requests_status_check
  CHECK (status IN ('pending_approval','approved','provisioning','running','stopped','rejected','deleted'));

ALTER TABLE activity_events DROP CONSTRAINT IF EXISTS activity_events_action_check;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_action_check
  CHECK (action IN ('requested','approved','rejected','deleted','provisioning','running','stopped','provision_failed'));

CREATE TABLE IF NOT EXISTS provision_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES server_requests(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('provision','teardown','stop','start')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active job per request+action: concurrent duplicates cannot double-provision.
CREATE UNIQUE INDEX IF NOT EXISTS provision_jobs_active_unique
  ON provision_jobs(request_id, action) WHERE status IN ('queued','leased');
CREATE INDEX IF NOT EXISTS provision_jobs_status_idx ON provision_jobs(status);
CREATE INDEX IF NOT EXISTS provision_jobs_request_id_idx ON provision_jobs(request_id);
