\set ON_ERROR_STOP 1

ALTER ROLE mira_dashboard_observer NOLOGIN;
ALTER ROLE mira_dashboard_observer PASSWORD NULL;

DO $terminate_observer_sessions$
DECLARE
  observer_session record;
BEGIN
  FOR observer_session IN
    SELECT activity.pid
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.usename = 'mira_dashboard_observer'
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

REVOKE ALL PRIVILEGES ON DATABASE aiomanager FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE aiometadata FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE aiostreams FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE authelia FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE bitmagnet FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE comet FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE crowdsec FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE metabase FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE postgres FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE speedtest_tracker FROM mira_dashboard_observer;

DROP ROLE mira_dashboard_observer;
DROP ROLE mira_dashboard_observability_owner;

COMMIT;
