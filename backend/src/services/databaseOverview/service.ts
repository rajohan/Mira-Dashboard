import type { DatabaseOverviewResponse } from "../../../../contracts/database.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { stringFallback } from "../../lib/values.ts";
import { getDashboardSqliteOverview } from "../sqliteOverview.ts";
import {
    numberFrom,
    parseTable,
    queryAllUserDatabases,
    queryPgBouncer,
    queryPostgres,
    stringWithDefault,
    sumBy,
} from "./client.ts";
import {
    BLOAT_DETAIL_MINIMUM_BYTES,
    BLOAT_REVIEW_BYTES,
    BLOAT_REVIEW_MINIMUM_BYTES,
    BLOAT_REVIEW_PERCENT,
    CATALOG_TUPLE_ESTIMATE_TOLERANCE_PERCENT,
    HIGH_DEAD_TUPLE_MINIMUM,
    HIGH_DEAD_TUPLE_MINIMUM_BYTES,
    HIGH_DEAD_TUPLE_PERCENT,
    SLOW_QUERY_MEAN_MS,
} from "./policy.ts";
import {
    projectDeadTupleRow,
    projectPgBouncerPoolRow,
    projectPgBouncerStatsRow,
} from "./snapshot.ts";

export { getIsolatedDatabaseOverview } from "./snapshot.ts";

const logger = createStructuredLogger("database-overview");

/** Represents one PostgreSQL database row from pg_stat_database with numeric values encoded as psql strings. */
interface PostgresDatabaseRow {
    datname: string;
    size_pretty: string;
    size_bytes: string;
    numbackends: string;
    xact_commit: string;
    xact_rollback: string;
    blks_hit: string;
    blks_read: string;
    cache_hit_ratio: string;
}

/** Represents a grouped pg_stat_activity connection count by state. */
interface ConnectionCountsRow {
    state: string | undefined;
    count: string;
}

/** Represents table bloat/autovacuum health data for a user table. */
interface DeadTupleRow {
    schemaname: string;
    relname: string;
    physical_bytes: string;
    n_live_tup: string;
    n_dead_tup: string;
    dead_pct: string;
    last_autovacuum: string | undefined;
    last_autoanalyze: string | undefined;
}

/** Represents a conservative catalog-based heap bloat estimate for one table. */
interface BloatEstimateRow {
    schemaname: string;
    relname: string;
    physical_bytes: string;
    estimated_reclaimable_bytes: string;
    assessed: string;
}

/** Represents one pg_stat_statements row for the slowest/highest-cost queries. */
interface TopQueryRow {
    query: string;
    calls: string;
    total_exec_time: string;
    mean_exec_time: string;
    rows: string;
    shared_blks_hit: string;
    shared_blks_read: string;
}

/** Represents one row from PgBouncer SHOW POOLS output. */
interface PgBouncerPoolRow {
    database: string;
    user: string;
    cl_active: string;
    cl_waiting: string;
    sv_active: string;
    sv_idle: string;
    sv_used: string;
    maxwait: string;
    pool_mode: string;
}

/** Represents one row from PgBouncer SHOW STATS output. */
interface PgBouncerStatsRow {
    database: string;
    total_xact_count: string;
    total_query_count: string;
    total_xact_time: string;
    total_query_time: string;
    avg_xact_time: string;
    avg_query_time: string;
    total_received: string;
    total_sent: string;
}

/**
 * Projects a PostgreSQL table-health row onto the public response contract.
 * @param row PostgreSQL table-health row.
 * @returns Contract-safe PostgreSQL table-health row.
 */
/**
 * Returns current torrent counts for Comet and Bitmagnet.
 * @returns current torrent counts for Comet and Bitmagnet.
 */
async function getTorrentCounts() {
    const [cometResult, bitmagnetResult] = await Promise.allSettled([
        queryPostgres("SELECT count(*)::text AS count FROM torrents;", "comet"),
        queryPostgres("SELECT count(*)::text AS count FROM torrents;", "bitmagnet"),
    ]);
    const countFromResult = (
        databaseName: "bitmagnet" | "comet",
        result: PromiseSettledResult<string>
    ) => {
        if (result.status === "rejected") {
            logger.warn("database_overview.torrent_count_failed", {
                database: databaseName,
                error: result.reason,
            });
            return 0;
        }
        return numberFrom(
            stringFallback(parseTable<{ count: string }>(result.value)[0]?.count, "0")
        );
    };

    return {
        comet: countFromResult("comet", cometResult),
        bitmagnet: countFromResult("bitmagnet", bitmagnetResult),
    };
}

