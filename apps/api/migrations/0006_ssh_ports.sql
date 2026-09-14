-- SSH port leases: one public TCP port per provisioned box, allocated from
-- 22000-22999. NULL means unleased. UNIQUE (with Postgres NULL semantics)
-- is the backstop: concurrent allocators that pick the same free port get
-- 23505 and retry. Released only after teardown proves the instance gone.
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS ssh_port INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'server_requests_ssh_port_unique'
  ) THEN
    ALTER TABLE server_requests
      ADD CONSTRAINT server_requests_ssh_port_unique UNIQUE (ssh_port);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'server_requests_ssh_port_range'
  ) THEN
    ALTER TABLE server_requests
      ADD CONSTRAINT server_requests_ssh_port_range
      CHECK (ssh_port IS NULL OR (ssh_port >= 22000 AND ssh_port <= 22999));
  END IF;
END $$;
