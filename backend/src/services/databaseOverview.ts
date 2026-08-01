import { isIP } from "node:net";

import type {
    DatabaseOverviewResponse,
    PgBouncerPoolSummary,
    PgBouncerStatsSummary,
    PostgresDeadTupleSummary,
} from "../../../contracts/database.ts";
import { runProcess } from "../lib/processes.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { stringFallback } from "../lib/values.ts";
import { getDashboardSqliteOverview } from "./sqliteOverview.ts";

const DOCKER_EXEC_TIMEOUT_MS = 30_000;
const BLOAT_REVIEW_BYTES = 5 * 1024 * 1024 * 1024;
const BLOAT_REVIEW_MINIMUM_BYTES = 1024 * 1024 * 1024;
const BLOAT_REVIEW_PERCENT = 25;
const BLOAT_DETAIL_MINIMUM_BYTES = 64 * 1024 * 1024;
const SLOW_QUERY_MEAN_MS = 500;
const HIGH_DEAD_TUPLE_PERCENT = 20;
const HIGH_DEAD_TUPLE_MINIMUM = 1000;
const HIGH_DEAD_TUPLE_MINIMUM_BYTES = 64 * 1024 * 1024;
const CATALOG_TUPLE_ESTIMATE_TOLERANCE_PERCENT = 10;
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
function projectDeadTupleRow(row: PostgresDeadTupleSummary): PostgresDeadTupleSummary {
    return {
        ...(row.database === undefined ? {} : { database: row.database }),
        dead_pct: row.dead_pct,
        ...(row.last_autoanalyze === undefined
            ? {}
            : { last_autoanalyze: row.last_autoanalyze }),
        ...(row.last_autovacuum === undefined
            ? {}
            : { last_autovacuum: row.last_autovacuum }),
        n_dead_tup: row.n_dead_tup,
        n_live_tup: row.n_live_tup,
        relname: row.relname,
        schemaname: row.schemaname,
    };
}

/**
 * Projects a dynamic PgBouncer pool row onto the fields consumed by the UI.
 * @param row PgBouncer pool row.
 * @returns Contract-safe PgBouncer pool row.
 */
function projectPgBouncerPoolRow(row: PgBouncerPoolSummary): PgBouncerPoolSummary {
    return {
        cl_active: row.cl_active,
        cl_waiting: row.cl_waiting,
        database: row.database,
        maxwait: row.maxwait,
        pool_mode: row.pool_mode,
        sv_active: row.sv_active,
        sv_idle: row.sv_idle,
        sv_used: row.sv_used,
        user: row.user,
    };
}

/**
 * Projects a dynamic PgBouncer statistics row onto the public response contract.
 * @param row PgBouncer statistics row.
 * @returns Contract-safe PgBouncer statistics row.
 */
function projectPgBouncerStatsRow(row: PgBouncerStatsSummary): PgBouncerStatsSummary {
    return {
        avg_query_time: row.avg_query_time,
        avg_xact_time: row.avg_xact_time,
        database: row.database,
        total_query_count: row.total_query_count,
        total_query_time: row.total_query_time,
        total_received: row.total_received,
        total_sent: row.total_sent,
        total_xact_count: row.total_xact_count,
        total_xact_time: row.total_xact_time,
    };
}

/**
 * Parses tab-delimited psql --no-align output into typed row objects; blank/header-only output returns an empty array.
 * @param output Output value.
 * @returns Parsed tab-delimited psql --no-align output into typed row objects; blank/header-only output returns an empty array.
 */
function parseTable<T extends object>(output: string): T[] {
    const trimmed = output.trim();
    if (!trimmed) {
        return [];
    }

    const lines = trimmed.split("\n").filter(Boolean);
    if (lines.length < 2) {
        return [];
    }

    const headerLine = lines[0];
    if (headerLine === undefined) {
        return [];
    }
    const headers = headerLine.split("\t");
    return lines.slice(1).map((line) => {
        const cells = line.split("\t");
        return Object.fromEntries(
            headers.map((header, index) => [header, cells[index] ?? ""])
        ) as T;
    });
}

/**
 * Returns a string value or a fallback using the route's existing falsy-value behavior.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns a string value or a fallback using the route's existing falsy-value behavior.
 */
function stringWithDefault(value: string | undefined, fallback: string): string {
    return value || fallback;
}

/**
 * Converts psql numeric text to a number, preserving the existing falsy-to-zero behavior.
 * @param value Value to process.
 * @returns Converted psql numeric text to a number, preserving the existing falsy-to-zero behavior.
 */
function numberFrom(value: string | undefined): number {
    return Number(value || 0);
}

/**
 * Runs a command inside a Docker container and returns raw stdout.
 * @param container Container value.
 * @param command Command value.
 * @param environment Environment value.
 * @returns Promise resolving to the run docker exec result.
 */
