\set ON_ERROR_STOP 1

-- CREATE DATABASE cannot run inside a transaction. This psql-only artifact
-- emits at most one fixed CREATE statement and lets \gexec autocommit it.
SET SESSION mira_dashboard.apply_control_database_capability
  TO :'apply_control_database_capability';

DO $approval_and_preflight$
DECLARE
  capability_exists boolean;
  catalog_database_count bigint;
  observed_database_count bigint;
  execution_role_is_superuser boolean;
BEGIN
  SELECT rolsuper INTO execution_role_is_superuser
  FROM pg_catalog.pg_roles
  WHERE rolname = CURRENT_USER;
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_database
    WHERE datname = 'mira_dashboard_observability'
  ) INTO capability_exists;
  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (
      WHERE NOT datistemplate AND datallowconn
    )
  INTO catalog_database_count, observed_database_count
  FROM pg_catalog.pg_database;

  IF pg_catalog.current_setting(
      'mira_dashboard.apply_control_database_capability',
      true
    ) IS DISTINCT FROM 'approved'
    OR NOT execution_role_is_superuser
    OR catalog_database_count + CASE WHEN capability_exists THEN 0 ELSE 1 END > 80
    OR observed_database_count + CASE WHEN capability_exists THEN 0 ELSE 1 END > 64
  THEN
    RAISE EXCEPTION 'Database observability control capability preflight failed';
  END IF;

  IF capability_exists AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS capability
    JOIN pg_catalog.pg_database AS template
      ON template.datname = 'template0'
    JOIN pg_catalog.pg_roles AS owners ON owners.oid = capability.datdba
    WHERE capability.datname = 'mira_dashboard_observability'
      AND owners.rolname = CURRENT_USER
      AND owners.rolsuper
      AND NOT capability.datistemplate
      AND capability.datallowconn
      AND NOT capability.dathasloginevt
      AND capability.datconnlimit = 4
      AND capability.encoding = template.encoding
      AND capability.datlocprovider = template.datlocprovider
      AND capability.datcollate = template.datcollate
      AND capability.datctype = template.datctype
      AND capability.datlocale IS NOT DISTINCT FROM template.datlocale
      AND capability.daticurules IS NOT DISTINCT FROM template.daticurules
      AND capability.dattablespace = template.dattablespace
  ) THEN
    RAISE EXCEPTION 'Database observability control capability is invalid';
  END IF;
END
$approval_and_preflight$;

SELECT pg_catalog.format(
  'CREATE DATABASE mira_dashboard_observability OWNER %I TEMPLATE template0 CONNECTION LIMIT 4 STRATEGY WAL_LOG',
  CURRENT_USER
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_database
  WHERE datname = 'mira_dashboard_observability'
)
\gexec

REVOKE ALL PRIVILEGES ON DATABASE mira_dashboard_observability FROM PUBLIC;

DO $verify_created_capability$
DECLARE
  capability_oid oid;
  catalog_database_count bigint;
  observed_database_count bigint;
BEGIN
  SELECT capability.oid INTO capability_oid
  FROM pg_catalog.pg_database AS capability
  JOIN pg_catalog.pg_database AS template
    ON template.datname = 'template0'
  JOIN pg_catalog.pg_roles AS owners ON owners.oid = capability.datdba
  WHERE capability.datname = 'mira_dashboard_observability'
    AND owners.rolname = CURRENT_USER
    AND owners.rolsuper
    AND NOT capability.datistemplate
    AND capability.datallowconn
    AND NOT capability.dathasloginevt
    AND capability.datconnlimit = 4
    AND capability.encoding = template.encoding
    AND capability.datlocprovider = template.datlocprovider
    AND capability.datcollate = template.datcollate
    AND capability.datctype = template.datctype
    AND capability.datlocale IS NOT DISTINCT FROM template.datlocale
    AND capability.daticurules IS NOT DISTINCT FROM template.daticurules
    AND capability.dattablespace = template.dattablespace;

  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (
      WHERE NOT databases.datistemplate AND databases.datallowconn
    )
  INTO catalog_database_count, observed_database_count
  FROM pg_catalog.pg_database AS databases;

  IF capability_oid IS NULL
    OR catalog_database_count > 80
    OR observed_database_count > 64
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database AS capability
      CROSS JOIN LATERAL pg_catalog.aclexplode(capability.datacl) AS grants
      LEFT JOIN pg_catalog.pg_roles AS grantees ON grantees.oid = grants.grantee
      WHERE capability.oid = capability_oid
        AND (
          grants.grantee = 0
          OR grantees.rolname NOT IN (
            CURRENT_USER,
            'mira_dashboard_observer',
            'mira_dashboard_database_access_reconciler'
          )
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability control capability verification failed';
  END IF;
END
$verify_created_capability$;

RESET mira_dashboard.apply_control_database_capability;
