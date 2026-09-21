-- Desktop session secret for the panel's same-origin VNC proxy.
-- Idempotent: safe to re-apply; the ledger runner applies each file once.
-- desktop_password is the persistent per-VM KasmVNC secret (base64url),
-- independent of instance_password (one-read root SSH OTP, cleared on first
-- read). It survives refresh so the canvas stays signed in; the panel never
-- sees it (the API proxy injects it as Basic auth toward the guest).
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS desktop_password TEXT;
