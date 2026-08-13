\set ON_ERROR_STOP 1

BEGIN;

DO $capability_boundary$
DECLARE
  capability_owner_oid oid;
  capability_schema_oid oid;
  view_owner_oid oid;
BEGIN
  SELECT roles.oid INTO capability_owner_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observability_capability_owner'
    AND NOT roles.rolcanlogin
    AND roles.rolinherit
    AND NOT roles.rolsuper
    AND NOT roles.rolcreatedb
    AND NOT roles.rolcreaterole
    AND NOT roles.rolreplication
    AND NOT roles.rolbypassrls;
  SELECT roles.oid INTO view_owner_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observability_owner'
    AND NOT roles.rolcanlogin
    AND NOT roles.rolinherit
    AND NOT roles.rolsuper
    AND NOT roles.rolcreatedb
    AND NOT roles.rolcreaterole
    AND NOT roles.rolreplication
    AND NOT roles.rolbypassrls;

  IF capability_owner_oid IS NULL
    OR view_owner_oid IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS execution_role
      WHERE execution_role.rolname = CURRENT_USER
        AND execution_role.rolsuper
    )
  THEN
    RAISE EXCEPTION 'Database observability capability administrator is invalid';
  END IF;

  SELECT namespaces.oid INTO capability_schema_oid
  FROM pg_catalog.pg_namespace AS namespaces
  WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities';

  IF capability_schema_oid IS NOT NULL AND (
    (SELECT namespaces.nspowner
     FROM pg_catalog.pg_namespace AS namespaces
     WHERE namespaces.oid = capability_schema_oid)
      IS DISTINCT FROM view_owner_oid
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS classes
      WHERE classes.relnamespace = capability_schema_oid
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type AS types
      WHERE types.typnamespace = capability_schema_oid
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routines
      WHERE routines.pronamespace = capability_schema_oid
        AND NOT (
          routines.pronargs = 0
          AND routines.proowner = capability_owner_oid
          AND routines.proname IN ('table_health', 'maintenance_metrics')
          OR pg_catalog.current_database() = 'mira_dashboard_observability'
            AND routines.pronargs = 0
            AND routines.proowner = capability_owner_oid
            AND routines.proname IN ('connection_metrics', 'statement_metrics')
        )
    )
  ) THEN
    RAISE EXCEPTION 'Database observability capability schema boundary is invalid';
  END IF;
END
$capability_boundary$;

CREATE SCHEMA IF NOT EXISTS mira_dashboard_observability_capabilities
  AUTHORIZATION mira_dashboard_observability_owner;
REVOKE ALL PRIVILEGES ON SCHEMA
  mira_dashboard_observability_capabilities FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA
  mira_dashboard_observability_capabilities FROM mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON SCHEMA
  mira_dashboard_observability_capabilities
  FROM mira_dashboard_observability_capability_owner;
GRANT USAGE ON SCHEMA mira_dashboard_observability_capabilities
  TO mira_dashboard_observability_capability_owner;
GRANT USAGE ON SCHEMA mira_dashboard_observability_capabilities
  TO mira_dashboard_observer;

REVOKE ALL PRIVILEGES ON TABLE pg_catalog.pg_statistic
  FROM mira_dashboard_observability_capability_owner;
GRANT SELECT ON TABLE pg_catalog.pg_statistic
  TO mira_dashboard_observability_capability_owner;
ALTER DEFAULT PRIVILEGES
  FOR ROLE mira_dashboard_observability_capability_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DROP FUNCTION IF EXISTS
  mira_dashboard_observability_capabilities.table_health();
DROP FUNCTION IF EXISTS
  mira_dashboard_observability_capabilities.maintenance_metrics();

