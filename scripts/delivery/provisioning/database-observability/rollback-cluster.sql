\set ON_ERROR_STOP 1

ALTER ROLE mira_dashboard_observer NOLOGIN;
ALTER ROLE mira_dashboard_observer PASSWORD NULL;
ALTER ROLE mira_dashboard_observability_capability_owner NOLOGIN;
ALTER ROLE mira_dashboard_observability_capability_owner PASSWORD NULL;

DO $terminate_observer_sessions$
DECLARE
  observer_session record;
BEGIN
  FOR observer_session IN
    SELECT activity.pid
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.usename IN (
      'mira_dashboard_observer',
      'mira_dashboard_observability_capability_owner'
    )
      AND activity.pid <> pg_catalog.pg_backend_pid()
  LOOP
    IF NOT pg_catalog.pg_terminate_backend(observer_session.pid, 5000) THEN
      RAISE EXCEPTION 'Database observability observer session could not be terminated';
    END IF;
  END LOOP;
  PERFORM pg_catalog.pg_stat_clear_snapshot();
END
$terminate_observer_sessions$;

BEGIN;

REVOKE pg_monitor FROM mira_dashboard_observer;
REVOKE pg_read_all_stats FROM mira_dashboard_observer;
REVOKE SET ON PARAMETER pg_stat_statements.track
  FROM mira_dashboard_observer;
REVOKE pg_monitor FROM mira_dashboard_observability_capability_owner;
REVOKE pg_read_all_stats FROM mira_dashboard_observability_capability_owner;

-- `rollback-control-database.sql` and the optional torrent-view rollbacks must
-- remove every owned object and source grant before either reserved role drops.
DROP ROLE mira_dashboard_observer;
DROP ROLE mira_dashboard_observability_capability_owner;
DROP ROLE mira_dashboard_observability_owner;

COMMIT;
