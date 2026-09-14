-- Public IPv6 per box, derived deterministically from the request UUID.
-- Set at provision; null on v4-only hosts or pre-feature boxes.
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS ipv6 TEXT;
