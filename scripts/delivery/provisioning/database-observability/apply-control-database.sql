\set ON_ERROR_STOP 1

BEGIN;

SET LOCAL mira_dashboard.apply_statement_capability
  TO :'apply_statement_capability';

DO $approval_guard$
DECLARE
  database_owner_oid oid;
  execution_role_oid oid;
  database_owner_is_superuser boolean;
BEGIN
  SELECT databases.datdba, owners.rolsuper
  INTO database_owner_oid, database_owner_is_superuser
  FROM pg_catalog.pg_database AS databases
  JOIN pg_catalog.pg_roles AS owners ON owners.oid = databases.datdba
  WHERE databases.datname = pg_catalog.current_database()
    AND databases.datname = 'mira_dashboard_observability'
    AND NOT databases.datistemplate
    AND databases.datallowconn;
  SELECT roles.oid INTO execution_role_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = CURRENT_USER;

  IF pg_catalog.current_setting(
      'mira_dashboard.apply_statement_capability',
      true
    ) IS DISTINCT FROM 'approved'
    OR database_owner_oid IS NULL
    OR execution_role_oid IS DISTINCT FROM database_owner_oid
    OR NOT database_owner_is_superuser
  THEN
    RAISE EXCEPTION 'Database observability control apply requires approval';
  END IF;
END
$approval_guard$;

DROP FUNCTION IF EXISTS
  mira_dashboard_observability_capabilities.statement_metrics();
DROP FUNCTION IF EXISTS
  mira_dashboard_observability_capabilities.connection_metrics();

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;

DO $reviewed_extension_boundary$
DECLARE
  database_owner_oid oid;
  extension_oid oid;
  extension_schema_oid oid;
  member_count bigint;
  source_routine pg_catalog.pg_proc%ROWTYPE;
  extension_member record;
