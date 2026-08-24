\set ON_ERROR_STOP 1

BEGIN;

DO $guard$
BEGIN
  IF pg_catalog.current_database() NOT IN ('bitmagnet', 'comet') THEN
    RAISE EXCEPTION 'Database observability view target is not reviewed';
  END IF;
END
$guard$;

DROP VIEW IF EXISTS mira_dashboard_observability.torrent_count;
REVOKE SELECT ON TABLE public.torrents
  FROM mira_dashboard_observability_owner;

DO $drop_empty_schema$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS classes
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    WHERE namespaces.nspname = 'mira_dashboard_observability'
  ) THEN
    DROP SCHEMA IF EXISTS mira_dashboard_observability RESTRICT;
  END IF;
END
$drop_empty_schema$;

COMMIT;
