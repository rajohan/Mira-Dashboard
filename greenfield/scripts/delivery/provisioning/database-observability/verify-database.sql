\set ON_ERROR_STOP 1

\ir verify-database-capabilities.sql

-- Generic, name-independent verification for the current catalog database.
DO $verify$
DECLARE
  observer_oid oid;
  allowed_relation_oids oid[] := ARRAY[]::oid[];
  allowed_routine_oids oid[] := ARRAY[]::oid[];
BEGIN
  SELECT oid INTO observer_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observer';

  SELECT pg_catalog.array_agg(routines.oid ORDER BY routines.proname)
  INTO allowed_routine_oids
  FROM pg_catalog.pg_proc AS routines
  JOIN pg_catalog.pg_namespace AS namespaces
    ON namespaces.oid = routines.pronamespace
  WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities'
    AND routines.pronargs = 0
    AND routines.proname IN (
      'table_health',
      'maintenance_metrics',
      'connection_metrics',
      'statement_metrics'
    );

  IF observer_oid IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database
      WHERE datname = pg_catalog.current_database()
        AND NOT datistemplate
        AND datallowconn
    )
    OR NOT pg_catalog.has_database_privilege(
      observer_oid,
      pg_catalog.current_database(),
      'CONNECT'
    )
    OR pg_catalog.has_database_privilege(
      observer_oid,
      pg_catalog.current_database(),
      'CREATE,TEMPORARY'
    )
  THEN
    RAISE EXCEPTION 'Database observability database authority is invalid';
  END IF;

  -- A role- or database-scoped setting can override the reviewed global
  -- read-only/timeout defaults. Cluster verification refuses all such rows.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS settings
    WHERE settings.setrole = observer_oid
      AND settings.setdatabase <> 0
  ) THEN
    RAISE EXCEPTION 'Database observability observer has database-scoped settings';
  END IF;

  -- Default ACLs are future authority. Refuse both defaults owned by the
  -- observer and direct future grants to it, even when no current object leaks.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS defaults
    LEFT JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS grants
      ON true
    WHERE defaults.defaclrole = observer_oid
      OR grants.grantee = observer_oid
      OR (
        grants.grantee <> 0
        AND pg_catalog.pg_has_role(observer_oid, grants.grantee, 'USAGE')
      )
  ) THEN
    RAISE EXCEPTION 'Database observability observer default ACL is invalid';
  END IF;

  -- Explicit grants to the observer or one of its inherited roles are never
  -- permitted on user-schema routines. Ordinary PUBLIC invoker routines remain
  -- usable; only effective SECURITY DEFINER execution is rejected wholesale.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routines
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = routines.pronamespace
    WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
      AND NOT (routines.oid = ANY(allowed_routine_oids))
      AND (
        pg_catalog.pg_has_role(observer_oid, routines.proowner, 'USAGE')
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(routines.proacl) AS grants
          WHERE grants.grantee = observer_oid
            OR (
              grants.grantee <> 0
              AND pg_catalog.pg_has_role(
                observer_oid,
                grants.grantee,
                'USAGE'
              )
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Database observability routine grants are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routines
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = routines.pronamespace
    WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
      AND NOT (routines.oid = ANY(allowed_routine_oids))
      AND routines.prosecdef
      AND pg_catalog.has_function_privilege(
        observer_oid,
        routines.oid,
        'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'Database observability SECURITY DEFINER authority is invalid';
  END IF;

  IF pg_catalog.current_database() IN ('bitmagnet', 'comet') THEN
    SELECT ARRAY[classes.oid] INTO allowed_relation_oids
    FROM pg_catalog.pg_class AS classes
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    WHERE namespaces.nspname = 'mira_dashboard_observability'
      AND classes.relname = 'torrent_count'
      AND classes.relkind = 'v';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespaces
    WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(observer_oid, namespaces.oid, 'CREATE')
  ) THEN
    RAISE EXCEPTION 'Database observability schema privileges are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS classes
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
      AND NOT (classes.oid = ANY(allowed_relation_oids))
      AND CASE
        WHEN classes.relkind = 'S' THEN
          pg_catalog.has_sequence_privilege(
            observer_oid,
            classes.oid,
            'USAGE,SELECT,UPDATE'
          )
        WHEN classes.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
          pg_catalog.has_table_privilege(
            observer_oid,
            classes.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
          )
          OR pg_catalog.has_any_column_privilege(
            observer_oid,
            classes.oid,
            'SELECT,INSERT,UPDATE,REFERENCES'
          )
        ELSE false
      END
  ) THEN
    RAISE EXCEPTION 'Database observability relation privileges are invalid';
  END IF;

END
$verify$;
