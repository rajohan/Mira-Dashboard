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
DROP SCHEMA IF EXISTS mira_dashboard_observability RESTRICT;
REVOKE SELECT ON TABLE public.torrents
  FROM mira_dashboard_observability_owner;

COMMIT;
