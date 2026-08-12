\set ON_ERROR_STOP 1

DO $verify$
DECLARE
  observer_oid oid;
  pg_stat_statements_extension_oid oid;
  pg_stat_statements_extension_owner_oid oid;
  pg_stat_statements_extension_schema_oid oid;
  pg_stat_statements_relation_oids oid[];
  pg_stat_statements_relation_inventory text[];
  pg_stat_statements_columns text[];
  pg_stat_statements_info_columns text[];
BEGIN
  IF pg_catalog.current_database() NOT IN (
    'aiomanager',
    'aiometadata',
    'aiostreams',
    'authelia',
    'bitmagnet',
    'comet',
    'crowdsec',
    'metabase',
    'postgres',
    'speedtest_tracker'
  ) THEN
    RAISE EXCEPTION 'Database observability target is not reviewed';
  END IF;

  SELECT oid INTO observer_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observer';
  IF observer_oid IS NULL THEN
    RAISE EXCEPTION 'Database observability observer is absent';
  END IF;

  IF pg_catalog.current_database() = 'postgres' THEN
    SELECT extensions.oid, extensions.extowner, extensions.extnamespace
    INTO
      pg_stat_statements_extension_oid,
      pg_stat_statements_extension_owner_oid,
      pg_stat_statements_extension_schema_oid
    FROM pg_catalog.pg_extension AS extensions
    WHERE extensions.extname = 'pg_stat_statements'
      AND extensions.extversion = '1.12';

    IF pg_stat_statements_extension_oid IS NULL
      OR pg_stat_statements_extension_owner_oid IN (
        observer_oid,
        (SELECT oid FROM pg_catalog.pg_roles
         WHERE rolname = 'mira_dashboard_observability_owner')
      )
      OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS owners
        WHERE owners.oid = pg_stat_statements_extension_owner_oid
          AND owners.rolsuper
      )
      OR pg_stat_statements_extension_schema_oid IS DISTINCT FROM (
        SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'public'
      )
    THEN
      RAISE EXCEPTION 'pg_stat_statements extension identity is invalid';
    END IF;

    SELECT
      pg_catalog.array_agg(classes.oid ORDER BY classes.relname),
      pg_catalog.array_agg(
        namespaces.nspname || '.' || classes.relname || ':' || classes.relkind::text
        ORDER BY classes.relname
      )
    INTO pg_stat_statements_relation_oids, pg_stat_statements_relation_inventory
    FROM pg_catalog.pg_depend AS dependencies
    JOIN pg_catalog.pg_class AS classes
      ON dependencies.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND dependencies.objid = classes.oid
     AND dependencies.objsubid = 0
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    WHERE dependencies.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      AND dependencies.refobjid = pg_stat_statements_extension_oid
      AND dependencies.deptype = 'e';

    IF pg_stat_statements_relation_inventory IS DISTINCT FROM ARRAY[
      'public.pg_stat_statements:v',
      'public.pg_stat_statements_info:v'
    ]::text[]
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS classes
        WHERE classes.oid = ANY(pg_stat_statements_relation_oids)
          AND classes.relowner IS DISTINCT FROM pg_stat_statements_extension_owner_oid
      )
    THEN
      RAISE EXCEPTION 'pg_stat_statements extension relations are invalid';
    END IF;

    SELECT pg_catalog.array_agg(
      attributes.attname || ':' ||
        pg_catalog.format_type(attributes.atttypid, attributes.atttypmod)
      ORDER BY attributes.attnum
    ) INTO pg_stat_statements_columns
    FROM pg_catalog.pg_attribute AS attributes
    WHERE attributes.attrelid = 'public.pg_stat_statements'::pg_catalog.regclass
      AND attributes.attnum > 0
      AND NOT attributes.attisdropped;
    SELECT pg_catalog.array_agg(
      attributes.attname || ':' ||
        pg_catalog.format_type(attributes.atttypid, attributes.atttypmod)
      ORDER BY attributes.attnum
    ) INTO pg_stat_statements_info_columns
    FROM pg_catalog.pg_attribute AS attributes
    WHERE attributes.attrelid = 'public.pg_stat_statements_info'::pg_catalog.regclass
      AND attributes.attnum > 0
      AND NOT attributes.attisdropped;

    IF pg_stat_statements_columns IS DISTINCT FROM ARRAY[
      'userid:oid',
      'dbid:oid',
      'toplevel:boolean',
      'queryid:bigint',
      'query:text',
      'plans:bigint',
      'total_plan_time:double precision',
      'min_plan_time:double precision',
      'max_plan_time:double precision',
      'mean_plan_time:double precision',
      'stddev_plan_time:double precision',
      'calls:bigint',
      'total_exec_time:double precision',
      'min_exec_time:double precision',
      'max_exec_time:double precision',
      'mean_exec_time:double precision',
      'stddev_exec_time:double precision',
      'rows:bigint',
      'shared_blks_hit:bigint',
      'shared_blks_read:bigint',
      'shared_blks_dirtied:bigint',
      'shared_blks_written:bigint',
      'local_blks_hit:bigint',
      'local_blks_read:bigint',
      'local_blks_dirtied:bigint',
      'local_blks_written:bigint',
      'temp_blks_read:bigint',
      'temp_blks_written:bigint',
      'shared_blk_read_time:double precision',
      'shared_blk_write_time:double precision',
      'local_blk_read_time:double precision',
      'local_blk_write_time:double precision',
      'temp_blk_read_time:double precision',
      'temp_blk_write_time:double precision',
      'wal_records:bigint',
      'wal_fpi:bigint',
      'wal_bytes:numeric',
      'wal_buffers_full:bigint',
      'jit_functions:bigint',
      'jit_generation_time:double precision',
      'jit_inlining_count:bigint',
      'jit_inlining_time:double precision',
      'jit_optimization_count:bigint',
      'jit_optimization_time:double precision',
      'jit_emission_count:bigint',
      'jit_emission_time:double precision',
      'jit_deform_count:bigint',
      'jit_deform_time:double precision',
      'parallel_workers_to_launch:bigint',
      'parallel_workers_launched:bigint',
      'stats_since:timestamp with time zone',
      'minmax_stats_since:timestamp with time zone'
    ]::text[]
      OR pg_stat_statements_info_columns IS DISTINCT FROM ARRAY[
        'dealloc:bigint',
        'stats_reset:timestamp with time zone'
      ]::text[]
    THEN
      RAISE EXCEPTION 'pg_stat_statements extension relation shape is invalid';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS classes
      WHERE classes.oid = ANY(pg_stat_statements_relation_oids)
        AND (
          NOT pg_catalog.has_table_privilege(
            'mira_dashboard_observer',
            classes.oid,
            'SELECT'
          )
          OR pg_catalog.has_table_privilege(
            'mira_dashboard_observer',
            classes.oid,
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
          )
          OR pg_catalog.has_any_column_privilege(
            'mira_dashboard_observer',
            classes.oid,
            'INSERT,UPDATE,REFERENCES'
          )
          OR (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.aclexplode(classes.relacl) AS grants
          ) <> 9
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.aclexplode(classes.relacl) AS grants
            WHERE grants.grantor IS DISTINCT FROM pg_stat_statements_extension_owner_oid
              OR grants.is_grantable
              OR NOT (
                grants.grantee = pg_stat_statements_extension_owner_oid
                  AND grants.privilege_type IN (
                    'SELECT',
                    'INSERT',
                    'UPDATE',
                    'DELETE',
                    'TRUNCATE',
                    'REFERENCES',
                    'TRIGGER',
                    'MAINTAIN'
                  )
                OR grants.grantee = 0
                  AND grants.privilege_type = 'SELECT'
              )
          )
        )
    ) THEN
      RAISE EXCEPTION 'pg_stat_statements extension ACL is invalid';
    END IF;
  END IF;

  IF pg_catalog.current_database() <> 'postgres'
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_extension
      WHERE extname = 'pg_stat_statements'
    )
  THEN
    RAISE EXCEPTION 'pg_stat_statements extension is installed outside the control database';
  END IF;

  IF pg_catalog.has_database_privilege(
      'mira_dashboard_observer',
      pg_catalog.current_database(),
      'CREATE'
    )
    OR pg_catalog.has_database_privilege(
      'mira_dashboard_observer',
      pg_catalog.current_database(),
      'TEMPORARY'
    )
  THEN
    RAISE EXCEPTION 'Database observability database privileges are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespaces
    WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(
        'mira_dashboard_observer',
        namespaces.oid,
        'CREATE'
      )
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
      AND classes.relkind IN ('r', 'p', 'f')
      AND (
        pg_catalog.has_table_privilege(
          'mira_dashboard_observer',
          classes.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        OR pg_catalog.has_any_column_privilege(
          'mira_dashboard_observer',
          classes.oid,
          'SELECT,INSERT,UPDATE,REFERENCES'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Database observability base-table privileges are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS classes
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
      AND classes.relkind IN ('v', 'm')
      AND NOT (
        pg_catalog.current_database() IN ('bitmagnet', 'comet')
        AND namespaces.nspname = 'mira_dashboard_observability'
        AND classes.relname = 'torrent_count'
        AND classes.relkind = 'v'
      )
      AND NOT (
        pg_catalog.current_database() = 'postgres'
        AND classes.oid = ANY(pg_stat_statements_relation_oids)
      )
      AND pg_catalog.has_table_privilege(
        'mira_dashboard_observer',
        classes.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      )
  ) THEN
    RAISE EXCEPTION 'Database observability relation privileges are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS classes
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
      AND CASE WHEN classes.relkind = 'S' THEN
        pg_catalog.has_sequence_privilege(
          'mira_dashboard_observer',
          classes.oid,
          'USAGE,SELECT,UPDATE'
        )
      ELSE false END
  ) THEN
    RAISE EXCEPTION 'Database observability sequence privileges are invalid';
  END IF;
END
$verify$;
