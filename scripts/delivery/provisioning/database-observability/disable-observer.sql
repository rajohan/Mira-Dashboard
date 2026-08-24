\set ON_ERROR_STOP 1

-- Disable new authentication before clearing the password or terminating
-- already-authenticated sessions. Each statement autocommits independently so
-- a later termination failure cannot restore LOGIN.
ALTER ROLE mira_dashboard_observer NOLOGIN;
ALTER ROLE mira_dashboard_observer
  VALID UNTIL '1970-01-01 00:00:00+00';
ALTER ROLE mira_dashboard_observer PASSWORD NULL;

DO $terminate_observability_sessions$
DECLARE
  observability_session record;
BEGIN
  FOR observability_session IN
    SELECT activity.pid
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.usename = 'mira_dashboard_observer'
      AND activity.pid <> pg_catalog.pg_backend_pid()
  LOOP
    IF NOT pg_catalog.pg_terminate_backend(observability_session.pid, 5000) THEN
      RAISE EXCEPTION 'Database observability session could not be terminated';
    END IF;
  END LOOP;

  PERFORM pg_catalog.pg_stat_clear_snapshot();

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.usename = 'mira_dashboard_observer'
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'Database observability session remains active';
  END IF;
END
$terminate_observability_sessions$;
