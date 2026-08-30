\set ON_ERROR_STOP 1

DO $verify$
DECLARE
  observer pg_catalog.pg_authid%ROWTYPE;
  observer_config text[];
  view_owner pg_catalog.pg_authid%ROWTYPE;
  view_owner_config text[];
  capability_owner pg_catalog.pg_authid%ROWTYPE;
  capability_owner_config text[];
  direct_memberships text[];
  observer_inbound_membership_count bigint;
  owner_membership_count bigint;
  capability_owner_inbound_membership_count bigint;
  reserved_session_count bigint;
BEGIN
  SELECT * INTO observer
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observer';
  SELECT * INTO view_owner
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observability_owner';
  SELECT * INTO capability_owner
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observability_capability_owner';
  SELECT settings.setconfig INTO observer_config
  FROM pg_catalog.pg_db_role_setting AS settings
  WHERE settings.setrole = observer.oid AND settings.setdatabase = 0;
  SELECT settings.setconfig INTO view_owner_config
  FROM pg_catalog.pg_db_role_setting AS settings
  WHERE settings.setrole = view_owner.oid AND settings.setdatabase = 0;
  SELECT settings.setconfig INTO capability_owner_config
  FROM pg_catalog.pg_db_role_setting AS settings
  WHERE settings.setrole = capability_owner.oid AND settings.setdatabase = 0;

  IF observer.oid IS NULL
    OR observer.rolcanlogin
    OR NOT observer.rolinherit
    OR observer.rolsuper
    OR observer.rolcreatedb
    OR observer.rolcreaterole
    OR observer.rolreplication
    OR observer.rolbypassrls
    OR observer.rolconnlimit IS DISTINCT FROM 64
    OR observer.rolpassword IS NULL
    OR observer.rolpassword NOT LIKE 'SCRAM-SHA-256$%'
    OR observer.rolvaliduntil IS DISTINCT FROM
      '1970-01-01 00:00:00+00'::timestamp with time zone
    OR pg_catalog.shobj_description(observer.oid, 'pg_authid') IS NOT NULL
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_parameter_acl AS parameters
      CROSS JOIN LATERAL pg_catalog.aclexplode(parameters.paracl) AS grants
      WHERE grants.grantee = 0
        OR pg_catalog.pg_has_role(observer.oid, grants.grantee, 'USAGE')
    ) IS DISTINCT FROM 1::bigint
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_parameter_acl AS parameters
      CROSS JOIN LATERAL pg_catalog.aclexplode(parameters.paracl) AS grants
      WHERE parameters.parname = 'pg_stat_statements.track'
        AND grants.grantee = observer.oid
        AND grants.privilege_type = 'SET'
        AND NOT grants.is_grantable
    )
    OR pg_catalog.cardinality(observer_config) IS DISTINCT FROM 5
    OR NOT COALESCE(
      observer_config @> ARRAY[
        'default_transaction_read_only=on',
        'statement_timeout=5s',
        'idle_session_timeout=60s',
        'idle_in_transaction_session_timeout=60s',
        'pg_stat_statements.track=none'
      ]::text[],
      false
    )
  THEN
    RAISE EXCEPTION 'Disabled database observability observer role is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS settings
    WHERE settings.setrole = observer.oid
      AND settings.setdatabase <> 0
  ) THEN
    RAISE EXCEPTION 'Database observability observer has database-scoped settings';
  END IF;

  IF view_owner.oid IS NULL
    OR view_owner.rolcanlogin
    OR view_owner.rolinherit
    OR view_owner.rolsuper
    OR view_owner.rolcreatedb
    OR view_owner.rolcreaterole
    OR view_owner.rolreplication
    OR view_owner.rolbypassrls
    OR view_owner.rolpassword IS NOT NULL
    OR view_owner_config IS NOT NULL
  THEN
    RAISE EXCEPTION 'Database observability view owner is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS settings
    WHERE settings.setrole = view_owner.oid
      AND settings.setdatabase <> 0
  ) THEN
    RAISE EXCEPTION 'Database observability view owner has database-scoped settings';
  END IF;

  IF capability_owner.oid IS NULL
    OR capability_owner.rolcanlogin
    OR NOT capability_owner.rolinherit
    OR capability_owner.rolsuper
    OR capability_owner.rolcreatedb
    OR capability_owner.rolcreaterole
    OR capability_owner.rolreplication
    OR capability_owner.rolbypassrls
    OR capability_owner.rolpassword IS NOT NULL
    OR capability_owner_config IS NOT NULL
  THEN
    RAISE EXCEPTION 'Database observability capability owner is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS settings
    WHERE settings.setrole = capability_owner.oid
      AND settings.setdatabase <> 0
  ) THEN
    RAISE EXCEPTION 'Database observability capability owner has database-scoped settings';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(roles.rolname::text ORDER BY roles.rolname),
    ARRAY[]::text[]
  ) INTO direct_memberships
  FROM pg_catalog.pg_auth_members AS memberships
  JOIN pg_catalog.pg_roles AS roles ON roles.oid = memberships.roleid
  WHERE memberships.member = observer.oid;
  IF direct_memberships IS DISTINCT FROM ARRAY[]::text[] THEN
    RAISE EXCEPTION 'Database observability observer memberships are invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members
    WHERE member = observer.oid
      AND (admin_option OR NOT inherit_option OR NOT set_option)
  ) THEN
    RAISE EXCEPTION 'Database observability observer membership options are invalid';
  END IF;

  SELECT pg_catalog.count(*) INTO observer_inbound_membership_count
  FROM pg_catalog.pg_auth_members
  WHERE roleid = observer.oid;
  IF observer_inbound_membership_count <> 0 THEN
    RAISE EXCEPTION 'Database observability observer has inbound memberships';
  END IF;

  SELECT pg_catalog.count(*) INTO owner_membership_count
  FROM pg_catalog.pg_auth_members
  WHERE roleid = view_owner.oid OR member = view_owner.oid;
  IF owner_membership_count <> 0 THEN
    RAISE EXCEPTION 'Database observability view owner memberships are invalid';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(roles.rolname::text ORDER BY roles.rolname),
    ARRAY[]::text[]
  ) INTO direct_memberships
  FROM pg_catalog.pg_auth_members AS memberships
  JOIN pg_catalog.pg_roles AS roles ON roles.oid = memberships.roleid
  WHERE memberships.member = capability_owner.oid;
  IF direct_memberships IS DISTINCT FROM ARRAY['pg_read_all_stats']::text[]
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members
      WHERE member = capability_owner.oid
        AND (admin_option OR NOT inherit_option OR set_option)
    )
  THEN
    RAISE EXCEPTION 'Database observability capability owner memberships are invalid';
  END IF;
  SELECT pg_catalog.count(*) INTO capability_owner_inbound_membership_count
  FROM pg_catalog.pg_auth_members
  WHERE roleid = capability_owner.oid;
  IF capability_owner_inbound_membership_count <> 0 THEN
    RAISE EXCEPTION 'Database observability capability owner has inbound memberships';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_shdepend AS dependencies
    WHERE dependencies.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependencies.refobjid = capability_owner.oid
      AND dependencies.deptype = 'o'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_database AS databases
        WHERE databases.oid = dependencies.dbid
          AND NOT databases.datistemplate
          AND databases.datallowconn
      )
  ) THEN
    RAISE EXCEPTION 'Database observability capability owner has out-of-scope ownership';
  END IF;

  SELECT pg_catalog.count(*) INTO reserved_session_count
  FROM pg_catalog.pg_stat_activity
  WHERE usename IN (
    'mira_dashboard_observer',
    'mira_dashboard_observability_owner',
    'mira_dashboard_observability_capability_owner'
  )
    AND pid <> pg_catalog.pg_backend_pid();
  IF reserved_session_count <> 0 THEN
    RAISE EXCEPTION 'Database observability reserved-role session remains active';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database
    WHERE pg_catalog.has_database_privilege(
        observer.oid,
        oid,
        'CREATE'
      )
      OR pg_catalog.has_database_privilege(
        observer.oid,
        oid,
        'TEMPORARY'
      )
  ) THEN
    RAISE EXCEPTION 'Database observability database authority is invalid';
  END IF;
END
$verify$;
