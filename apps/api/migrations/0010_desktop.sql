-- Desktop GUI (KasmVNC): per-VM browser desktop routing fields.
-- Idempotent: safe to re-apply; the ledger runner applies each file once.
-- desktop_env is the GUI stack ("ubuntu-xfce" | "omarchy"), NULL for
-- headless plans. desktop_hostname is the flat "<label>-vnc" public name
-- (one DNS level, covered by the existing wildcard cert); UNIQUE with
-- Postgres NULL semantics doubles as the backstop for truncated-hostname
-- collisions, which surface as 23505 and reuse the SubdomainTaken→409 path.
-- desktop_port carries plan.desktop.kasmPort so the edge route template can
-- target the KasmVNC backend without a new secret or lookup.
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS desktop_env TEXT;
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS desktop_hostname TEXT UNIQUE;
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS desktop_port INTEGER;
