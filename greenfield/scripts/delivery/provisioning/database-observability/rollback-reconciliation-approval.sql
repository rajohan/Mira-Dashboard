\set ON_ERROR_STOP 1

BEGIN;

DO $rollback_approval_boundary$
DECLARE
  administrator_oid oid;
  approval_oid oid;
  approval_schema_oid oid;
BEGIN
  SELECT databases.datdba INTO administrator_oid
  FROM pg_catalog.pg_database AS databases
  JOIN pg_catalog.pg_roles AS owners ON owners.oid = databases.datdba
  WHERE databases.datname = pg_catalog.current_database()
    AND databases.datname = 'mira_dashboard_observability'
    AND owners.rolname = CURRENT_USER
    AND owners.rolsuper;
  SELECT namespaces.oid INTO approval_schema_oid
  FROM pg_catalog.pg_namespace AS namespaces
  WHERE namespaces.nspname = 'mira_dashboard_observability_control'
    AND namespaces.nspowner = administrator_oid;
  SELECT classes.oid INTO approval_oid
  FROM pg_catalog.pg_class AS classes
  WHERE classes.relnamespace = approval_schema_oid
    AND classes.relname = 'reconciliation_approval'
    AND classes.relkind = 'r'
    AND classes.relowner = administrator_oid;
  IF administrator_oid IS NULL
    OR approval_schema_oid IS NULL
    OR approval_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class AS classes
        WHERE classes.relnamespace = approval_schema_oid) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS indexes
        WHERE indexes.indrelid = approval_oid
          AND indexes.indisprimary
          AND indexes.indisunique
          AND indexes.indisvalid) <> 1
    OR (SELECT pg_catalog.array_agg(attributes.attname::text
          ORDER BY attributes.attnum)
        FROM pg_catalog.pg_attribute AS attributes
        WHERE attributes.attrelid = approval_oid
          AND attributes.attnum > 0
          AND NOT attributes.attisdropped) IS DISTINCT FROM ARRAY[
            'singleton',
            'policy_version',
            'system_identifier',
            'current_policy_digest',
            'previous_policy_digest'
          ]::text[]
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS triggers
      WHERE triggers.tgrelid = approval_oid AND NOT triggers.tgisinternal
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_rewrite AS rules
      WHERE rules.ev_class = approval_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policies
      WHERE policies.polrelid = approval_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS routines
      WHERE routines.pronamespace = approval_schema_oid
    )
    OR (SELECT pg_catalog.count(*)
        FROM mira_dashboard_observability_control.reconciliation_approval) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM mira_dashboard_observability_control.reconciliation_approval AS approval
      CROSS JOIN pg_catalog.pg_control_system() AS controls
      WHERE approval.singleton
        AND approval.policy_version = 'sanitized-capabilities-v1'
        AND approval.system_identifier = controls.system_identifier
        AND approval.current_policy_digest ~ '^[0-9a-f]{64}$'
        AND (
          approval.previous_policy_digest IS NULL
          OR approval.previous_policy_digest ~ '^[0-9a-f]{64}$'
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability reconciliation approval rollback boundary is invalid';
  END IF;
END
$rollback_approval_boundary$;

DROP TABLE mira_dashboard_observability_control.reconciliation_approval;
DROP SCHEMA mira_dashboard_observability_control RESTRICT;

COMMIT;
