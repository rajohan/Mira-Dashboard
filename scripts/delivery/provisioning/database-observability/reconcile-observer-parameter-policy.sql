\set ON_ERROR_STOP 1

-- Advance the retained observer to the current five-setting role profile.
-- Roll back the setting unless the full current cluster policy verifies in the
-- same transaction.
BEGIN;

DO $qualify_observer_parameter_policy$
DECLARE
  observer pg_catalog.pg_authid%ROWTYPE;
BEGIN
  SELECT * INTO observer
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observer';
  IF observer.oid IS NULL
    OR observer.rolcanlogin
    OR NOT observer.rolinherit
    OR observer.rolsuper
    OR observer.rolcreatedb
    OR observer.rolcreaterole
    OR observer.rolreplication
    OR observer.rolbypassrls
    OR observer.rolconnlimit IS DISTINCT FROM 64
    OR observer.rolpassword IS NOT NULL
    OR observer.rolvaliduntil IS DISTINCT FROM
      '1970-01-01 00:00:00+00'::timestamp with time zone
    OR pg_catalog.shobj_description(observer.oid, 'pg_authid') IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting AS settings
      WHERE settings.setrole = observer.oid
        AND settings.setdatabase <> 0
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.usename = 'mira_dashboard_observer'
        AND activity.pid <> pg_catalog.pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION 'Database observability observer parameter policy is ineligible for reconciliation';
  END IF;
END
$qualify_observer_parameter_policy$;

GRANT SET ON PARAMETER pg_stat_statements.track
  TO mira_dashboard_observer;
ALTER ROLE mira_dashboard_observer
  SET pg_stat_statements.track = 'none';

\ir verify-cluster.sql

COMMIT;