async function runDockerExec(
    container: string,
    command: string[],
    environment: Record<string, string | undefined> = {}
) {
    const environmentArguments = Object.entries(environment).flatMap(([key, value]) =>
        value === undefined ? [] : ["--env", key]
    );
    const { code, stderr, stdout } = await runProcess(
        "docker",
        ["exec", ...environmentArguments, container, ...command],
        {
            env: { ...process.env, ...environment },
            maxBuffer: 10 * 1024 * 1024,
            timeoutMs: DOCKER_EXEC_TIMEOUT_MS,
        }
    );
    if (code !== 0) {
        throw new Error(
            `docker exec failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`
        );
    }
    return stdout;
}

/**
 * Returns trimmed environment overrides while treating whitespace-only values as missing.
 * @param value Value to process.
 * @returns trimmed environment overrides while treating whitespace-only values as missing.
 */
function trimmedEnvironmentValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed;
}

/**
 * Returns a fallback only when the value is absent, preserving intentional blanks.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns a fallback only when the value is absent, preserving intentional blanks.
 */
function environmentValueOrDefault(value: string | undefined, fallback: string): string {
    return value === undefined ? fallback : value;
}

/**
 * Returns a safe PostgreSQL hostname for URI construction.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns a safe PostgreSQL hostname for URI construction.
 */
function normalizePostgresHost(value: string | undefined, fallback: string): string {
    const host = trimmedEnvironmentValue(value) ?? fallback;
    const isValidIpv4 =
        /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u.test(host);
    if (!isValidIpv4 && /^(?:\d+\.){3}\d+$/u.test(host)) {
        throw Object.assign(new Error("Invalid PostgreSQL host"), { code: "EINVAL" });
    }
    const validIpv6 =
        host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6;
    const isRawIpv6 = isIP(host) === 6;
    if (
        !validIpv6 &&
        !isValidIpv4 &&
        !isRawIpv6 &&
        !/^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)(?:\.(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?))*$/u.test(
            host
        )
    ) {
        throw Object.assign(new Error("Invalid PostgreSQL host"), { code: "EINVAL" });
    }
    return isRawIpv6 ? `[${host}]` : host;
}

/**
 * Returns a safe PostgreSQL port for URI construction.
 * @param value Value to process.
 * @returns a safe PostgreSQL port for URI construction.
 */
function normalizePostgresPort(value: string | undefined): string {
    const port = trimmedEnvironmentValue(value) ?? "5432";
    if (!/^\d+$/u.test(port)) {
        throw Object.assign(new Error("Invalid PostgreSQL port"), { code: "EINVAL" });
    }
    const portNumber = Number(port);
    if (!Number.isSafeInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
        throw Object.assign(new Error("Invalid PostgreSQL port"), { code: "EINVAL" });
    }
    return String(portNumber);
}

interface PostgresConnection {
    password: string;
    uri: string;
}

/**
 * Builds PostgreSQL connection details from environment defaults for the requested database.
 * @param database Database value.
 * @returns Built PostgreSQL connection details from environment defaults for the requested database.
 */
function buildPostgresConnection(database = "postgres"): PostgresConnection {
    const username = encodeURIComponent(
        environmentValueOrDefault(process.env.DATABASE_USERNAME, "postgres")
    );
    const password = environmentValueOrDefault(process.env.DATABASE_PASSWORD, "postgres");
    const host = normalizePostgresHost(process.env.DATABASE_HOST, "postgres");
    const port = normalizePostgresPort(process.env.DATABASE_PORT);
    const database_ = encodeURIComponent(database);
    return { password, uri: `postgresql://${username}@${host}:${port}/${database_}` };
}

/**
 * Builds PgBouncer admin connection details from environment defaults.
 * @param database Database value.
 * @returns Built PgBouncer admin connection details from environment defaults.
 */
function buildPgBouncerConnection(database = "pgbouncer"): PostgresConnection {
    const username = encodeURIComponent(
        environmentValueOrDefault(process.env.DATABASE_USERNAME, "postgres")
    );
    const password = environmentValueOrDefault(process.env.DATABASE_PASSWORD, "postgres");
    const host = normalizePostgresHost(process.env.PGBOUNCER_HOST, "pgbouncer");
    const port = normalizePostgresPort(process.env.PGBOUNCER_PORT);
    const database_ = encodeURIComponent(database);
    return { password, uri: `postgresql://${username}@${host}:${port}/${database_}` };
}

/**
 * Executes SQL against Postgres through the postgres container and returns tab-delimited stdout.
 * @param sql Sql value.
 * @param database Database value.
 * @returns Promise resolving to the query postgres result.
 */
async function queryPostgres(sql: string, database = "postgres") {
    const connection = buildPostgresConnection(database);
    return runDockerExec(
        "postgres",
        ["psql", connection.uri, "-P", "footer=off", "-F", "\t", "--no-align", "-c", sql],
        {
            PGPASSWORD: connection.password,
        }
    );
}

/**
 * Executes SQL against the PgBouncer admin database and returns tab-delimited stdout.
 * @param sql Sql value.
 * @returns Promise resolving to the query pg bouncer result.
 */
async function queryPgBouncer(sql: string) {
    const connection = buildPgBouncerConnection();
    return runDockerExec(
        "postgres",
        ["psql", connection.uri, "-P", "footer=off", "-F", "\t", "--no-align", "-c", sql],
        {
            PGPASSWORD: connection.password,
        }
    );
}

