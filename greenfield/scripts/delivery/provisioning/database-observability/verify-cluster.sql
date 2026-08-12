\set ON_ERROR_STOP 1

DO $verify$
DECLARE
  observer pg_catalog.pg_authid%ROWTYPE;
  observer_config text[];
  view_owner pg_catalog.pg_authid%ROWTYPE;
  view_owner_config text[];
  direct_memberships text[];
  effective_databases text[];
  observer_inbound_membership_count bigint;
  owner_membership_count bigint;
  reserved_session_count bigint;
  expected_databases constant text[] := ARRAY[
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
  ]::text[];
BEGIN
  SELECT * INTO observer
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observer';
  SELECT * INTO view_owner
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observability_owner';
  SELECT settings.setconfig INTO observer_config
  FROM pg_catalog.pg_db_role_setting AS settings
  WHERE settings.setrole = observer.oid AND settings.setdatabase = 0;
  SELECT settings.setconfig INTO view_owner_config
  FROM pg_catalog.pg_db_role_setting AS settings
  WHERE settings.setrole = view_owner.oid AND settings.setdatabase = 0;

  IF observer.oid IS NULL
    OR observer.rolcanlogin
    OR NOT observer.rolinherit
    OR observer.rolsuper
    OR observer.rolcreatedb
    OR observer.rolcreaterole
    OR observer.rolreplication
    OR observer.rolbypassrls
    OR observer.rolconnlimit IS DISTINCT FROM 1
    OR observer.rolpassword IS NULL
    OR observer.rolpassword NOT LIKE 'SCRAM-SHA-256$%'
    OR pg_catalog.cardinality(observer_config) IS DISTINCT FROM 2
    OR NOT COALESCE(
      observer_config @> ARRAY[
        'default_transaction_read_only=on',
        'statement_timeout=5s'
      ]::text[],
      false
    )
  THEN
    RAISE EXCEPTION 'Disabled database observability observer role is invalid';
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

  SELECT COALESCE(
    pg_catalog.array_agg(roles.rolname::text ORDER BY roles.rolname),
    ARRAY[]::text[]
  ) INTO direct_memberships
  FROM pg_catalog.pg_auth_members AS memberships
  JOIN pg_catalog.pg_roles AS roles ON roles.oid = memberships.roleid
  WHERE memberships.member = observer.oid;

  IF direct_memberships IS DISTINCT FROM ARRAY[
    'pg_monitor',
    'pg_read_all_stats'
  ]::text[]
  THEN
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

  IF pg_catalog.pg_has_role(
    'mira_dashboard_observer',
    'mira_dashboard_observability_owner',
    'MEMBER'
  ) THEN
    RAISE EXCEPTION 'Database observability observer can assume view ownership';
  END IF;

  SELECT pg_catalog.count(*) INTO owner_membership_count
  FROM pg_catalog.pg_auth_members
  WHERE roleid = view_owner.oid OR member = view_owner.oid;
  IF owner_membership_count <> 0 THEN
    RAISE EXCEPTION 'Database observability view owner memberships are invalid';
  END IF;

  SELECT pg_catalog.count(*) INTO reserved_session_count
  FROM pg_catalog.pg_stat_activity
  WHERE usename IN (
    'mira_dashboard_observer',
    'mira_dashboard_observability_owner'
  )
    AND pid <> pg_catalog.pg_backend_pid();
  IF reserved_session_count <> 0 THEN
    RAISE EXCEPTION 'Database observability reserved-role session remains active';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(datname ORDER BY datname),
    ARRAY[]::text[]
  ) INTO effective_databases
  FROM pg_catalog.pg_database
  WHERE datallowconn
    AND pg_catalog.has_database_privilege(
      'mira_dashboard_observer',
      oid,
      'CONNECT'
    );

  IF effective_databases IS DISTINCT FROM expected_databases THEN
    RAISE EXCEPTION 'Database observability CONNECT boundary is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database
    WHERE pg_catalog.has_database_privilege(
        'mira_dashboard_observer',
        oid,
        'CREATE'
      )
      OR pg_catalog.has_database_privilege(
        'mira_dashboard_observer',
        oid,
        'TEMPORARY'
      )
  ) THEN
    RAISE EXCEPTION 'Database observability database authority is invalid';
  END IF;
END
$verify$;
