\set ON_ERROR_STOP 1

DO $verify_control_database_capability$
DECLARE
  database_owner_oid oid;
  database_owner_is_superuser boolean;
  extension_names text[];
  extension_shapes text[];
BEGIN
  SELECT capability.datdba, owners.rolsuper
  INTO database_owner_oid, database_owner_is_superuser
  FROM pg_catalog.pg_database AS capability
  JOIN pg_catalog.pg_database AS template
    ON template.datname = 'template0'
  JOIN pg_catalog.pg_roles AS owners ON owners.oid = capability.datdba
  WHERE capability.datname = pg_catalog.current_database()
    AND capability.datname = 'mira_dashboard_observability'
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

  SELECT pg_catalog.array_agg(extensions.extname::text ORDER BY extensions.extname)
  INTO extension_names
  FROM pg_catalog.pg_extension AS extensions;

  SELECT pg_catalog.array_agg(
    extensions.extname::text || ':' || namespaces.nspname::text
    ORDER BY extensions.extname
  )
  INTO extension_shapes
  FROM pg_catalog.pg_extension AS extensions
  JOIN pg_catalog.pg_namespace AS namespaces
    ON namespaces.oid = extensions.extnamespace;

  IF database_owner_oid IS NULL
    OR NOT database_owner_is_superuser
    OR extension_names IS DISTINCT FROM ARRAY[
      'pg_stat_statements',
      'plpgsql'
    ]::text[]
    OR extension_shapes IS DISTINCT FROM ARRAY[
      'pg_stat_statements:public',
      'plpgsql:pg_catalog'
    ]::text[]
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_extension AS extensions
      WHERE extensions.extowner IS DISTINCT FROM database_owner_oid
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database AS capability
      CROSS JOIN LATERAL pg_catalog.aclexplode(capability.datacl) AS grants
      WHERE capability.oid = (
        SELECT oid FROM pg_catalog.pg_database
        WHERE datname = pg_catalog.current_database()
      )
        AND grants.grantee = 0
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database AS capability
      CROSS JOIN LATERAL pg_catalog.aclexplode(capability.datacl) AS grants
      LEFT JOIN pg_catalog.pg_roles AS grantees ON grantees.oid = grants.grantee
      WHERE capability.oid = (
        SELECT oid FROM pg_catalog.pg_database
        WHERE datname = pg_catalog.current_database()
      )
        AND grants.grantee <> 0
        AND grantees.rolname NOT IN (
          CURRENT_USER,
          'mira_dashboard_observer',
          'mira_dashboard_database_access_reconciler'
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability control database capability is invalid';
  END IF;
END
$verify_control_database_capability$;
