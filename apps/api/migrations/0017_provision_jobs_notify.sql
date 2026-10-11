-- Wake the worker the moment a job is queued: it LISTENs on provision_jobs
-- (apps/worker/internal/worker/notify.go) and keeps polling as the fallback.
-- NOTIFY is delivered on commit, so the worker never sees an uncommitted row.
CREATE OR REPLACE FUNCTION notify_provision_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('provision_jobs', NEW.id::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS provision_jobs_notify ON provision_jobs;
CREATE TRIGGER provision_jobs_notify
  AFTER INSERT ON provision_jobs
  FOR EACH ROW WHEN (NEW.status = 'queued')
  EXECUTE FUNCTION notify_provision_job();