BEGIN
  SELECT databases.datdba INTO database_owner_oid
  FROM pg_catalog.pg_database AS databases
  WHERE databases.datname = pg_catalog.current_database();
  SELECT extensions.oid, extensions.extnamespace
  INTO extension_oid, extension_schema_oid
  FROM pg_catalog.pg_extension AS extensions
  JOIN pg_catalog.pg_namespace AS namespaces
    ON namespaces.oid = extensions.extnamespace
  WHERE extensions.extname = 'pg_stat_statements'
    AND namespaces.nspname = 'public'
    AND extensions.extowner = database_owner_oid;

  SELECT pg_catalog.count(*) INTO member_count
  FROM pg_catalog.pg_depend AS dependencies
  WHERE dependencies.refclassid =
      'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependencies.refobjid = extension_oid
    AND dependencies.deptype = 'e'
    AND dependencies.objsubid = 0;

  IF database_owner_oid IS NULL
    OR extension_oid IS NULL
    OR member_count NOT BETWEEN 1 AND 64
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_depend AS dependencies
      WHERE dependencies.refclassid =
          'pg_catalog.pg_extension'::pg_catalog.regclass
        AND dependencies.refobjid = extension_oid
        AND dependencies.deptype = 'e'
        AND dependencies.objsubid = 0
        AND NOT (
          dependencies.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS classes
            JOIN pg_catalog.pg_extension AS extensions
              ON extensions.oid = extension_oid
             AND classes.relnamespace = extensions.extnamespace
            WHERE classes.oid = dependencies.objid
              AND classes.relkind = 'v'
              AND classes.relowner = database_owner_oid
          )
          OR dependencies.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS routines
            JOIN pg_catalog.pg_language AS languages
              ON languages.oid = routines.prolang
            WHERE routines.oid = dependencies.objid
              AND routines.pronamespace = extension_schema_oid
              AND routines.proowner = database_owner_oid
              AND routines.prokind = 'f'
              AND languages.lanname = 'c'
              AND routines.probin = '$libdir/pg_stat_statements'
              AND NOT routines.prosecdef
              AND NOT routines.proleakproof
          )
          OR dependencies.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
          AND EXISTS (
            SELECT 1
            FROM pg_catalog.pg_type AS types
            WHERE types.oid = dependencies.objid
              AND types.typnamespace = extension_schema_oid
              AND types.typowner = database_owner_oid
              AND (
                types.typtype = 'c'
                AND EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_class AS classes
                  WHERE classes.oid = types.typrelid
                    AND classes.relnamespace = extension_schema_oid
                    AND classes.relkind = 'v'
                )
                OR types.typtype = 'b'
                AND types.typcategory = 'A'
                AND EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_type AS elements
                  JOIN pg_catalog.pg_depend AS element_dependencies
                    ON element_dependencies.classid =
                      'pg_catalog.pg_type'::pg_catalog.regclass
                   AND element_dependencies.objid = elements.oid
                   AND element_dependencies.objsubid = 0
                   AND element_dependencies.refclassid =
                      'pg_catalog.pg_extension'::pg_catalog.regclass
                   AND element_dependencies.refobjid = extension_oid
                   AND element_dependencies.deptype = 'e'
                  WHERE elements.oid = types.typelem
                    AND elements.typtype = 'c'
                )
              )
          )
        )
    )
  THEN
    RAISE EXCEPTION 'pg_stat_statements reviewed extension boundary is invalid';
  END IF;

  SELECT routines.* INTO source_routine
  FROM pg_catalog.pg_proc AS routines
  JOIN pg_catalog.pg_depend AS dependencies
    ON dependencies.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
   AND dependencies.objid = routines.oid
   AND dependencies.objsubid = 0
   AND dependencies.refclassid =
      'pg_catalog.pg_extension'::pg_catalog.regclass
   AND dependencies.refobjid = extension_oid
   AND dependencies.deptype = 'e'
  WHERE routines.pronamespace = extension_schema_oid
    AND routines.proname = 'pg_stat_statements'
    AND routines.pronargs = 1
    AND routines.proargtypes =
      ARRAY['pg_catalog.bool'::pg_catalog.regtype]::oidvector;

  IF source_routine.oid IS NULL
    OR source_routine.proowner <> database_owner_oid
    OR source_routine.prokind <> 'f'
    OR source_routine.probin <> '$libdir/pg_stat_statements'
    OR source_routine.prosecdef
    OR source_routine.proleakproof
    OR source_routine.prorettype <> 'pg_catalog.record'::pg_catalog.regtype
    OR NOT source_routine.proretset
    OR EXISTS (
      SELECT 1
      FROM (VALUES
        ('dbid'::text, 'pg_catalog.oid'::pg_catalog.regtype),
        ('userid'::text, 'pg_catalog.oid'::pg_catalog.regtype),
        ('queryid'::text, 'pg_catalog.int8'::pg_catalog.regtype),
        ('calls'::text, 'pg_catalog.int8'::pg_catalog.regtype),
        ('total_exec_time'::text, 'pg_catalog.float8'::pg_catalog.regtype),
        ('mean_exec_time'::text, 'pg_catalog.float8'::pg_catalog.regtype),
        ('rows'::text, 'pg_catalog.int8'::pg_catalog.regtype),
        ('shared_blks_hit'::text, 'pg_catalog.int8'::pg_catalog.regtype),
        ('shared_blks_read'::text, 'pg_catalog.int8'::pg_catalog.regtype)
      ) AS required(field_name, field_type)
      WHERE (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.generate_subscripts(
          source_routine.proallargtypes,
          1
        ) AS positions(position)
        WHERE source_routine.proargnames[positions.position] = required.field_name
          AND source_routine.proargmodes[positions.position] = 'o'
          AND source_routine.proallargtypes[positions.position] = required.field_type
      ) <> 1
    )
  THEN
    RAISE EXCEPTION 'pg_stat_statements reviewed source shape is invalid';
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
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, mira_dashboard_observer, mira_dashboard_observability_owner, mira_dashboard_observability_capability_owner, pg_read_all_stats',
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
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, mira_dashboard_observer, mira_dashboard_observability_owner, mira_dashboard_observability_capability_owner, pg_read_all_stats',
      extension_member.oid::pg_catalog.regprocedure
    );
  END LOOP;

  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION %s TO mira_dashboard_observability_capability_owner',
    source_routine.oid::pg_catalog.regprocedure
  );
END
$reviewed_extension_boundary$;

DO $capability_schema_boundary$
DECLARE
  capability_owner_oid oid;
  capability_schema_oid oid;
  view_owner_oid oid;
