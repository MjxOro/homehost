-- SSH access: optional owner public key, one-time instance password.
-- Idempotent: safe to re-apply; the ledger runner applies each file once.
-- instance_password holds a generated secret only until its first read via
-- GET /api/requests/:id/credentials, which returns and clears it atomically.
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS ssh_pubkey TEXT;
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS instance_password TEXT;
