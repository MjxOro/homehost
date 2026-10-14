-- Agent access (docs/agent-access.md): bearer tokens that let agents reach a
-- user's machines without the panel, and the exec queue the host worker
-- drains through the Incus API.
-- Idempotent: safe to re-apply; the ledger runner applies each file once.

-- One row per issued token. Only the sha256 of the secret is stored; the
-- plaintext is shown once at creation. machine_ids NULL = every machine the
-- owner has now or later; ownership is re-checked on every use.
CREATE TABLE IF NOT EXISTS access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  scopes TEXT[] NOT NULL CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['machines:read','machines:exec','machines:power']::text[]
  ),
  machine_ids UUID[] CHECK (machine_ids IS NULL OR cardinality(machine_ids) > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_tokens_user_created_idx
  ON access_tokens (user_id, created_at DESC);

-- One row per agent operation on a machine. The worker claims queued rows,
-- runs them once (never retried), stores bounded output and finishes them;
-- finished rows are purged after 24 hours. error holds a stable code, never
-- guest output.
CREATE TABLE IF NOT EXISTS machine_execs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES server_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id UUID REFERENCES access_tokens(id) ON DELETE SET NULL,
  op TEXT NOT NULL CHECK (op IN ('command','read_file','write_file')),
  command TEXT,
  cwd TEXT,
  path TEXT,
  input BYTEA,
  file_mode INTEGER CHECK (file_mode IS NULL OR file_mode BETWEEN 0 AND 4095),
  max_bytes INTEGER NOT NULL CHECK (max_bytes > 0),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 600000),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed')),
  exit_code INTEGER,
  timed_out BOOLEAN NOT NULL DEFAULT false,
  stdout BYTEA,
  stderr BYTEA,
  stdout_truncated BOOLEAN NOT NULL DEFAULT false,
  stderr_truncated BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CHECK ((op = 'command') = (command IS NOT NULL)),
  CHECK ((op = 'command') = (path IS NULL))
);
CREATE INDEX IF NOT EXISTS machine_execs_active_idx
  ON machine_execs (created_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS machine_execs_token_active_idx
  ON machine_execs (token_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS machine_execs_finished_idx
  ON machine_execs (finished_at) WHERE finished_at IS NOT NULL;

-- Wake the worker on every queued insert, and the waiting API replica when
-- a row finishes. NOTIFY is delivered on commit.
CREATE OR REPLACE FUNCTION notify_machine_exec() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('machine_execs', NEW.id::text);
  ELSE
    PERFORM pg_notify('machine_exec_done', NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS machine_execs_queued_notify ON machine_execs;
CREATE TRIGGER machine_execs_queued_notify
  AFTER INSERT ON machine_execs
  FOR EACH ROW WHEN (NEW.status = 'queued')
  EXECUTE FUNCTION notify_machine_exec();

DROP TRIGGER IF EXISTS machine_execs_done_notify ON machine_execs;
CREATE TRIGGER machine_execs_done_notify
  AFTER UPDATE OF status ON machine_execs
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status IN ('done','failed')
  )
  EXECUTE FUNCTION notify_machine_exec();
