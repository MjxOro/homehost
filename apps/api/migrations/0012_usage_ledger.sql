-- Usage ledger foundations: agent_runs, llm_calls, and the hash-chained,
-- append-only credit_ledger. Idempotent: safe to re-apply; the runner applies
-- each file once.

-- agent_runs: one row per agent job. Bench runs have no user.
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL
    CHECK (kind IN ('site_build','site_edit','site_import','concierge','bench')),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('prod','bench','dev')),
  ref_type TEXT,
  ref_id TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS agent_runs_user_id_started_at_idx
  ON agent_runs(user_id, started_at);

-- llm_calls: one row per provider call. Cost is integer micro-dollars, never floats.
-- The same table records benchmark runs (purpose = 'bench').
CREATE TABLE IF NOT EXISTS llm_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID REFERENCES agent_runs(id),
  user_id TEXT REFERENCES users(id),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('prod','bench','dev')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_request_id TEXT,
  prompt_hash TEXT NOT NULL
    CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  cost_micro_usd BIGINT NOT NULL CHECK (cost_micro_usd >= 0),
  price_table_version TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('ok','error')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_calls_user_id_created_at_idx
  ON llm_calls(user_id, created_at);
CREATE INDEX IF NOT EXISTS llm_calls_agent_run_id_idx
  ON llm_calls(agent_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS llm_calls_provider_request_unique
  ON llm_calls(provider, provider_request_id)
  WHERE provider_request_id IS NOT NULL;

-- credit_ledger: single global hash chain, append-only. created_at is set by the
-- app (millisecond precision) because it is part of the hashed canonical row.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  delta BIGINT NOT NULL CHECK (delta <> 0),
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL
    CHECK (reason IN ('purchase','usage','refund','grant','adjustment')),
  ref_type TEXT,
  ref_id TEXT,
  confirm_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  prev_hash CHAR(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash CHAR(64) NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS credit_ledger_user_id_id_idx
  ON credit_ledger(user_id, id);

CREATE OR REPLACE FUNCTION credit_ledger_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credit_ledger_no_update_delete ON credit_ledger;
CREATE TRIGGER credit_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_reject_mutation();

DROP TRIGGER IF EXISTS credit_ledger_no_truncate ON credit_ledger;
CREATE TRIGGER credit_ledger_no_truncate
  BEFORE TRUNCATE ON credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION credit_ledger_reject_mutation();
