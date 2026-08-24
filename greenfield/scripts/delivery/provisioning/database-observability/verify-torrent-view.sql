\set ON_ERROR_STOP 1

DO $verify$
DECLARE
  observer_oid oid;
  owner_oid oid;
  schema_oid oid;
  view_oid oid;
  normalized_definition text;
  projected_count bigint;
  projected_rows bigint;
  schema_relations text[];
  source_count bigint;
  source_dependency_count bigint;
BEGIN
  IF pg_catalog.current_database() NOT IN ('bitmagnet', 'comet') THEN
    RAISE EXCEPTION 'Database observability view target is not reviewed';
  END IF;

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
  THEN
    RAISE EXCEPTION 'Database observability view identity is invalid';
  END IF;

  IF (SELECT nspowner FROM pg_catalog.pg_namespace WHERE oid = schema_oid)
      IS DISTINCT FROM owner_oid
    OR (SELECT relowner FROM pg_catalog.pg_class WHERE oid = view_oid)
      IS DISTINCT FROM owner_oid
    OR (SELECT reloptions FROM pg_catalog.pg_class WHERE oid = view_oid)
      IS DISTINCT FROM ARRAY['security_barrier=true']::text[]
  THEN
    RAISE EXCEPTION 'Database observability view ownership is invalid';
  END IF;

  SELECT pg_catalog.array_agg(
    classes.relname || ':' || classes.relkind::text ORDER BY classes.relname
  ) INTO schema_relations
  FROM pg_catalog.pg_class AS classes
  WHERE classes.relnamespace = schema_oid;

  IF schema_relations IS DISTINCT FROM ARRAY['torrent_count:v']::text[]
    AND schema_relations IS DISTINCT FROM ARRAY[
      'statement_metrics:v',
      'torrent_count:v'
    ]::text[]
  THEN
    RAISE EXCEPTION 'Database observability schema contains unexpected relations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routines
    WHERE routines.pronamespace = schema_oid
  ) THEN
    RAISE EXCEPTION 'Database observability schema contains unexpected routines';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_type AS types
    WHERE types.typnamespace = schema_oid
  ) <> 2
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type AS types
      WHERE types.typnamespace = schema_oid
        AND types.oid NOT IN (
          (SELECT reltype FROM pg_catalog.pg_class WHERE oid = view_oid),
          (
            SELECT typarray
            FROM pg_catalog.pg_type
            WHERE oid = (
              SELECT reltype FROM pg_catalog.pg_class WHERE oid = view_oid
            )
          )
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type AS row_type
      JOIN pg_catalog.pg_type AS array_type
        ON array_type.oid = row_type.typarray
      WHERE row_type.oid = (
          SELECT reltype FROM pg_catalog.pg_class WHERE oid = view_oid
        )
        AND row_type.typrelid = view_oid
        AND row_type.typowner = owner_oid
        AND array_type.typelem = row_type.oid
        AND array_type.typowner = owner_oid
        AND array_type.typnamespace = schema_oid
    )
  THEN
    RAISE EXCEPTION 'Database observability schema contains unexpected types';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute
    WHERE attrelid = view_oid AND attnum > 0 AND NOT attisdropped
  ) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute
      WHERE attrelid = view_oid
        AND attnum = 1
        AND attname = 'count'
        AND atttypid = 'pg_catalog.int8'::pg_catalog.regtype
        AND NOT attisdropped
    )
  THEN
    RAISE EXCEPTION 'Database observability view shape is invalid';
  END IF;

  SELECT pg_catalog.count(*) INTO source_dependency_count
  FROM pg_catalog.pg_depend AS dependencies
  JOIN pg_catalog.pg_rewrite AS rewrites
    ON dependencies.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
   AND dependencies.objid = rewrites.oid
  WHERE rewrites.ev_class = view_oid
    AND dependencies.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND dependencies.refobjid = 'public.torrents'::pg_catalog.regclass
    AND dependencies.refobjsubid = 0
    AND dependencies.deptype = 'n';
  IF source_dependency_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Database observability view source dependency is invalid';
  END IF;

  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
  SELECT pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.pg_get_viewdef(view_oid, true),
      '\s+',
      ' ',
      'g'
    )
  ) INTO normalized_definition;
  IF normalized_definition NOT IN (
    'SELECT count(*) AS count FROM public.torrents;',
    'SELECT count(*)::bigint AS count FROM public.torrents;'
  ) THEN
    RAISE EXCEPTION 'Database observability view definition is invalid';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
      'mira_dashboard_observer',
      schema_oid,
      'USAGE'
    )
    OR pg_catalog.has_schema_privilege(
      'mira_dashboard_observer',
      schema_oid,
      'CREATE'
    )
    OR NOT pg_catalog.has_table_privilege(
      'mira_dashboard_observer',
      view_oid,
      'SELECT'
    )
    OR pg_catalog.has_table_privilege(
      'mira_dashboard_observer',
      view_oid,
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    )
    OR pg_catalog.has_table_privilege(
      'mira_dashboard_observer',
      'public.torrents',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    )
    OR pg_catalog.has_any_column_privilege(
      'mira_dashboard_observer',
      'public.torrents',
      'SELECT,INSERT,UPDATE,REFERENCES'
    )
    OR NOT pg_catalog.has_table_privilege(
      'mira_dashboard_observability_owner',
      'public.torrents',
      'SELECT'
    )
    OR pg_catalog.has_table_privilege(
      'mira_dashboard_observability_owner',
      'public.torrents',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    )
    OR (
      SELECT relowner
      FROM pg_catalog.pg_class
      WHERE oid = 'public.torrents'::pg_catalog.regclass
    ) = owner_oid
  THEN
    RAISE EXCEPTION 'Database observability view privileges are invalid';
  END IF;

  IF (
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

  SELECT pg_catalog.count(*), pg_catalog.min(torrent_count.count)
  INTO projected_rows, projected_count
  FROM mira_dashboard_observability.torrent_count AS torrent_count;
  SELECT pg_catalog.count(*) INTO source_count FROM public.torrents;
  IF projected_rows IS DISTINCT FROM 1
    OR projected_count IS NULL
    OR projected_count < 0
    OR projected_count > 9007199254740991
    OR projected_count IS DISTINCT FROM source_count
  THEN
    RAISE EXCEPTION 'Database observability view result is invalid';
  END IF;
END
$verify$;