CREATE FUNCTION mira_dashboard_observability_capabilities.table_health()
RETURNS TABLE (
  schema_name name,
  table_name name,
  physical_bytes bigint,
  live_tuples bigint,
  dead_tuples bigint,
  last_autovacuum_at_ms bigint,
  last_autoanalyze_at_ms bigint,
  dead_tuple_percent numeric,
  assessed boolean,
  estimated_reclaimable_bytes bigint
)
LANGUAGE sql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
ROWS 25
SET search_path TO pg_catalog, pg_temp
SET statement_timeout TO '5s'
BEGIN ATOMIC
  WITH average_row_widths AS (
    SELECT namespaces.nspname AS schemaname,
           classes.relname AS tablename,
           pg_catalog.sum(statistics.stawidth)::numeric AS row_width
    FROM pg_catalog.pg_statistic AS statistics
    JOIN pg_catalog.pg_class AS classes
      ON classes.oid = statistics.starelid
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    JOIN pg_catalog.pg_attribute AS attributes
      ON attributes.attrelid = statistics.starelid
     AND attributes.attnum = statistics.staattnum
     AND NOT attributes.attisdropped
    WHERE classes.relkind = 'r'
      AND NOT classes.relispartition
      AND NOT classes.relrowsecurity
      AND NOT classes.relforcerowsecurity
      AND namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
    GROUP BY namespaces.nspname, classes.relname
  ), table_estimates AS (
    SELECT tables.schemaname,
           tables.relname,
           tables.relid,
           tables.n_live_tup,
           tables.n_dead_tup,
           tables.last_autovacuum,
           tables.last_autoanalyze,
           GREATEST(
             tables.n_live_tup::numeric,
             classes.reltuples::numeric
           ) AS estimated_live_tuples,
           CASE
             WHEN classes.reltuples > 0
              AND tables.n_live_tup < classes.reltuples
              AND pg_catalog.abs(
                tables.n_live_tup::numeric + tables.n_dead_tup::numeric -
                classes.reltuples::numeric
              ) / classes.reltuples::numeric * 100 <= 10
             THEN tables.n_live_tup::numeric
             ELSE GREATEST(
               tables.n_live_tup::numeric,
               classes.reltuples::numeric
             )
           END AS dead_tuple_live_estimate,
           (
             tables.n_live_tup < classes.reltuples
             AND tables.n_dead_tup >= 1000
             AND (
               tables.n_dead_tup::numeric /
                 NULLIF(classes.reltuples::numeric, 0) * 100 >= 20
               OR pg_catalog.pg_relation_size(tables.relid)::numeric *
                 tables.n_dead_tup::numeric /
                 NULLIF(classes.reltuples::numeric, 0) >= 5368709120
             )
           ) AS catalog_estimate_may_be_stale
    FROM pg_catalog.pg_stat_user_tables AS tables
    JOIN pg_catalog.pg_class AS classes ON classes.oid = tables.relid
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    WHERE classes.relkind = 'r'
      AND NOT classes.relispartition
      AND NOT classes.relrowsecurity
      AND NOT classes.relforcerowsecurity
      AND namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
  )
  SELECT estimates.schemaname AS schema_name,
         estimates.relname AS table_name,
         pg_catalog.pg_relation_size(estimates.relid)::bigint AS physical_bytes,
         estimates.n_live_tup::bigint AS live_tuples,
         estimates.n_dead_tup::bigint AS dead_tuples,
         (pg_catalog.date_part('epoch', estimates.last_autovacuum) * 1000)::bigint
           AS last_autovacuum_at_ms,
         (pg_catalog.date_part('epoch', estimates.last_autoanalyze) * 1000)::bigint
           AS last_autoanalyze_at_ms,
         LEAST(
           100,
           pg_catalog.round(
             CASE WHEN estimates.dead_tuple_live_estimate <= 0 THEN 0
                  ELSE estimates.n_dead_tup::numeric /
                    NULLIF(estimates.dead_tuple_live_estimate, 0) * 100
             END,
             2
           )
         ) AS dead_tuple_percent,
         (
           widths.row_width IS NOT NULL
           AND estimates.estimated_live_tuples > 0
           AND NOT estimates.catalog_estimate_may_be_stale
         ) AS assessed,
         CASE
           WHEN widths.row_width IS NULL
             OR estimates.estimated_live_tuples <= 0
             OR estimates.catalog_estimate_may_be_stale
           THEN NULL
           ELSE GREATEST(
             pg_catalog.pg_relation_size(estimates.relid) - pg_catalog.ceil(
               estimates.estimated_live_tuples * (widths.row_width + 32) * 1.2
             ),
             0
           )::bigint
         END AS estimated_reclaimable_bytes
  FROM table_estimates AS estimates
  LEFT JOIN average_row_widths AS widths
    ON widths.schemaname = estimates.schemaname
   AND widths.tablename = estimates.relname
  WHERE pg_catalog.pg_relation_size(estimates.relid) > 0
  ORDER BY (
             pg_catalog.pg_relation_size(estimates.relid) >= 67108864
             AND LEAST(
               100,
               pg_catalog.round(
                 CASE WHEN estimates.dead_tuple_live_estimate <= 0 THEN 0
                      ELSE estimates.n_dead_tup::numeric /
                        NULLIF(
                          estimates.dead_tuple_live_estimate,
                          0
                        ) * 100
                 END,
                 2
               )
             ) >= 20
             AND estimates.n_dead_tup >= 1000
           ) DESC,
           estimated_reclaimable_bytes DESC NULLS LAST,
           estimates.n_dead_tup DESC,
           estimates.schemaname,
           estimates.relname
  LIMIT 25;
