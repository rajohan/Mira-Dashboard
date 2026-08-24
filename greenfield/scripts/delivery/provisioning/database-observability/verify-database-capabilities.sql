\set ON_ERROR_STOP 1

DO $verify_database_capabilities$
DECLARE
  observer_oid oid;
  capability_owner_oid oid;
  view_owner_oid oid;
  capability_schema_oid oid;
  table_health pg_catalog.pg_proc%ROWTYPE;
  maintenance_metrics pg_catalog.pg_proc%ROWTYPE;
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
  SELECT namespaces.oid INTO capability_schema_oid
  FROM pg_catalog.pg_namespace AS namespaces
  WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities';

  SELECT routines.* INTO table_health
  FROM pg_catalog.pg_proc AS routines
  WHERE routines.pronamespace = capability_schema_oid
    AND routines.proname = 'table_health'
    AND routines.pronargs = 0;
  SELECT routines.* INTO maintenance_metrics
  FROM pg_catalog.pg_proc AS routines
  WHERE routines.pronamespace = capability_schema_oid
    AND routines.proname = 'maintenance_metrics'
    AND routines.pronargs = 0;

  IF observer_oid IS NULL
    OR capability_owner_oid IS NULL
    OR view_owner_oid IS NULL
    OR capability_schema_oid IS NULL
    OR (SELECT namespaces.nspowner
        FROM pg_catalog.pg_namespace AS namespaces
        WHERE namespaces.oid = capability_schema_oid)
      IS DISTINCT FROM view_owner_oid
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS classes
      WHERE classes.relnamespace = capability_schema_oid
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type AS types
      WHERE types.typnamespace = capability_schema_oid
    )
    OR NOT (
      (SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS routines
       WHERE routines.pronamespace = capability_schema_oid) = CASE
        WHEN pg_catalog.current_database() = 'mira_dashboard_observability'
        THEN 4
        ELSE 2
      END
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routines
      WHERE routines.pronamespace = capability_schema_oid
        AND routines.proname NOT IN ('table_health', 'maintenance_metrics')
        AND NOT (
          pg_catalog.current_database() = 'mira_dashboard_observability'
          AND routines.proname IN ('connection_metrics', 'statement_metrics')
          AND routines.pronargs = 0
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability capability schema is invalid';
  END IF;

  IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.aclexplode(
        (SELECT namespaces.nspacl
         FROM pg_catalog.pg_namespace AS namespaces
         WHERE namespaces.oid = capability_schema_oid)
      ) AS grants
    ) IS DISTINCT FROM 4
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        (SELECT namespaces.nspacl
         FROM pg_catalog.pg_namespace AS namespaces
         WHERE namespaces.oid = capability_schema_oid)
      ) AS grants
      WHERE grants.grantor IS DISTINCT FROM view_owner_oid
        OR grants.is_grantable
        OR NOT (
          grants.grantee = view_owner_oid
            AND grants.privilege_type IN ('CREATE', 'USAGE')
          OR grants.grantee = capability_owner_oid
            AND grants.privilege_type = 'USAGE'
          OR grants.grantee = observer_oid
            AND grants.privilege_type = 'USAGE'
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability capability schema ACL is invalid';
  END IF;

  IF table_health.oid IS NULL
    OR table_health.proowner IS DISTINCT FROM capability_owner_oid
    OR table_health.prolang IS DISTINCT FROM (
      SELECT languages.oid
      FROM pg_catalog.pg_language AS languages
      WHERE languages.lanname = 'sql'
    )
    OR table_health.prorettype IS DISTINCT FROM
      'pg_catalog.record'::pg_catalog.regtype
    OR table_health.prokind IS DISTINCT FROM 'f'
    OR table_health.provolatile IS DISTINCT FROM 'v'
    OR table_health.proparallel IS DISTINCT FROM 'u'
    OR NOT table_health.prosecdef
    OR table_health.proleakproof
    OR table_health.proisstrict
    OR table_health.prosrc <> ''
    OR pg_catalog.pg_get_function_sqlbody(table_health.oid) IS NULL
    OR table_health.prorows IS DISTINCT FROM 25::real
    OR table_health.proconfig IS DISTINCT FROM ARRAY[
      'search_path=pg_catalog, pg_temp',
      'statement_timeout=5s'
    ]::text[]
    OR table_health.proargmodes IS DISTINCT FROM
      ARRAY['t','t','t','t','t','t','t','t','t','t']::"char"[]
    OR table_health.proargnames IS DISTINCT FROM ARRAY[
      'schema_name',
      'table_name',
      'physical_bytes',
      'live_tuples',
      'dead_tuples',
      'last_autovacuum_at_ms',
      'last_autoanalyze_at_ms',
      'dead_tuple_percent',
      'assessed',
      'estimated_reclaimable_bytes'
    ]::text[]
    OR table_health.proallargtypes IS DISTINCT FROM ARRAY[
      'pg_catalog.name'::pg_catalog.regtype,
      'pg_catalog.name'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.numeric'::pg_catalog.regtype,
      'pg_catalog.bool'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype
    ]::oid[]
    OR pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.pg_get_function_sqlbody(table_health.oid),
        'UTF8'
      )),
      'hex'
    ) IS DISTINCT FROM
      '391b9e5325dd42c9f4a319b44dd8ddae0fb88a0cd5276540ab5d65d53ace5606'
    OR maintenance_metrics.oid IS NULL
    OR maintenance_metrics.proowner IS DISTINCT FROM capability_owner_oid
    OR maintenance_metrics.prolang IS DISTINCT FROM table_health.prolang
    OR maintenance_metrics.prorettype IS DISTINCT FROM
      'pg_catalog.record'::pg_catalog.regtype
    OR maintenance_metrics.prokind IS DISTINCT FROM 'f'
    OR maintenance_metrics.provolatile IS DISTINCT FROM 'v'
    OR maintenance_metrics.proparallel IS DISTINCT FROM 'u'
    OR NOT maintenance_metrics.prosecdef
    OR maintenance_metrics.proleakproof
    OR maintenance_metrics.proisstrict
    OR maintenance_metrics.prosrc <> ''
    OR pg_catalog.pg_get_function_sqlbody(maintenance_metrics.oid) IS NULL
    OR maintenance_metrics.prorows IS DISTINCT FROM 1::real
    OR maintenance_metrics.proconfig IS DISTINCT FROM ARRAY[
      'search_path=pg_catalog, pg_temp',
      'statement_timeout=5s'
    ]::text[]
    OR maintenance_metrics.proargmodes IS DISTINCT FROM
      ARRAY['t','t','t','t','t']::"char"[]
    OR maintenance_metrics.proargnames IS DISTINCT FROM ARRAY[
      'assessed_physical_bytes',
      'estimated_reclaimable_bytes',
      'high_dead_tuple_table_count',
      'unassessed_physical_bytes',
      'unassessed_table_count'
    ]::text[]
    OR maintenance_metrics.proallargtypes IS DISTINCT FROM ARRAY[
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype,
      'pg_catalog.int8'::pg_catalog.regtype
    ]::oid[]
    OR pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.pg_get_function_sqlbody(maintenance_metrics.oid),
          'UTF8'
        )
      ),
      'hex'
    ) IS DISTINCT FROM
      '617ddca7f3f255858cf01b3ec1c07cf2fa37a5d5ba4e21fc52e2ce451f473c0a'
  THEN
    RAISE EXCEPTION 'Database observability maintenance capabilities are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[table_health.oid, maintenance_metrics.oid]
    ) AS admitted_routines(oid)
    WHERE (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.aclexplode(
        (SELECT routines.proacl
         FROM pg_catalog.pg_proc AS routines
         WHERE routines.oid = admitted_routines.oid)
      ) AS grants
    ) IS DISTINCT FROM 2
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          (SELECT routines.proacl
           FROM pg_catalog.pg_proc AS routines
           WHERE routines.oid = admitted_routines.oid)
        ) AS grants
        WHERE grants.grantor IS DISTINCT FROM capability_owner_oid
          OR grants.is_grantable
          OR grants.privilege_type <> 'EXECUTE'
          OR grants.grantee NOT IN (capability_owner_oid, observer_oid)
      )
  )
    OR NOT pg_catalog.has_function_privilege(
      observer_oid,
      table_health.oid,
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      observer_oid,
      maintenance_metrics.oid,
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'Database observability maintenance capability ACL is invalid';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
      capability_owner_oid,
      'pg_catalog.pg_statistic'::pg_catalog.regclass,
      'SELECT'
    )
    OR pg_catalog.has_table_privilege(
      observer_oid,
      'pg_catalog.pg_statistic'::pg_catalog.regclass,
      'SELECT'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        (SELECT classes.relacl
         FROM pg_catalog.pg_class AS classes
         WHERE classes.oid = 'pg_catalog.pg_statistic'::pg_catalog.regclass)
      ) AS grants
      WHERE grants.grantee = capability_owner_oid
        AND (
          grants.privilege_type <> 'SELECT'
          OR grants.is_grantable
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        (SELECT classes.relacl
         FROM pg_catalog.pg_class AS classes
         WHERE classes.oid = 'pg_catalog.pg_statistic'::pg_catalog.regclass)
      ) AS grants
      WHERE grants.grantee = capability_owner_oid
        AND grants.privilege_type = 'SELECT'
        AND NOT grants.is_grantable
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_default_acl AS defaults
      CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS grants
      WHERE defaults.defaclrole = capability_owner_oid
        AND (
          defaults.defaclnamespace <> 0
          OR defaults.defaclobjtype <> 'f'
          OR grants.grantee <> capability_owner_oid
          OR grants.privilege_type <> 'EXECUTE'
          OR grants.is_grantable
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_default_acl AS defaults
      CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS grants
      WHERE defaults.defaclrole = capability_owner_oid
        AND defaults.defaclnamespace = 0
        AND defaults.defaclobjtype = 'f'
        AND grants.grantee = capability_owner_oid
        AND grants.privilege_type = 'EXECUTE'
        AND NOT grants.is_grantable
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_shdepend AS dependencies
      WHERE dependencies.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependencies.refobjid = capability_owner_oid
        AND dependencies.deptype = 'o'
        AND dependencies.dbid = (
          SELECT databases.oid
          FROM pg_catalog.pg_database AS databases
          WHERE databases.datname = pg_catalog.current_database()
        )
        AND NOT (
          dependencies.dbid = (
            SELECT databases.oid
            FROM pg_catalog.pg_database AS databases
            WHERE databases.datname = pg_catalog.current_database()
          )
          AND (
            dependencies.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
              AND (
                dependencies.objid IN (
                  table_health.oid,
                  maintenance_metrics.oid
                )
                OR pg_catalog.current_database() =
                    'mira_dashboard_observability'
                  AND dependencies.objid IN (
                    SELECT routines.oid
                    FROM pg_catalog.pg_proc AS routines
                    WHERE routines.pronamespace = capability_schema_oid
                      AND routines.pronargs = 0
                      AND routines.proname IN (
                        'connection_metrics',
                        'statement_metrics'
                      )
                  )
              )
            OR dependencies.classid =
                'pg_catalog.pg_default_acl'::pg_catalog.regclass
              AND dependencies.objid = (
                SELECT defaults.oid
                FROM pg_catalog.pg_default_acl AS defaults
                WHERE defaults.defaclrole = capability_owner_oid
                  AND defaults.defaclnamespace = 0
                  AND defaults.defaclobjtype = 'f'
              )
          )
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability capability owner authority is invalid';
  END IF;
END
$verify_database_capabilities$;