/**
 * Sums numeric values selected from a row collection.
 * @param rows Rows value.
 * @param selector Selector value.
 * @returns Sum by result.
 */
function sumBy<T>(rows: T[], selector: (row: T) => number): number {
    let total = 0;
    for (const row of rows) {
        total += selector(row);
    }
    return total;
}

/**
 * Runs a SQL query against every connectable non-template database and concatenates parsed rows.
 * @param sql Sql value.
 * @returns Promise resolving to the query all user databases result.
 */
async function queryAllUserDatabases<T extends object>(
    sql: string
): Promise<Array<T & { database: string }>> {
    const databases = parseTable<{ datname: string }>(
        await queryPostgres(`
            SELECT datname
            FROM pg_database
            WHERE datistemplate = false
              AND datallowconn = true
              AND datname <> 'postgres'
            ORDER BY datname;
        `)
    );

    const results: Array<T & { database: string }> = [];
    for (const database of databases) {
        const rows = parseTable<T>(await queryPostgres(sql, database.datname));
        results.push(...rows.map((row) => ({ ...row, database: database.datname })));
    }

    return results;
}

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

type DatabaseOverviewSnapshot = Omit<DatabaseOverviewResponse, "checkedAt" | "mode"> & {
    checkedAt?: string;
    mode?: "full" | "isolated";
};

function isDatabaseOverviewSnapshot(value: unknown): value is DatabaseOverviewSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<DatabaseOverviewSnapshot>;
    return (
        Boolean(candidate.overview) &&
        typeof candidate.overview === "object" &&
        Array.isArray(candidate.databases) &&
        Array.isArray(candidate.deadTuples) &&
        Array.isArray(candidate.bloatEstimates) &&
        Array.isArray(candidate.topQueries) &&
        Array.isArray(candidate.pgbouncerPools) &&
        Array.isArray(candidate.pgbouncerStats)
    );
}

/**
 * Refreshes only the isolated Dashboard SQLite metrics while retaining copied host data.
 * @param snapshot Snapshot value.
 * @returns Isolated database overview value.
 */
export function getIsolatedDatabaseOverview(snapshot: unknown) {
    const sqlite = getDashboardSqliteOverview();
    const previous: DatabaseOverviewSnapshot = isDatabaseOverviewSnapshot(snapshot)
        ? snapshot
        : {
              overview: {
                  totalDatabaseSizeBytes: 0,
                  managedDatabaseCount: 1,
                  totalManagedDatabaseSizeBytes: sqlite.storageBytes,
                  totalBackends: 0,
                  averageCacheHitRatio: 0,
                  connections: {},
                  pgStatStatementsEnabled: false,
                  torrentCounts: { bitmagnet: 0, comet: 0 },
                  pgbouncer: {
                      clientConnections: 0,
                      serverConnections: 0,
                      waitingClients: 0,
                      maxWait: 0,
                      avgQueryTime: 0,
                      avgTransactionTime: 0,
                  },
                  maintenance: {
                      status: "not_assessed",
                      hintCount: 0,
                      requiresBloatReview: false,
                      isBloatAssessmentIncomplete: true,
                      unassessedTableCount: 0,
                      unassessedPhysicalBytes: 0,
                      slowQueryCount: 0,
                      highDeadTupleTableCount: 0,
                      physicalTableBytes: 0,
                      estimatedReclaimableBytes: 0,
                      estimatedReclaimablePercent: 0,
                      reviewThresholdBytes: BLOAT_REVIEW_BYTES,
                      reviewMinimumBytes: BLOAT_REVIEW_MINIMUM_BYTES,
                      reviewThresholdPercent: BLOAT_REVIEW_PERCENT,
                  },
              },
              databases: [],
              deadTuples: [],
              bloatEstimates: [],
              topQueries: [],
              pgbouncerPools: [],
              pgbouncerStats: [],
              sqlite,
          };
    const {
        checkedAt,
        mode: previousMode,
        postgresSnapshotCheckedAt: previousPostgresSnapshotCheckedAt,
        ...previousOverview
    } = previous;
    const postgresSnapshotCheckedAt =
        previousMode === "isolated" ? previousPostgresSnapshotCheckedAt : checkedAt;
    const totalDatabaseSizeBytes =
        Number(previousOverview.overview.totalDatabaseSizeBytes) || 0;

    return {
        ...previousOverview,
        deadTuples: previous.deadTuples.map((row) => projectDeadTupleRow(row)),
        mode: "isolated" as const,
        ...(postgresSnapshotCheckedAt && {
            postgresSnapshotCheckedAt,
        }),
        overview: {
            ...previousOverview.overview,
            managedDatabaseCount: previousOverview.databases.length + 1,
            totalDatabaseSizeBytes,
            totalManagedDatabaseSizeBytes: totalDatabaseSizeBytes + sqlite.storageBytes,
        },
        pgbouncerPools: previous.pgbouncerPools.map((row) =>
            projectPgBouncerPoolRow(row)
        ),
        pgbouncerStats: previous.pgbouncerStats.map((row) =>
            projectPgBouncerStatsRow(row)
        ),
        sqlite,
    };
}
