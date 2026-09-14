-- User moderation: operator approval of accounts plus technical classification.
-- Idempotent: safe to re-apply; the ledger runner applies each file once.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (account_status IN ('pending','approved','rejected','suspended'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS technical_level TEXT
  CHECK (technical_level IN ('technical','non_technical'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
-- Pre-moderation rows were implicitly approved: only genuinely new signups
-- start as 'pending'. Covers the seeded showcase personas (alice, bob,
-- operator) so existing request flows keep working under the AccountPending guard.
UPDATE users SET account_status = 'approved' WHERE account_status = 'pending';
CREATE INDEX IF NOT EXISTS users_account_status_idx ON users(account_status);
