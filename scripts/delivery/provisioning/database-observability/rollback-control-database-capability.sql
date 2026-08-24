\set ON_ERROR_STOP 1

-- The physical capability database is deliberately retained. DROP DATABASE is
-- not an acceptable generic rollback for an object that may have acquired data.
-- The preceding control/access rollbacks must leave only the reviewed extension.
REVOKE ALL PRIVILEGES ON DATABASE mira_dashboard_observability FROM PUBLIC;

\ir verify-control-database-capability.sql

DO $verify_safe_retention$
DECLARE
  extension_names text[];
BEGIN
  SELECT pg_catalog.array_agg(extensions.extname::text ORDER BY extensions.extname)
  INTO extension_names
  FROM pg_catalog.pg_extension AS extensions;

  IF pg_catalog.current_database() <> 'mira_dashboard_observability'
    OR extension_names IS DISTINCT FROM ARRAY[
      'pg_stat_statements',
      'plpgsql'
    ]::text[]
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace AS namespaces
      WHERE namespaces.nspname NOT IN (
        'information_schema',
        'pg_catalog',
        'public'
      )
        AND namespaces.nspname NOT LIKE 'pg_toast%'
        AND namespaces.nspname NOT LIKE 'pg_temp_%'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS classes
      JOIN pg_catalog.pg_namespace AS namespaces
        ON namespaces.oid = classes.relnamespace
      WHERE namespaces.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS dependencies
          JOIN pg_catalog.pg_extension AS extensions
            ON dependencies.refclassid =
              'pg_catalog.pg_extension'::pg_catalog.regclass
           AND dependencies.refobjid = extensions.oid
          WHERE dependencies.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND dependencies.objid = classes.oid
            AND dependencies.objsubid = 0
            AND dependencies.deptype = 'e'
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability control database is not safe to retain';
  END IF;

END
$verify_safe_retention$;