END;

ALTER FUNCTION mira_dashboard_observability_capabilities.table_health()
  OWNER TO mira_dashboard_observability_capability_owner;

CREATE FUNCTION mira_dashboard_observability_capabilities.maintenance_metrics()
RETURNS TABLE (
  assessed_physical_bytes bigint,
  estimated_reclaimable_bytes bigint,
  high_dead_tuple_table_count bigint,
  unassessed_physical_bytes bigint,
  unassessed_table_count bigint
)
LANGUAGE sql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
ROWS 1
SET search_path TO pg_catalog, pg_temp
SET statement_timeout TO '5s'
BEGIN ATOMIC
  WITH average_row_widths AS (
    SELECT namespaces.nspname AS schemaname,
           classes.relname AS tablename,
           pg_catalog.sum(statistics.stawidth)::numeric AS row_width
    FROM pg_catalog.pg_statistic AS statistics
    JOIN pg_catalog.pg_class AS classes
      ON classes.oid = statistics.starelid
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    JOIN pg_catalog.pg_attribute AS attributes
      ON attributes.attrelid = statistics.starelid
     AND attributes.attnum = statistics.staattnum
     AND NOT attributes.attisdropped
    WHERE classes.relkind = 'r'
      AND NOT classes.relispartition
      AND NOT classes.relrowsecurity
      AND NOT classes.relforcerowsecurity
      AND namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
    GROUP BY namespaces.nspname, classes.relname
  ), table_estimates AS (
    SELECT tables.schemaname,
           tables.relname,
           tables.relid,
           tables.n_live_tup,
           tables.n_dead_tup,
           GREATEST(
             tables.n_live_tup::numeric,
             classes.reltuples::numeric
           ) AS estimated_live_tuples,
           CASE
             WHEN classes.reltuples > 0
              AND tables.n_live_tup < classes.reltuples
              AND pg_catalog.abs(
                tables.n_live_tup::numeric + tables.n_dead_tup::numeric -
                classes.reltuples::numeric
              ) / classes.reltuples::numeric * 100 <= 10
             THEN tables.n_live_tup::numeric
             ELSE GREATEST(
               tables.n_live_tup::numeric,
               classes.reltuples::numeric
             )
           END AS dead_tuple_live_estimate,
           (
             tables.n_live_tup < classes.reltuples
             AND tables.n_dead_tup >= 1000
             AND (
               tables.n_dead_tup::numeric /
                 NULLIF(classes.reltuples::numeric, 0) * 100 >= 20
               OR pg_catalog.pg_relation_size(tables.relid)::numeric *
                 tables.n_dead_tup::numeric /
                 NULLIF(classes.reltuples::numeric, 0) >= 5368709120
             )
           ) AS catalog_estimate_may_be_stale
    FROM pg_catalog.pg_stat_user_tables AS tables
    JOIN pg_catalog.pg_class AS classes ON classes.oid = tables.relid
    JOIN pg_catalog.pg_namespace AS namespaces
      ON namespaces.oid = classes.relnamespace
    WHERE classes.relkind = 'r'
      AND NOT classes.relispartition
      AND NOT classes.relrowsecurity
      AND NOT classes.relforcerowsecurity
      AND namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND namespaces.nspname NOT LIKE 'pg_temp_%'
  ), projections AS (
    SELECT pg_catalog.pg_relation_size(estimates.relid)::bigint AS physical_bytes,
           estimates.n_dead_tup::bigint AS dead_tuples,
           LEAST(
             100,
             pg_catalog.round(
               CASE WHEN estimates.dead_tuple_live_estimate <= 0 THEN 0
                    ELSE estimates.n_dead_tup::numeric /
                      NULLIF(estimates.dead_tuple_live_estimate, 0) * 100
               END,
               2
             )
           ) AS dead_tuple_percent,
           (
             widths.row_width IS NOT NULL
             AND estimates.estimated_live_tuples > 0
             AND NOT estimates.catalog_estimate_may_be_stale
           ) AS assessed,
           CASE
             WHEN widths.row_width IS NULL
               OR estimates.estimated_live_tuples <= 0
               OR estimates.catalog_estimate_may_be_stale
             THEN 0
             ELSE GREATEST(
               pg_catalog.pg_relation_size(estimates.relid) - pg_catalog.ceil(
                 estimates.estimated_live_tuples * (widths.row_width + 32) * 1.2
               ),
               0
             )::bigint
           END AS estimated_reclaimable_bytes
    FROM table_estimates AS estimates
    LEFT JOIN average_row_widths AS widths
      ON widths.schemaname = estimates.schemaname
     AND widths.tablename = estimates.relname
    WHERE pg_catalog.pg_relation_size(estimates.relid) > 0
  )
  SELECT COALESCE(
           pg_catalog.sum(projections.physical_bytes)
             FILTER (WHERE projections.assessed),
           0
         )::bigint AS assessed_physical_bytes,
         COALESCE(
           pg_catalog.sum(projections.estimated_reclaimable_bytes)
             FILTER (WHERE projections.assessed),
           0
         )::bigint AS estimated_reclaimable_bytes,
         pg_catalog.count(*) FILTER (
           WHERE projections.physical_bytes >= 67108864
             AND projections.dead_tuple_percent >= 20
             AND projections.dead_tuples >= 1000
         )::bigint AS high_dead_tuple_table_count,
         COALESCE(
           pg_catalog.sum(projections.physical_bytes)
             FILTER (WHERE NOT projections.assessed),
           0
         )::bigint AS unassessed_physical_bytes,
         pg_catalog.count(*) FILTER (WHERE NOT projections.assessed)::bigint
           AS unassessed_table_count
  FROM projections;
END;

ALTER FUNCTION mira_dashboard_observability_capabilities.maintenance_metrics()
  OWNER TO mira_dashboard_observability_capability_owner;

RESET ROLE;

REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_observability_capabilities.table_health() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_observability_capabilities.table_health()
  FROM mira_dashboard_observer;
GRANT EXECUTE ON FUNCTION
  mira_dashboard_observability_capabilities.table_health()
  TO mira_dashboard_observer;
REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_observability_capabilities.maintenance_metrics() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  mira_dashboard_observability_capabilities.maintenance_metrics()
  FROM mira_dashboard_observer;
GRANT EXECUTE ON FUNCTION
  mira_dashboard_observability_capabilities.maintenance_metrics()
  TO mira_dashboard_observer;

COMMIT;
