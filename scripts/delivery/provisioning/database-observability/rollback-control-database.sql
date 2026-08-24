\set ON_ERROR_STOP 1

BEGIN;

DROP FUNCTION IF EXISTS
  mira_dashboard_observability_capabilities.statement_metrics();
DROP FUNCTION IF EXISTS
  mira_dashboard_observability_capabilities.connection_metrics();

DO $revoke_reviewed_source$
DECLARE
  extension_oid oid;
  extension_member record;
BEGIN
  SELECT extensions.oid INTO extension_oid
  FROM pg_catalog.pg_extension AS extensions
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = extensions.extnamespace
    WHERE extensions.extname = 'pg_stat_statements'
      AND namespaces.nspname = 'public';
  IF extension_oid IS NULL THEN
    RAISE EXCEPTION 'pg_stat_statements rollback boundary is invalid';
  END IF;

  FOR extension_member IN
    SELECT namespaces.nspname, classes.relname
    FROM pg_catalog.pg_class AS classes
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    JOIN pg_catalog.pg_depend AS dependencies
      ON dependencies.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND dependencies.objid = classes.oid
     AND dependencies.objsubid = 0
     AND dependencies.refclassid =
        'pg_catalog.pg_extension'::pg_catalog.regclass
     AND dependencies.refobjid = extension_oid
     AND dependencies.deptype = 'e'
    ORDER BY classes.oid
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM mira_dashboard_observer, mira_dashboard_observability_owner, mira_dashboard_observability_capability_owner',
      extension_member.nspname,
      extension_member.relname
    );
  END LOOP;
  FOR extension_member IN
    SELECT routines.oid
    FROM pg_catalog.pg_proc AS routines
    JOIN pg_catalog.pg_depend AS dependencies
      ON dependencies.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
     AND dependencies.objid = routines.oid
     AND dependencies.objsubid = 0
     AND dependencies.refclassid =
        'pg_catalog.pg_extension'::pg_catalog.regclass
     AND dependencies.refobjid = extension_oid
     AND dependencies.deptype = 'e'
    ORDER BY routines.oid
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM mira_dashboard_observer, mira_dashboard_observability_owner, mira_dashboard_observability_capability_owner',
      extension_member.oid::pg_catalog.regprocedure
    );
  END LOOP;
END
$revoke_reviewed_source$;

COMMIT;
