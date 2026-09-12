-- Homehost showcase control plane, milestone 1. Idempotent: safe to re-apply.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member','operator')),
  tier TEXT NOT NULL CHECK (tier IN ('untrusted','trusted'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS server_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL REFERENCES users(id),
  owner_name TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 48),
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','approved','rejected','deleted')),
  subdomain TEXT NOT NULL UNIQUE,
  cpu INTEGER NOT NULL CHECK (cpu > 0),
  memory_mb INTEGER NOT NULL CHECK (memory_mb > 0),
  disk_gb INTEGER NOT NULL CHECK (disk_gb > 0),
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS server_requests_owner_id_idx ON server_requests(owner_id);
CREATE INDEX IF NOT EXISTS server_requests_status_idx ON server_requests(status);
CREATE INDEX IF NOT EXISTS server_requests_owner_status_idx ON server_requests(owner_id, status);
CREATE INDEX IF NOT EXISTS server_requests_created_at_idx ON server_requests(created_at DESC);

CREATE TABLE IF NOT EXISTS activity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES server_requests(id) ON DELETE CASCADE,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('requested','approved','rejected','deleted')),
  server_name TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_events_request_id_idx ON activity_events(request_id);
CREATE INDEX IF NOT EXISTS activity_events_created_at_idx ON activity_events(created_at DESC);

-- Seeded showcase personas. Tier/role are server-owned here, never client-controlled.
INSERT INTO users (id, name, role, tier) VALUES
  ('alice', 'Alice Chen', 'member', 'untrusted'),
  ('bob', 'Bob Martin', 'member', 'trusted'),
  ('operator', 'Lab Operator', 'operator', 'trusted')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  tier = EXCLUDED.tier;
