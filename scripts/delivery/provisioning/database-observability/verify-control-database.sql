\set ON_ERROR_STOP 1

\ir verify-database-capabilities.sql

DO $verify_control_capabilities$
DECLARE
  observer_oid oid;
  capability_owner_oid oid;
  view_owner_oid oid;
  database_owner_oid oid;
  extension_oid oid;
  source_routine pg_catalog.pg_proc%ROWTYPE;
  connection_metrics pg_catalog.pg_proc%ROWTYPE;
  statement_metrics pg_catalog.pg_proc%ROWTYPE;
  extension_schema_oid oid;
  member_count bigint;
BEGIN
  SELECT roles.oid INTO observer_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observer';
  SELECT roles.oid INTO capability_owner_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observability_capability_owner';
  SELECT roles.oid INTO view_owner_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observability_owner';
  SELECT databases.datdba INTO database_owner_oid
  FROM pg_catalog.pg_database AS databases
  WHERE databases.datname = pg_catalog.current_database()
    AND databases.datname = 'mira_dashboard_observability'
    AND NOT databases.datistemplate
    AND databases.datallowconn;
  SELECT extensions.oid, extensions.extnamespace
  INTO extension_oid, extension_schema_oid
  FROM pg_catalog.pg_extension AS extensions
  JOIN pg_catalog.pg_namespace AS namespaces
    ON namespaces.oid = extensions.extnamespace
  WHERE extensions.extname = 'pg_stat_statements'
    AND namespaces.nspname = 'public'
    AND extensions.extowner = database_owner_oid;

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
  SELECT routines.* INTO connection_metrics
  FROM pg_catalog.pg_proc AS routines
  WHERE routines.oid =
    'mira_dashboard_observability_capabilities.connection_metrics()'
      ::pg_catalog.regprocedure;
  SELECT routines.* INTO statement_metrics
  FROM pg_catalog.pg_proc AS routines
  WHERE routines.oid =
    'mira_dashboard_observability_capabilities.statement_metrics()'
      ::pg_catalog.regprocedure;

  SELECT pg_catalog.count(*) INTO member_count
  FROM pg_catalog.pg_depend AS dependencies
  WHERE dependencies.refclassid =
      'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependencies.refobjid = extension_oid
    AND dependencies.deptype = 'e'
    AND dependencies.objsubid = 0;

  IF observer_oid IS NULL
    OR capability_owner_oid IS NULL
    OR view_owner_oid IS NULL
    OR database_owner_oid IS NULL
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
            SELECT 1 FROM pg_catalog.pg_class AS classes
            JOIN pg_catalog.pg_extension AS extensions
              ON extensions.oid = extension_oid
             AND classes.relnamespace = extensions.extnamespace
            WHERE classes.oid = dependencies.objid
              AND classes.relkind = 'v'
              AND classes.relowner = database_owner_oid
          )
          OR dependencies.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_proc AS routines
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
            SELECT 1 FROM pg_catalog.pg_type AS types
            WHERE types.oid = dependencies.objid
              AND types.typnamespace = extension_schema_oid
              AND types.typowner = database_owner_oid
              AND (
                types.typtype = 'c'
                AND EXISTS (
                  SELECT 1 FROM pg_catalog.pg_class AS classes
                  WHERE classes.oid = types.typrelid
                    AND classes.relnamespace = extension_schema_oid
                    AND classes.relkind = 'v'
                )
                OR types.typtype = 'b'
                AND types.typcategory = 'A'
                AND EXISTS (
                  SELECT 1 FROM pg_catalog.pg_type AS elements
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
    OR source_routine.oid IS NULL
    OR source_routine.proowner IS DISTINCT FROM database_owner_oid
    OR source_routine.prolang IS DISTINCT FROM (
      SELECT languages.oid FROM pg_catalog.pg_language AS languages
      WHERE languages.lanname = 'c'
    )
    OR source_routine.probin <> '$libdir/pg_stat_statements'
    OR source_routine.prosecdef
    OR source_routine.proleakproof
    OR source_routine.pronargs <> 1
    OR source_routine.proargtypes <>
      ARRAY['pg_catalog.bool'::pg_catalog.regtype]::oidvector
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

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS source_relations
    JOIN pg_catalog.pg_depend AS dependencies
      ON dependencies.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND dependencies.objid = source_relations.oid
     AND dependencies.objsubid = 0
     AND dependencies.refclassid =
        'pg_catalog.pg_extension'::pg_catalog.regclass
     AND dependencies.refobjid = extension_oid
     AND dependencies.deptype = 'e'
    WHERE pg_catalog.has_table_privilege(
      observer_oid,
      source_relations.oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    )
      OR pg_catalog.has_table_privilege(
        capability_owner_oid,
        source_relations.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      )
      OR pg_catalog.has_table_privilege(
        view_owner_oid,
        source_relations.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      )
      OR pg_catalog.has_table_privilege(
        'pg_read_all_stats',
        source_relations.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(COALESCE(
          source_relations.relacl,
          pg_catalog.acldefault(
            'r',
            source_relations.relowner
          )
        )) AS grants
        WHERE grants.grantee = 0
      )
  )
    OR NOT pg_catalog.has_function_privilege(
      capability_owner_oid,
      source_routine.oid,
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(observer_oid, source_routine.oid, 'EXECUTE')
    OR pg_catalog.has_function_privilege(view_owner_oid, source_routine.oid, 'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'pg_read_all_stats',
      source_routine.oid,
      'EXECUTE'
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
        source_routine.proacl,
        pg_catalog.acldefault('f', source_routine.proowner)
      )) AS grants
      WHERE grants.grantee = 0 AND grants.privilege_type = 'EXECUTE'
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.aclexplode(source_routine.proacl) AS grants
    ) <> 2
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(source_routine.proacl) AS grants
      WHERE grants.grantor <> database_owner_oid
        OR grants.is_grantable
        OR grants.privilege_type <> 'EXECUTE'
        OR grants.grantee NOT IN (database_owner_oid, capability_owner_oid)
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routines
      JOIN pg_catalog.pg_depend AS dependencies
        ON dependencies.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
       AND dependencies.objid = routines.oid
       AND dependencies.objsubid = 0
       AND dependencies.refclassid =
         'pg_catalog.pg_extension'::pg_catalog.regclass
       AND dependencies.refobjid = extension_oid
       AND dependencies.deptype = 'e'
      WHERE routines.oid <> source_routine.oid
        AND (
          pg_catalog.has_function_privilege(
            observer_oid,
            routines.oid,
            'EXECUTE'
          )
          OR pg_catalog.has_function_privilege(
            capability_owner_oid,
            routines.oid,
            'EXECUTE'
          )
          OR pg_catalog.has_function_privilege(
            view_owner_oid,
            routines.oid,
            'EXECUTE'
          )
          OR pg_catalog.has_function_privilege(
            'pg_read_all_stats',
            routines.oid,
            'EXECUTE'
          )
          OR EXISTS (
            SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
              routines.proacl,
              pg_catalog.acldefault('f', routines.proowner)
            )) AS grants
            WHERE grants.grantee = 0
              AND grants.privilege_type = 'EXECUTE'
          )
        )
    )
  THEN
    RAISE EXCEPTION 'pg_stat_statements source ACL is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      (
        connection_metrics.oid,
        1::real,
        'TABLE(active_connections bigint, idle_connections bigint, total_connections bigint)',
        'e7dd5805171b451837fda6aefad1f8f71e3ada90424d296fc4aed746005ab638'
      ),
      (
        statement_metrics.oid,
        20::real,
        'TABLE(calls bigint, total_execution_ms double precision, mean_execution_ms double precision, rows bigint, shared_blocks_hit bigint, shared_blocks_read bigint)',
        'e96e15f965236535b5d8901c5fea3422c663f6c7858517b840dab82d66910e9e'
      )
    ) AS expected(oid, rows, result_shape, body_hash)
    JOIN pg_catalog.pg_proc AS routines ON routines.oid = expected.oid
    WHERE routines.proowner <> capability_owner_oid
      OR routines.prolang <> (
        SELECT languages.oid FROM pg_catalog.pg_language AS languages
        WHERE languages.lanname = 'sql'
      )
      OR routines.prokind <> 'f'
      OR routines.pronargs <> 0
      OR routines.prorettype <> 'pg_catalog.record'::pg_catalog.regtype
      OR NOT routines.proretset
      OR routines.provolatile <> 'v'
      OR routines.proparallel <> 'u'
      OR NOT routines.prosecdef
      OR routines.proleakproof
      OR routines.proisstrict
      OR routines.prosrc <> ''
      OR pg_catalog.pg_get_function_sqlbody(routines.oid) IS NULL
      OR routines.prorows <> expected.rows
      OR routines.proconfig <> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'statement_timeout=5s'
      ]::text[]
      OR pg_catalog.pg_get_function_result(routines.oid) <> expected.result_shape
      OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.pg_get_function_sqlbody(routines.oid),
        'UTF8'
      )), 'hex') <> expected.body_hash
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.aclexplode(routines.proacl) AS grants
      ) <> 2
      OR EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(routines.proacl) AS grants
        WHERE grants.grantor <> capability_owner_oid
          OR grants.is_grantable
          OR grants.privilege_type <> 'EXECUTE'
          OR grants.grantee NOT IN (capability_owner_oid, observer_oid)
      )
  )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_depend AS dependencies
      WHERE dependencies.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependencies.objid = statement_metrics.oid
        AND dependencies.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependencies.refobjid = source_routine.oid
        AND dependencies.deptype = 'n'
    ) <> 1
  THEN
    RAISE EXCEPTION 'Database observability control capability is invalid';
  END IF;
END
$verify_control_capabilities$;
