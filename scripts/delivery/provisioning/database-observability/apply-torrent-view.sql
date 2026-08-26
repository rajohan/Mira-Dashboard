\set ON_ERROR_STOP 1

BEGIN;

DO $guard$
BEGIN
  IF pg_catalog.current_database() NOT IN ('bitmagnet', 'comet') THEN
    RAISE EXCEPTION 'Database observability view target is not reviewed';
  END IF;
END
$guard$;

DO $schema_boundary$
DECLARE
  owner_oid oid;
  schema_oid oid;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observability_owner';
  SELECT oid INTO schema_oid FROM pg_catalog.pg_namespace
  WHERE nspname = 'mira_dashboard_observability';
  IF schema_oid IS NOT NULL
    AND (
      (SELECT nspowner FROM pg_catalog.pg_namespace WHERE oid = schema_oid)
        IS DISTINCT FROM owner_oid
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_class
        WHERE relnamespace = schema_oid
          AND relname NOT IN ('statement_metrics', 'torrent_count')
      )
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_class
        WHERE relnamespace = schema_oid
          AND relname IN ('statement_metrics', 'torrent_count')
          AND (
            relkind <> 'v'
            OR relowner IS DISTINCT FROM owner_oid
          )
      )
    )
  THEN
    RAISE EXCEPTION 'Database observability schema boundary is invalid';
  END IF;
END
$schema_boundary$;

CREATE SCHEMA IF NOT EXISTS mira_dashboard_observability
  AUTHORIZATION mira_dashboard_observability_owner;
REVOKE ALL PRIVILEGES ON SCHEMA mira_dashboard_observability FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA mira_dashboard_observability
  FROM mira_dashboard_observer;
GRANT USAGE ON SCHEMA mira_dashboard_observability
  TO mira_dashboard_observer;

GRANT SELECT ON TABLE public.torrents
  TO mira_dashboard_observability_owner;
REVOKE ALL PRIVILEGES ON TABLE public.torrents
  FROM mira_dashboard_observer;

SET LOCAL ROLE mira_dashboard_observability_owner;
DROP VIEW IF EXISTS mira_dashboard_observability.statement_metrics;
CREATE OR REPLACE VIEW mira_dashboard_observability.torrent_count
  WITH (security_barrier = true)
AS
SELECT pg_catalog.count(*)::bigint AS count
FROM public.torrents;
RESET ROLE;

ALTER VIEW mira_dashboard_observability.torrent_count
  OWNER TO mira_dashboard_observability_owner;
REVOKE ALL PRIVILEGES ON TABLE mira_dashboard_observability.torrent_count
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE mira_dashboard_observability.torrent_count
  FROM mira_dashboard_observer;
GRANT SELECT ON TABLE mira_dashboard_observability.torrent_count
  TO mira_dashboard_observer;

DO $exact_acl$
DECLARE
  observer_oid oid;
  owner_oid oid;
  schema_oid oid;
  view_oid oid;
BEGIN
  SELECT oid INTO observer_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observer';
  SELECT oid INTO owner_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observability_owner';
  SELECT oid INTO schema_oid
  FROM pg_catalog.pg_namespace
  WHERE nspname = 'mira_dashboard_observability';
  SELECT classes.oid INTO view_oid
  FROM pg_catalog.pg_class AS classes
  WHERE classes.relnamespace = schema_oid
    AND classes.relname = 'torrent_count'
    AND classes.relkind = 'v';

  IF observer_oid IS NULL
    OR owner_oid IS NULL
    OR schema_oid IS NULL
    OR view_oid IS NULL
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.aclexplode(
        COALESCE(
          (SELECT nspacl FROM pg_catalog.pg_namespace WHERE oid = schema_oid),
          pg_catalog.acldefault('n', owner_oid)
        )
      ) AS grants
    ) <> 3
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(
          (SELECT nspacl FROM pg_catalog.pg_namespace WHERE oid = schema_oid),
          pg_catalog.acldefault('n', owner_oid)
        )
      ) AS grants
      WHERE NOT (
        grants.grantee = owner_oid
          AND grants.privilege_type IN ('CREATE', 'USAGE')
          AND NOT grants.is_grantable
        OR grants.grantee = observer_oid
          AND grants.privilege_type = 'USAGE'
          AND NOT grants.is_grantable
      )
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.aclexplode(
        COALESCE(
          (SELECT relacl FROM pg_catalog.pg_class WHERE oid = view_oid),
          pg_catalog.acldefault('r', owner_oid)
        )
      ) AS grants
    ) <> 9
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(
          (SELECT relacl FROM pg_catalog.pg_class WHERE oid = view_oid),
          pg_catalog.acldefault('r', owner_oid)
        )
      ) AS grants
      WHERE NOT (
        grants.grantee = owner_oid
          AND grants.privilege_type IN (
            'SELECT',
            'INSERT',
            'UPDATE',
            'DELETE',
            'MAINTAIN',
            'TRUNCATE',
            'REFERENCES',
            'TRIGGER'
          )
          AND NOT grants.is_grantable
        OR grants.grantee = observer_oid
          AND grants.privilege_type = 'SELECT'
          AND NOT grants.is_grantable
      )
    )
  THEN
    RAISE EXCEPTION 'Database observability ACL is not exact';
  END IF;
END
$exact_acl$;

COMMIT;
