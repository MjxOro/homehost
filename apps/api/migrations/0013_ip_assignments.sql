-- Historical ownership ledger. IDs are deliberately NOT foreign keys: purging
-- or truncating live requests/users must neither erase nor block this history.
CREATE TABLE IF NOT EXISTS ip_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_email TEXT,
  address INET NOT NULL,
  subdomain TEXT NOT NULL,
  prefix TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  CONSTRAINT ip_assignments_release_check
    CHECK (released_at IS NULL OR released_at >= assigned_at),
  CONSTRAINT ip_assignments_host_check
    CHECK (masklen(address) = CASE family(address) WHEN 6 THEN 128 ELSE 32 END)
);
CREATE UNIQUE INDEX IF NOT EXISTS ip_assignments_open_address_unique
  ON ip_assignments(address) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS ip_assignments_address_assigned_at_idx
  ON ip_assignments(address, assigned_at);
CREATE INDEX IF NOT EXISTS ip_assignments_request_id_idx
  ON ip_assignments(request_id);

-- No exact allocation timestamp exists before this ledger. The earliest
-- 'running' event is the closest recorded evidence of a usable box; fall back
-- to request creation for partial provisions with no such event. Clamp to
-- updated_at so legacy deletion timestamps cannot produce a negative window.
-- Reapplying never resurrects an assignment already released by the worker.
INSERT INTO ip_assignments
  (request_id, user_id, owner_name, owner_email, address, subdomain, prefix,
   assigned_at, released_at)
SELECT r.id, r.owner_id, COALESCE(u.name, r.owner_name), u.email,
       r.ipv6::inet, r.subdomain, network(set_masklen(r.ipv6::inet, 64))::text,
       LEAST(COALESCE((SELECT MIN(e.created_at) FROM activity_events e
                      WHERE e.request_id = r.id AND e.action = 'running'),
                     r.created_at), r.updated_at),
       CASE WHEN r.status = 'deleted' THEN r.updated_at ELSE NULL END
FROM server_requests r
LEFT JOIN users u ON u.id = r.owner_id
WHERE r.ipv6 IS NOT NULL AND r.status <> 'rejected'
  AND NOT EXISTS (SELECT 1 FROM ip_assignments a WHERE a.request_id = r.id);