function isHighDeadTupleRow(table: DeadTupleRow): boolean {
    return (
        numberFrom(table.physical_bytes) >= HIGH_DEAD_TUPLE_MINIMUM_BYTES &&
        numberFrom(table.dead_pct) >= HIGH_DEAD_TUPLE_PERCENT &&
        numberFrom(table.n_dead_tup) >= HIGH_DEAD_TUPLE_MINIMUM
    );
}

/**
 * Collects PostgreSQL and PgBouncer metrics used by the database overview endpoint.
 * @returns Database overview value.
 */
export async function getDatabaseOverview(): Promise<DatabaseOverviewResponse> {
    const torrentCounts = await getTorrentCounts();

    const databaseRows = parseTable<PostgresDatabaseRow>(
        await queryPostgres(`
            SELECT
                datname,
                pg_size_pretty(pg_database_size(datname)) AS size_pretty,
                pg_database_size(datname)::bigint AS size_bytes,
                numbackends,
                xact_commit,
                xact_rollback,
                blks_hit,
                blks_read,
                ROUND(
                    CASE WHEN (blks_hit + blks_read) = 0 THEN 100
                    ELSE (blks_hit::numeric / NULLIF(blks_hit + blks_read, 0)) * 100
                    END,
                    2
                )::text AS cache_hit_ratio
            FROM pg_stat_database
            WHERE datname IS NOT NULL
              AND datname NOT IN ('template0', 'template1', 'postgres')
            ORDER BY pg_database_size(datname) DESC;
        `)
    );

    const connectionRows = parseTable<ConnectionCountsRow>(
        await queryPostgres(`
            SELECT COALESCE(state, 'unknown') AS state, COUNT(*)::text AS count
            FROM pg_stat_activity
            WHERE datname NOT IN ('template0', 'template1', 'postgres')
            GROUP BY COALESCE(state, 'unknown')
            ORDER BY COUNT(*) DESC;
        `)
    );

    const allDeadTupleRows = await queryAllUserDatabases<DeadTupleRow>(`
        WITH table_estimates AS (
            SELECT
                tables.schemaname,
                tables.relname,
                tables.relid,
                tables.n_live_tup,
                tables.n_dead_tup,
                tables.last_autovacuum,
                tables.last_autoanalyze,
                CASE
                    WHEN classes.reltuples > 0 AND
                         tables.n_live_tup < classes.reltuples AND
                         ABS(
                             tables.n_live_tup::numeric +
                             tables.n_dead_tup::numeric -
                             classes.reltuples::numeric
                         ) / classes.reltuples::numeric * 100 <=
                             ${CATALOG_TUPLE_ESTIMATE_TOLERANCE_PERCENT}
                    THEN tables.n_live_tup::numeric
                    ELSE GREATEST(
                        tables.n_live_tup::numeric,
                        classes.reltuples::numeric
                    )
                END AS estimated_live_tuples
            FROM pg_stat_user_tables AS tables
            JOIN pg_class AS classes ON classes.oid = tables.relid
        )
        SELECT
            estimates.schemaname,
            estimates.relname,
            pg_relation_size(estimates.relid)::text AS physical_bytes,
            estimates.n_live_tup::text,
            estimates.n_dead_tup::text,
            ROUND(
                CASE WHEN estimates.estimated_live_tuples <= 0 THEN 0
                ELSE (
                    estimates.n_dead_tup::numeric /
                    NULLIF(estimates.estimated_live_tuples, 0)
                ) * 100
                END,
                2
            )::text AS dead_pct,
            COALESCE(estimates.last_autovacuum::text, '') AS last_autovacuum,
            COALESCE(estimates.last_autoanalyze::text, '') AS last_autoanalyze
        FROM table_estimates AS estimates
        WHERE estimates.n_live_tup > 0 OR estimates.n_dead_tup > 0
        ORDER BY estimates.n_dead_tup DESC;
    `);
    const deadTupleRows = allDeadTupleRows
        .toSorted(
            (a, b) =>
                Number(isHighDeadTupleRow(b)) - Number(isHighDeadTupleRow(a)) ||
                numberFrom(b.n_dead_tup) - numberFrom(a.n_dead_tup)
        )
        .slice(0, 25);

    // Catalog statistics keep this hourly check bounded; tuple overhead and 20% headroom
    // deliberately bias the estimate below what VACUUM FULL might actually recover.
    const bloatEstimates = await queryAllUserDatabases<BloatEstimateRow>(`
        WITH average_row_widths AS (
            SELECT schemaname, tablename, SUM(avg_width)::numeric AS row_width
            FROM pg_stats
            GROUP BY schemaname, tablename
        ), table_estimates AS (
            SELECT
                tables.schemaname,
                tables.relname,
                tables.relid,
                GREATEST(
                    tables.n_live_tup::numeric,
                    classes.reltuples::numeric
                ) AS estimated_live_tuples,
                (
                    tables.n_live_tup < classes.reltuples AND
                    tables.n_dead_tup >= ${HIGH_DEAD_TUPLE_MINIMUM} AND
                    (
                        (
                            tables.n_dead_tup::numeric /
                            NULLIF(classes.reltuples::numeric, 0)
                        ) * 100 >= ${HIGH_DEAD_TUPLE_PERCENT} OR
                        (
                            pg_relation_size(tables.relid)::numeric *
                            tables.n_dead_tup::numeric /
                            NULLIF(classes.reltuples::numeric, 0)
                        ) >= ${BLOAT_REVIEW_BYTES}
                    )
                ) AS catalog_estimate_may_be_stale
            FROM pg_stat_user_tables AS tables
            JOIN pg_class AS classes ON classes.oid = tables.relid
        )
        SELECT
            estimates.schemaname,
            estimates.relname,
            pg_relation_size(estimates.relid)::text AS physical_bytes,
            CASE
                WHEN widths.row_width IS NULL OR
                     estimates.estimated_live_tuples <= 0 OR
                     estimates.catalog_estimate_may_be_stale THEN ''
                ELSE GREATEST(
                    pg_relation_size(estimates.relid) - CEIL(
                        estimates.estimated_live_tuples *
                        (widths.row_width + 32) * 1.2
                    ),
                    0
                )::bigint::text
            END AS estimated_reclaimable_bytes,
            (widths.row_width IS NOT NULL AND
             estimates.estimated_live_tuples > 0 AND
             NOT estimates.catalog_estimate_may_be_stale)::text AS assessed
        FROM table_estimates AS estimates
        LEFT JOIN average_row_widths AS widths
          ON widths.schemaname = estimates.schemaname
         AND widths.tablename = estimates.relname
        WHERE pg_relation_size(estimates.relid) > 0;
    `);
    const assessedBloatEstimates = bloatEstimates.filter(
        (row) => row.assessed === "true"
    );
    const physicalTableBytes = sumBy(assessedBloatEstimates, (row) =>
        numberFrom(row.physical_bytes)
    );
    const estimatedReclaimableBytes = sumBy(assessedBloatEstimates, (row) =>
        numberFrom(row.estimated_reclaimable_bytes)
    );
    const unassessedTableCount = bloatEstimates.length - assessedBloatEstimates.length;
    const unassessedPhysicalBytes = sumBy(
        bloatEstimates.filter((row) => row.assessed !== "true"),
        (row) => numberFrom(row.physical_bytes)
    );
    const isBloatAssessmentIncomplete =
        unassessedPhysicalBytes >= BLOAT_REVIEW_MINIMUM_BYTES;
    const estimatedReclaimablePercent =
        physicalTableBytes > 0
            ? (estimatedReclaimableBytes / physicalTableBytes) * 100
            : 0;
    const requiresBloatReview =
        estimatedReclaimableBytes >= BLOAT_REVIEW_BYTES ||
        (estimatedReclaimableBytes >= BLOAT_REVIEW_MINIMUM_BYTES &&
            estimatedReclaimablePercent >= BLOAT_REVIEW_PERCENT);

    const pgStatStatementsResult = await queryPostgres(`
        SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements';
    `);
    const pgStatStatementsEnabled = pgStatStatementsResult.includes("pg_stat_statements");
    const topQueries = pgStatStatementsEnabled
        ? parseTable<TopQueryRow>(
              await queryPostgres(String.raw`
                SELECT
                    regexp_replace(query, '\s+', ' ', 'g') AS query,
                    calls::text,
                    ROUND(total_exec_time::numeric, 2)::text AS total_exec_time,
                    ROUND(mean_exec_time::numeric, 2)::text AS mean_exec_time,
                    rows::text,
                    shared_blks_hit::text,
                    shared_blks_read::text
                FROM pg_stat_statements
                ORDER BY total_exec_time DESC
                LIMIT 20;
            `)
          )
        : [];
    const slowQueryCount = topQueries.filter(
        (query) => numberFrom(query.mean_exec_time) >= SLOW_QUERY_MEAN_MS
    ).length;
    const highDeadTupleTableCount = allDeadTupleRows.filter((row) =>
        isHighDeadTupleRow(row)
    ).length;
    const maintenanceHintCount =
        slowQueryCount + highDeadTupleTableCount + (requiresBloatReview ? 1 : 0);

    const pgBouncerPools = parseTable<PgBouncerPoolRow>(
        await queryPgBouncer("SHOW POOLS;")
    );
    const pgBouncerStats = parseTable<PgBouncerStatsRow>(
        await queryPgBouncer("SHOW STATS;")
    );

    const connections = Object.fromEntries(
        connectionRows.map((row) => [
            stringWithDefault(row.state, "unknown"),
            numberFrom(row.count),
        ])
    );
    const totalDatabaseSizeBytes = sumBy(databaseRows, (row) =>
        numberFrom(row.size_bytes)
    );
    const totalBackends = sumBy(databaseRows, (row) => numberFrom(row.numbackends));
    const averageCacheHitRatio =
        databaseRows.length > 0
            ? sumBy(databaseRows, (row) => numberFrom(row.cache_hit_ratio)) /
              databaseRows.length
            : 0;
    const waitingClients = sumBy(pgBouncerPools, (row) => numberFrom(row.cl_waiting));
    const clientConnections = sumBy(
        pgBouncerPools,
        (row) => numberFrom(row.cl_active) + numberFrom(row.cl_waiting)
    );
    const serverConnections = sumBy(
        pgBouncerPools,
        (row) =>
            numberFrom(row.sv_active) + numberFrom(row.sv_idle) + numberFrom(row.sv_used)
    );
    let maxWait = 0;
    for (const row of pgBouncerPools) {
        maxWait = Math.max(maxWait, numberFrom(row.maxwait));
    }
    const avgQueryTime =
        pgBouncerStats.length > 0
            ? sumBy(pgBouncerStats, (row) => numberFrom(row.avg_query_time)) /
              pgBouncerStats.length
            : 0;
    const avgTransactionTime =
        pgBouncerStats.length > 0
            ? sumBy(pgBouncerStats, (row) => numberFrom(row.avg_xact_time)) /
              pgBouncerStats.length
            : 0;
    const sqlite = getDashboardSqliteOverview();

    let maintenanceStatus: "healthy" | "not_assessed" | "review" =
        isBloatAssessmentIncomplete ? "not_assessed" : "healthy";
    if (maintenanceHintCount > 0) {
        maintenanceStatus = "review";
    }
    return {
        checkedAt: new Date().toISOString(),
        mode: "full",
        overview: {
            totalDatabaseSizeBytes,
            managedDatabaseCount: databaseRows.length + 1,
            totalManagedDatabaseSizeBytes: totalDatabaseSizeBytes + sqlite.storageBytes,
            totalBackends,
            averageCacheHitRatio,
            connections,
            pgStatStatementsEnabled,
            torrentCounts,
            pgbouncer: {
                clientConnections,
                serverConnections,
                waitingClients,
                maxWait,
                avgQueryTime,
                avgTransactionTime,
            },
            maintenance: {
                status: maintenanceStatus,
                hintCount: maintenanceHintCount,
                requiresBloatReview,
                isBloatAssessmentIncomplete,
                unassessedTableCount,
                unassessedPhysicalBytes,
                slowQueryCount,
                highDeadTupleTableCount,
                physicalTableBytes,
                estimatedReclaimableBytes,
                estimatedReclaimablePercent,
                reviewThresholdBytes: BLOAT_REVIEW_BYTES,
                reviewMinimumBytes: BLOAT_REVIEW_MINIMUM_BYTES,
                reviewThresholdPercent: BLOAT_REVIEW_PERCENT,
            },
        },
        databases: databaseRows,
        deadTuples: deadTupleRows.map((row) => projectDeadTupleRow(row)),
        bloatEstimates: bloatEstimates
            .filter(
                (row) =>
                    row.assessed === "true" &&
                    numberFrom(row.estimated_reclaimable_bytes) >=
                        BLOAT_DETAIL_MINIMUM_BYTES
            )
            .toSorted(
                (a, b) =>
                    numberFrom(b.estimated_reclaimable_bytes) -
                    numberFrom(a.estimated_reclaimable_bytes)
            )
            .slice(0, 25),
        topQueries,
        pgbouncerPools: pgBouncerPools.map((row) => projectPgBouncerPoolRow(row)),
        pgbouncerStats: pgBouncerStats.map((row) => projectPgBouncerStatsRow(row)),
        sqlite,
    };
}
