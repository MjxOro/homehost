-- Setup recipes: the worker installs the chosen software (e.g. Minecraft Java)
-- after the box passes its readiness gate. Idempotent: safe to re-apply; the
-- ledger runner applies each file once.
-- recipe_id NULL = plain Ubuntu ("none" is never stored). setup_status is
-- 'none' exactly when there is no recipe. eula_accepted_at records when the
-- owner accepted the recipe's license at request time.
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS recipe_id TEXT;
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS setup_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS setup_step TEXT;
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS setup_error TEXT;
ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS eula_accepted_at TIMESTAMPTZ;

ALTER TABLE server_requests DROP CONSTRAINT IF EXISTS server_requests_recipe_id_check;
ALTER TABLE server_requests ADD CONSTRAINT server_requests_recipe_id_check
  CHECK (recipe_id IS NULL OR recipe_id IN ('node','python','docker','code_server','minecraft_java','minecraft_bedrock','valheim'));

ALTER TABLE server_requests DROP CONSTRAINT IF EXISTS server_requests_setup_status_check;
ALTER TABLE server_requests ADD CONSTRAINT server_requests_setup_status_check
  CHECK (setup_status IN ('none','pending','running','done','failed'));

ALTER TABLE server_requests DROP CONSTRAINT IF EXISTS server_requests_setup_recipe_check;
ALTER TABLE server_requests ADD CONSTRAINT server_requests_setup_recipe_check
  CHECK ((recipe_id IS NULL) = (setup_status = 'none'));

ALTER TABLE server_requests DROP CONSTRAINT IF EXISTS server_requests_setup_step_check;
ALTER TABLE server_requests ADD CONSTRAINT server_requests_setup_step_check
  CHECK (setup_step IS NULL OR setup_step IN ('update_packages','install_java','download_minecraft','configure_minecraft','install_node','install_python','install_docker','start_service','wait_ready'));

-- Setup runs as its own worker job. provision_jobs_active_unique already keys
-- on (request_id, action), so at most one setup job per request is active.
ALTER TABLE provision_jobs DROP CONSTRAINT IF EXISTS provision_jobs_action_check;
ALTER TABLE provision_jobs ADD CONSTRAINT provision_jobs_action_check
  CHECK (action IN ('provision','teardown','stop','start','setup'));

ALTER TABLE activity_events DROP CONSTRAINT IF EXISTS activity_events_action_check;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_action_check
  CHECK (action IN ('requested','approved','rejected','deleted','provisioning','running','stopped','provision_failed','setup_started','setup_done','setup_failed'));
