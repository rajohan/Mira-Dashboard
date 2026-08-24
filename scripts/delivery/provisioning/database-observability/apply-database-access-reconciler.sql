\set ON_ERROR_STOP 1

BEGIN;

DO $administrator_boundary$
DECLARE
  administrator_oid oid;
BEGIN
  SELECT databases.datdba INTO administrator_oid
  FROM pg_catalog.pg_database AS databases
  JOIN pg_catalog.pg_roles AS owners ON owners.oid = databases.datdba
  WHERE databases.datname = pg_catalog.current_database()
    AND databases.datname = 'mira_dashboard_observability'
    AND NOT databases.datistemplate
    AND databases.datallowconn
    AND owners.rolsuper
    AND owners.rolname = CURRENT_USER;
  IF administrator_oid IS NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS roles
      WHERE roles.rolname = 'mira_dashboard_database_access_reconciler'
    )
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_database) > 80
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_database AS databases
        WHERE NOT databases.datistemplate AND databases.datallowconn) > 64
  THEN
    RAISE EXCEPTION 'Database access reconciler administrator is invalid';
  END IF;
END
$administrator_boundary$;

CREATE SCHEMA IF NOT EXISTS mira_dashboard_database_access
  AUTHORIZATION CURRENT_USER;
REVOKE ALL PRIVILEGES ON SCHEMA mira_dashboard_database_access FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA mira_dashboard_database_access
  FROM mira_dashboard_observer,
       mira_dashboard_observability_owner,
       mira_dashboard_observability_capability_owner;

CREATE OR REPLACE FUNCTION mira_dashboard_database_access.reconcile()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '30s'
AS $reconcile$
DECLARE
  database_record record;
  initial_oids oid[];
  initial_names text[];
  initial_template_flags boolean[];
  initial_connection_flags boolean[];
  initial_owner_oids oid[];
  final_oids oid[];
  final_names text[];
  final_template_flags boolean[];
  final_connection_flags boolean[];
  final_owner_oids oid[];
  observed_database_count bigint;
  catalog_database_count bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(1296646465, 1128351300);
  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (
           WHERE NOT databases.datistemplate AND databases.datallowconn
         ),
         pg_catalog.array_agg(databases.oid ORDER BY databases.oid),
         pg_catalog.array_agg(databases.datname::text ORDER BY databases.oid),
         pg_catalog.array_agg(databases.datistemplate ORDER BY databases.oid),
         pg_catalog.array_agg(databases.datallowconn ORDER BY databases.oid),
         pg_catalog.array_agg(databases.datdba ORDER BY databases.oid)
  INTO catalog_database_count,
       observed_database_count,
       initial_oids,
       initial_names,
       initial_template_flags,
       initial_connection_flags,
       initial_owner_oids
  FROM pg_catalog.pg_database AS databases;

  IF catalog_database_count = 0
    OR catalog_database_count > 80
    OR observed_database_count = 0
    OR observed_database_count > 64
    OR pg_catalog.current_database() <> 'mira_dashboard_observability'
  THEN
    RAISE EXCEPTION 'Database access reconciliation catalog boundary is invalid';
  END IF;

  FOR database_record IN
    SELECT databases.datname,
           databases.datistemplate,
           databases.datallowconn
    FROM pg_catalog.pg_database AS databases
    ORDER BY databases.datname
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM mira_dashboard_observer CASCADE',
      database_record.datname
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC',
      database_record.datname
    );
    IF NOT database_record.datistemplate AND database_record.datallowconn THEN
      EXECUTE pg_catalog.format(
        'GRANT CONNECT ON DATABASE %I TO mira_dashboard_observer',
        database_record.datname
      );
    END IF;
  END LOOP;

  SELECT pg_catalog.array_agg(databases.oid ORDER BY databases.oid),
         pg_catalog.array_agg(databases.datname::text ORDER BY databases.oid),
         pg_catalog.array_agg(databases.datistemplate ORDER BY databases.oid),
         pg_catalog.array_agg(databases.datallowconn ORDER BY databases.oid),
         pg_catalog.array_agg(databases.datdba ORDER BY databases.oid)
  INTO final_oids,
       final_names,
       final_template_flags,
       final_connection_flags,
       final_owner_oids
  FROM pg_catalog.pg_database AS databases;
  IF final_oids IS DISTINCT FROM initial_oids
    OR final_names IS DISTINCT FROM initial_names
    OR final_template_flags IS DISTINCT FROM initial_template_flags
    OR final_connection_flags IS DISTINCT FROM initial_connection_flags
    OR final_owner_oids IS DISTINCT FROM initial_owner_oids
  THEN
    RAISE EXCEPTION 'Database access reconciliation catalog changed';
  END IF;
  RETURN observed_database_count::integer;
END
$reconcile$;

ALTER FUNCTION mira_dashboard_database_access.reconcile() OWNER TO CURRENT_USER;
REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_database_access.reconcile() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_database_access.reconcile()
  FROM mira_dashboard_observer,
       mira_dashboard_observability_owner,
       mira_dashboard_observability_capability_owner;

SELECT mira_dashboard_database_access.reconcile();

COMMIT;
