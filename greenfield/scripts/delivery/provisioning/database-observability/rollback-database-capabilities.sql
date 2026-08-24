\set ON_ERROR_STOP 1

BEGIN;

REVOKE ALL PRIVILEGES ON TABLE pg_catalog.pg_statistic
  FROM mira_dashboard_observability_capability_owner;
ALTER DEFAULT PRIVILEGES
  FOR ROLE mira_dashboard_observability_capability_owner
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

DROP FUNCTION IF EXISTS
  mira_dashboard_observability_capabilities.table_health();
DROP FUNCTION IF EXISTS
  mira_dashboard_observability_capabilities.maintenance_metrics();

DO $drop_empty_capability_schema$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespaces
    WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities'
  )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS classes
      JOIN pg_catalog.pg_namespace AS namespaces
        ON namespaces.oid = classes.relnamespace
      WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routines
      JOIN pg_catalog.pg_namespace AS namespaces
        ON namespaces.oid = routines.pronamespace
      WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type AS types
      JOIN pg_catalog.pg_namespace AS namespaces
        ON namespaces.oid = types.typnamespace
      WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities'
    )
  THEN
    DROP SCHEMA mira_dashboard_observability_capabilities RESTRICT;
  END IF;
END
$drop_empty_capability_schema$;

COMMIT;
