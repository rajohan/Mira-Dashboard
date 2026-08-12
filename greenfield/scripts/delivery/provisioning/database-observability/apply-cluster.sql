\set ON_ERROR_STOP 1

-- Quarantine both reserved identities in a committed transaction before any
-- privilege transition. A later failure must never restore an old login or
-- password on a same-named observer role.
DO $quarantine$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'mira_dashboard_observability_owner'
  ) THEN
    CREATE ROLE mira_dashboard_observability_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE mira_dashboard_observability_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE mira_dashboard_observability_owner PASSWORD NULL;
  ALTER ROLE mira_dashboard_observability_owner RESET ALL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'mira_dashboard_observer'
  ) THEN
    CREATE ROLE mira_dashboard_observer
      NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
  ELSE
    ALTER ROLE mira_dashboard_observer
      NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
  END IF;
  ALTER ROLE mira_dashboard_observer PASSWORD NULL;
  ALTER ROLE mira_dashboard_observer RESET ALL;
  ALTER ROLE mira_dashboard_observer
    SET default_transaction_read_only = on;
  ALTER ROLE mira_dashboard_observer
    SET statement_timeout = '5s';
END
$quarantine$;

-- NOLOGIN does not terminate an already-authenticated session. End every
-- reserved-role backend before privileges can be qualified or granted.
DO $terminate_reserved_sessions$
DECLARE
  reserved_session record;
BEGIN
  FOR reserved_session IN
    SELECT activity.pid
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.usename IN (
      'mira_dashboard_observer',
      'mira_dashboard_observability_owner'
    )
      AND activity.pid <> pg_catalog.pg_backend_pid()
  LOOP
    IF NOT pg_catalog.pg_terminate_backend(reserved_session.pid, 5000) THEN
      RAISE EXCEPTION 'Database observability reserved-role session could not be terminated';
    END IF;
  END LOOP;

  PERFORM pg_catalog.pg_stat_clear_snapshot();

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.usename IN (
      'mira_dashboard_observer',
      'mira_dashboard_observability_owner'
    )
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'Database observability reserved-role session remains active';
  END IF;
END
$terminate_reserved_sessions$;

BEGIN;

-- A same-named pre-existing role may only carry the two reviewed outbound
-- memberships. Inbound membership would bypass NOLOGIN through SET ROLE, and
-- the owner must be completely isolated in both directions.
DO $qualify_existing_roles$
DECLARE
  observer_oid oid;
  owner_oid oid;
  observer_direct_memberships text[];
  observer_inbound_membership_count bigint;
  owner_membership_count bigint;
BEGIN
  SELECT oid INTO STRICT observer_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observer';
  SELECT oid INTO STRICT owner_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observability_owner';

  SELECT COALESCE(
    pg_catalog.array_agg(roles.rolname::text ORDER BY roles.rolname),
    ARRAY[]::text[]
  ) INTO observer_direct_memberships
  FROM pg_catalog.pg_auth_members AS memberships
  JOIN pg_catalog.pg_roles AS roles ON roles.oid = memberships.roleid
  WHERE memberships.member = observer_oid;

  IF NOT observer_direct_memberships <@ ARRAY[
    'pg_monitor',
    'pg_read_all_stats'
  ]::text[] THEN
    RAISE EXCEPTION 'Database observability observer has unexpected memberships';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members
    WHERE member = observer_oid
      AND (admin_option OR NOT inherit_option OR NOT set_option)
  ) THEN
    RAISE EXCEPTION 'Database observability observer membership options are invalid';
  END IF;

  SELECT pg_catalog.count(*) INTO observer_inbound_membership_count
  FROM pg_catalog.pg_auth_members
  WHERE roleid = observer_oid;
  IF observer_inbound_membership_count <> 0 THEN
    RAISE EXCEPTION 'Database observability observer has inbound memberships';
  END IF;

  SELECT pg_catalog.count(*) INTO owner_membership_count
  FROM pg_catalog.pg_auth_members
  WHERE roleid = owner_oid OR member = owner_oid;
  IF owner_membership_count <> 0 THEN
    RAISE EXCEPTION 'Database observability view owner has memberships';
  END IF;
END
$qualify_existing_roles$;

REVOKE pg_monitor FROM mira_dashboard_observer;
REVOKE pg_read_all_stats FROM mira_dashboard_observer;

REVOKE ALL PRIVILEGES ON DATABASE aiomanager FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE aiometadata FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE aiostreams FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE authelia FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE bitmagnet FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE comet FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE crowdsec FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE metabase FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE postgres FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON DATABASE speedtest_tracker FROM mira_dashboard_observer;

GRANT pg_monitor TO mira_dashboard_observer;
GRANT pg_read_all_stats TO mira_dashboard_observer;

GRANT CONNECT ON DATABASE aiomanager TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE aiometadata TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE aiostreams TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE authelia TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE bitmagnet TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE comet TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE crowdsec TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE metabase TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE postgres TO mira_dashboard_observer;
GRANT CONNECT ON DATABASE speedtest_tracker TO mira_dashboard_observer;

-- Commit only an exact, disabled principal with no password. Per-database and
-- view verification remains mandatory before the separate activation step.
DO $verify_disabled_boundary$
DECLARE
  observer pg_catalog.pg_authid%ROWTYPE;
  observer_config text[];
  view_owner pg_catalog.pg_authid%ROWTYPE;
  view_owner_config text[];
  direct_memberships text[];
  effective_databases text[];
  observer_inbound_membership_count bigint;
  owner_membership_count bigint;
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
    OR observer.rolpassword IS NOT NULL
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
  ]::text[] THEN
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
$verify_disabled_boundary$;

COMMIT;