BEGIN
  SELECT roles.oid INTO capability_owner_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observability_capability_owner';
  SELECT roles.oid INTO view_owner_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observability_owner';
  SELECT namespaces.oid INTO capability_schema_oid
  FROM pg_catalog.pg_namespace AS namespaces
  WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities';

  IF capability_owner_oid IS NULL
    OR view_owner_oid IS NULL
    OR capability_schema_oid IS NULL
    OR (SELECT namespaces.nspowner
        FROM pg_catalog.pg_namespace AS namespaces
        WHERE namespaces.oid = capability_schema_oid)
      IS DISTINCT FROM view_owner_oid
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS classes
      WHERE classes.relnamespace = capability_schema_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_type AS types
      WHERE types.typnamespace = capability_schema_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS routines
      WHERE routines.pronamespace = capability_schema_oid
        AND NOT (
          routines.pronargs = 0
          AND routines.proowner = capability_owner_oid
          AND routines.proname IN ('table_health', 'maintenance_metrics')
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability control capability boundary is invalid';
  END IF;
END
$capability_schema_boundary$;

CREATE FUNCTION mira_dashboard_observability_capabilities.connection_metrics()
RETURNS TABLE (
  active_connections bigint,
  idle_connections bigint,
  total_connections bigint
)
LANGUAGE sql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
ROWS 1
SET search_path TO pg_catalog, pg_temp
SET statement_timeout TO '5s'
BEGIN ATOMIC
  WITH observed_databases AS MATERIALIZED (
    SELECT databases.datname
    FROM pg_catalog.pg_database AS databases
    WHERE NOT databases.datistemplate
      AND databases.datallowconn
  ), bounded_databases AS (
    SELECT pg_catalog.array_agg(
             observed_databases.datname ORDER BY observed_databases.datname
           ) AS database_names
    FROM observed_databases
    HAVING pg_catalog.count(*) <= 64
  )
  SELECT pg_catalog.count(activity.pid) FILTER (
           WHERE activity.state = 'active'
         )::bigint AS active_connections,
         pg_catalog.count(activity.pid) FILTER (
           WHERE activity.state = 'idle'
         )::bigint AS idle_connections,
         pg_catalog.count(activity.pid)::bigint AS total_connections
  FROM bounded_databases
  LEFT JOIN pg_catalog.pg_stat_activity AS activity
    ON activity.backend_type = 'client backend'
   AND activity.datname = ANY(bounded_databases.database_names)
  GROUP BY bounded_databases.database_names;
END;

ALTER FUNCTION mira_dashboard_observability_capabilities.connection_metrics()
  OWNER TO mira_dashboard_observability_capability_owner;

CREATE FUNCTION mira_dashboard_observability_capabilities.statement_metrics()
RETURNS TABLE (
  calls bigint,
  total_execution_ms double precision,
  mean_execution_ms double precision,
  rows bigint,
  shared_blocks_hit bigint,
  shared_blocks_read bigint
)
LANGUAGE sql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
ROWS 20
SET search_path TO pg_catalog, pg_temp
SET statement_timeout TO '5s'
BEGIN ATOMIC
  WITH observed_databases AS MATERIALIZED (
    SELECT databases.oid, databases.datname
    FROM pg_catalog.pg_database AS databases
    WHERE NOT databases.datistemplate
      AND databases.datallowconn
  ), bounded_databases AS MATERIALIZED (
    SELECT pg_catalog.array_agg(
             observed_databases.oid ORDER BY observed_databases.datname
           ) AS database_oids
    FROM observed_databases
    HAVING pg_catalog.count(*) <= 64
  )
  SELECT statements.calls::bigint,
         statements.total_exec_time::double precision AS total_execution_ms,
         statements.mean_exec_time::double precision AS mean_execution_ms,
         statements.rows::bigint,
         statements.shared_blks_hit::bigint,
         statements.shared_blks_read::bigint
  FROM bounded_databases
  JOIN public.pg_stat_statements(false) AS statements
    ON statements.dbid = ANY(bounded_databases.database_oids)
  ORDER BY statements.total_exec_time DESC,
           statements.calls DESC,
           statements.rows DESC,
           statements.dbid,
           statements.userid,
           statements.queryid
  LIMIT 20;
END;

ALTER FUNCTION mira_dashboard_observability_capabilities.statement_metrics()
  OWNER TO mira_dashboard_observability_capability_owner;

REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_observability_capabilities.connection_metrics() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_observability_capabilities.connection_metrics()
  FROM mira_dashboard_observer;
GRANT EXECUTE ON FUNCTION
  mira_dashboard_observability_capabilities.connection_metrics()
  TO mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_observability_capabilities.statement_metrics() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_observability_capabilities.statement_metrics()
  FROM mira_dashboard_observer;
GRANT EXECUTE ON FUNCTION
  mira_dashboard_observability_capabilities.statement_metrics()
  TO mira_dashboard_observer;

COMMIT;

\ir verify-control-database.sql
