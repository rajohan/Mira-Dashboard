\set ON_ERROR_STOP 1

DO $verify_database_access_reconciler$
DECLARE
  administrator_oid oid;
  observer_oid oid;
  schema_oid oid;
  routine pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT databases.datdba INTO administrator_oid
  FROM pg_catalog.pg_database AS databases
  JOIN pg_catalog.pg_roles AS owners ON owners.oid = databases.datdba
  WHERE databases.datname = pg_catalog.current_database()
    AND databases.datname = 'mira_dashboard_observability'
    AND owners.rolsuper;
  SELECT roles.oid INTO observer_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observer';
  SELECT namespaces.oid INTO schema_oid
  FROM pg_catalog.pg_namespace AS namespaces
  WHERE namespaces.nspname = 'mira_dashboard_database_access';
  SELECT routines.* INTO routine
  FROM pg_catalog.pg_proc AS routines
  WHERE routines.pronamespace = schema_oid
    AND routines.proname = 'reconcile'
    AND routines.pronargs = 0;

  IF administrator_oid IS NULL
    OR observer_oid IS NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS roles
      WHERE roles.rolname = 'mira_dashboard_database_access_reconciler'
    )
    OR schema_oid IS NULL
    OR (SELECT namespaces.nspowner FROM pg_catalog.pg_namespace AS namespaces
        WHERE namespaces.oid = schema_oid) <> administrator_oid
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS classes
               WHERE classes.relnamespace = schema_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type AS types
               WHERE types.typnamespace = schema_oid)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS routines
        WHERE routines.pronamespace = schema_oid) <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.aclexplode(
          (SELECT namespaces.nspacl FROM pg_catalog.pg_namespace AS namespaces
           WHERE namespaces.oid = schema_oid)
        ) AS grants) <> 2
    OR EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(
        (SELECT namespaces.nspacl FROM pg_catalog.pg_namespace AS namespaces
         WHERE namespaces.oid = schema_oid)
      ) AS grants
      WHERE grants.grantor <> administrator_oid
        OR grants.grantee <> administrator_oid
        OR grants.is_grantable
        OR grants.privilege_type NOT IN ('CREATE', 'USAGE')
    )
  THEN
    RAISE EXCEPTION 'Database access reconciler schema is invalid';
  END IF;

  IF routine.oid IS NULL
    OR routine.proowner <> administrator_oid
    OR routine.prolang <> (
      SELECT languages.oid FROM pg_catalog.pg_language AS languages
      WHERE languages.lanname = 'plpgsql'
    )
    OR routine.prorettype <> 'pg_catalog.int4'::pg_catalog.regtype
    OR routine.prokind <> 'f'
    OR routine.pronargs <> 0
    OR routine.provolatile <> 'v'
    OR routine.proparallel <> 'u'
    OR NOT routine.prosecdef
    OR routine.proleakproof
    OR routine.proisstrict
    OR routine.proconfig IS DISTINCT FROM ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=2s',
      'statement_timeout=30s'
    ]::text[]
    OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      routine.prosrc,
      'UTF8'
    )), 'hex') <> '137027eb01b6e0edd71d6640ab18ddb3a8534619cb6a1e0a1550dd1eff932f17'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.aclexplode(routine.proacl)) <> 1
    OR EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(routine.proacl) AS grants
      WHERE grants.grantor <> administrator_oid
        OR grants.grantee <> administrator_oid
        OR grants.privilege_type <> 'EXECUTE'
        OR grants.is_grantable
    )
  THEN
    RAISE EXCEPTION 'Database access reconciler function is invalid';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_database) > 80
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_database AS databases
        WHERE NOT databases.datistemplate AND databases.datallowconn) > 64
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database AS databases
      WHERE (NOT databases.datistemplate AND databases.datallowconn)
          IS DISTINCT FROM pg_catalog.has_database_privilege(
            observer_oid,
            databases.oid,
            'CONNECT'
          )
        OR pg_catalog.has_database_privilege(
          observer_oid,
          databases.oid,
          'CREATE,TEMPORARY'
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(databases.datacl) AS grants
          WHERE grants.grantee = 0
        )
    )
  THEN
    RAISE EXCEPTION 'Database access reconciler database ACL is invalid';
  END IF;
END
$verify_database_access_reconciler$;
