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
    WHERE rolname = 'mira_dashboard_observability_capability_owner'
  ) THEN
    CREATE ROLE mira_dashboard_observability_capability_owner
      NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE mira_dashboard_observability_capability_owner
      NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE mira_dashboard_observability_capability_owner PASSWORD NULL;
  ALTER ROLE mira_dashboard_observability_capability_owner RESET ALL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'mira_dashboard_observer'
  ) THEN
    CREATE ROLE mira_dashboard_observer
      NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 64;
  ELSE
    ALTER ROLE mira_dashboard_observer
      NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 64;
  END IF;
  ALTER ROLE mira_dashboard_observer PASSWORD NULL;
  ALTER ROLE mira_dashboard_observer
    VALID UNTIL '1970-01-01 00:00:00+00';
  ALTER ROLE mira_dashboard_observer RESET ALL;
  -- RESET ALL does not clear ALTER ROLE ... IN DATABASE settings. The exact
  -- boundary below refuses every such override while the observer is NOLOGIN.
  ALTER ROLE mira_dashboard_observer
    SET default_transaction_read_only = on;
  ALTER ROLE mira_dashboard_observer
    SET statement_timeout = '5s';
  ALTER ROLE mira_dashboard_observer
    SET idle_session_timeout = '60s';
  ALTER ROLE mira_dashboard_observer
    SET idle_in_transaction_session_timeout = '60s';
END
$quarantine$;

-- A collection lease is a one-use, runner-owned comment. Provisioning always
-- returns the observer to the canonical closed state before qualification.
COMMENT ON ROLE mira_dashboard_observer IS NULL;

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
      'mira_dashboard_observability_owner',
      'mira_dashboard_observability_capability_owner'
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
      'mira_dashboard_observability_owner',
      'mira_dashboard_observability_capability_owner'
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
  capability_owner_oid oid;
  observer_direct_memberships text[];
  observer_inbound_membership_count bigint;
  owner_membership_count bigint;
  capability_owner_direct_memberships text[];
  capability_owner_inbound_membership_count bigint;
BEGIN
  SELECT oid INTO STRICT observer_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observer';
  SELECT oid INTO STRICT owner_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observability_owner';
  SELECT oid INTO STRICT capability_owner_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'mira_dashboard_observability_capability_owner';

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

  SELECT COALESCE(
    pg_catalog.array_agg(roles.rolname::text ORDER BY roles.rolname),
    ARRAY[]::text[]
  ) INTO capability_owner_direct_memberships
  FROM pg_catalog.pg_auth_members AS memberships
  JOIN pg_catalog.pg_roles AS roles ON roles.oid = memberships.roleid
  WHERE memberships.member = capability_owner_oid;
  IF NOT capability_owner_direct_memberships <@ ARRAY[
    'pg_read_all_stats'
  ]::text[]
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members
      WHERE member = capability_owner_oid
        AND (admin_option OR NOT inherit_option OR set_option)
    )
  THEN
    RAISE EXCEPTION 'Database observability capability owner memberships are invalid';
  END IF;
  SELECT pg_catalog.count(*) INTO capability_owner_inbound_membership_count
  FROM pg_catalog.pg_auth_members
  WHERE roleid = capability_owner_oid;
  IF capability_owner_inbound_membership_count <> 0 THEN
    RAISE EXCEPTION 'Database observability capability owner has inbound memberships';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_shdepend AS dependencies
    WHERE dependencies.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependencies.refobjid = capability_owner_oid
      AND dependencies.deptype = 'o'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_database AS databases
        WHERE databases.oid = dependencies.dbid
          AND NOT databases.datistemplate
          AND databases.datallowconn
      )
  ) THEN
    RAISE EXCEPTION 'Database observability capability owner has out-of-scope ownership';
  END IF;
END
$qualify_existing_roles$;

REVOKE pg_monitor FROM mira_dashboard_observer;
REVOKE pg_read_all_stats FROM mira_dashboard_observer;
REVOKE pg_monitor FROM mira_dashboard_observability_capability_owner;
REVOKE pg_read_all_stats FROM mira_dashboard_observability_capability_owner;
GRANT pg_read_all_stats TO mira_dashboard_observability_capability_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;

-- Commit only an exact, disabled principal with no password. Per-database and
-- view verification remains mandatory before the separate activation step.
DO $verify_disabled_boundary$
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
    OR observer.rolpassword IS NOT NULL
    OR observer.rolvaliduntil IS DISTINCT FROM
      '1970-01-01 00:00:00+00'::timestamp with time zone
    OR pg_catalog.cardinality(observer_config) IS DISTINCT FROM 4
    OR NOT COALESCE(
      observer_config @> ARRAY[
        'default_transaction_read_only=on',
        'statement_timeout=5s',
        'idle_session_timeout=60s',
        'idle_in_transaction_session_timeout=60s'
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
    WHERE settings.setrole = view_owner.oid
      AND settings.setdatabase <> 0
  ) THEN
    RAISE EXCEPTION 'Database observability view owner has database-scoped settings';
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
      SELECT 1 FROM pg_catalog.pg_auth_members
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

END
$verify_disabled_boundary$;

COMMIT;
