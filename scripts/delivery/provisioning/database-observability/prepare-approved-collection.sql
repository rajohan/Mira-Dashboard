\set ON_ERROR_STOP 1

SELECT pg_catalog.set_config(
  'mira_dashboard.collection_lease_token',
  :'collection_lease_token',
  true
);
SELECT pg_catalog.pg_advisory_xact_lock(1835623521, 1668048243);

DO $prepare_approved_collection$
DECLARE
  expected_comment constant text :=
    'mira-dashboard-collection-lease:' ||
    pg_catalog.current_setting('mira_dashboard.collection_lease_token');
  observer pg_catalog.pg_authid%ROWTYPE;
  observer_config text[];
BEGIN
  SELECT * INTO observer
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observer';
  SELECT settings.setconfig INTO observer_config
  FROM pg_catalog.pg_db_role_setting AS settings
  WHERE settings.setrole = observer.oid
    AND settings.setdatabase = 0;
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
    OR NOT COALESCE(observer_config @> ARRAY[
      'default_transaction_read_only=on',
      'statement_timeout=5s',
      'idle_session_timeout=60s',
      'idle_in_transaction_session_timeout=60s',
      'pg_stat_statements.track=none'
    ]::text[], false)
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.usename = 'mira_dashboard_observer'
        AND activity.pid <> pg_catalog.pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION 'Database observability collection role is not closed';
  END IF;
  EXECUTE pg_catalog.format(
    'COMMENT ON ROLE mira_dashboard_observer IS %L',
    expected_comment
  );
  IF pg_catalog.shobj_description(observer.oid, 'pg_authid')
    IS DISTINCT FROM expected_comment
  THEN
    RAISE EXCEPTION 'Database observability collection lease was not prepared';
  END IF;
END
$prepare_approved_collection$;
