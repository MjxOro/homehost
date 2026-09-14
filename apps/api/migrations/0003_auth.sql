-- OAuth identity: link provider subjects to users, operator invitations.
-- Idempotent: safe to re-apply; the ledger runner applies each file once.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_provider_unique
  ON users(provider, provider_sub) WHERE provider IS NOT NULL;

CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_email_idx ON invites(email);
