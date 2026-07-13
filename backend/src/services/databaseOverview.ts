import { isIP } from "node:net";

import { runProcess } from "../lib/processes.ts";
import { stringFallback } from "../lib/values.ts";

const DOCKER_EXEC_TIMEOUT_MS = 30_000;
const BLOAT_REVIEW_BYTES = 5 * 1024 * 1024 * 1024;
const BLOAT_REVIEW_MINIMUM_BYTES = 1024 * 1024 * 1024;
const BLOAT_REVIEW_PERCENT = 25;
const BLOAT_DETAIL_MINIMUM_BYTES = 64 * 1024 * 1024;
const SLOW_QUERY_MEAN_MS = 500;
const HIGH_DEAD_TUPLE_PERCENT = 20;
const HIGH_DEAD_TUPLE_MINIMUM = 1000;

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

/** Parses tab-delimited psql --no-align output into typed row objects; blank/header-only output returns an empty array. */
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

/** Returns a string value or a fallback using the route's existing falsy-value behavior. */
function stringWithDefault(value: string | undefined, fallback: string): string {
    return value || fallback;
}

/** Converts psql numeric text to a number, preserving the existing falsy-to-zero behavior. */
function numberFrom(value: string | undefined): number {
    return Number(value || 0);
}

/** Runs a command inside a Docker container and returns raw stdout. */
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

/** Returns trimmed environment overrides while treating whitespace-only values as missing. */
function trimmedEnvironmentValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed;
}

/** Returns a fallback only when the value is absent, preserving intentional blanks. */
function environmentValueOrDefault(value: string | undefined, fallback: string): string {
    return value === undefined ? fallback : value;
}

/** Returns a safe PostgreSQL hostname for URI construction. */
function normalizePostgresHost(value: string | undefined, fallback: string): string {
    const host = trimmedEnvironmentValue(value) ?? fallback;
    const isValidIpv4 =
        /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u.test(host);
    if (/^(?:\d+\.){3}\d+$/u.test(host) && !isValidIpv4) {
        throw Object.assign(new Error("Invalid PostgreSQL host"), { code: "EINVAL" });
    }
    const validIpv6 =
        host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6;
    const isRawIpv6 = isIP(host) === 6;
    if (
        !/^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)(?:\.(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?))*$/u.test(
            host
        ) &&
        !validIpv6 &&
        !isValidIpv4 &&
        !isRawIpv6
    ) {
        throw Object.assign(new Error("Invalid PostgreSQL host"), { code: "EINVAL" });
    }
    return isRawIpv6 ? `[${host}]` : host;
}

/** Returns a safe PostgreSQL port for URI construction. */
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

/** Builds PostgreSQL connection details from environment defaults for the requested database. */
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

/** Builds PgBouncer admin connection details from environment defaults. */
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

/** Executes SQL against Postgres through the postgres container and returns tab-delimited stdout. */
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

/** Executes SQL against the PgBouncer admin database and returns tab-delimited stdout. */
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

/** Sums numeric values selected from a row collection. */
function sumBy<T>(rows: T[], selector: (row: T) => number): number {
    let total = 0;
    for (const row of rows) {
        total += selector(row);
    }
    return total;
}

/** Runs a SQL query against every connectable non-template database and concatenates parsed rows. */
async function queryAllUserDatabases<T extends object>(
    sql: string
): Promise<Array<T & { database: string }>> {
    const databases = parseTable<{ datname: string }>(
        await queryPostgres(`
            SELECT datname
            FROM pg_database
            WHERE datistemplate = false
              AND datallowconn = true
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

const TORRENT_COUNT_TTL = 60 * 60 * 1000; // 1 hour
const databaseRouteState: {
    torrentCountCache:
        | undefined
        | {
              data: { comet: number; bitmagnet: number };
              timestamp: number;
          };
} = { torrentCountCache: undefined };

/** Returns cached torrent counts for Comet and Bitmagnet, refreshing at most once per hour. */
async function getTorrentCounts() {
    if (
        databaseRouteState.torrentCountCache &&
        Date.now() - databaseRouteState.torrentCountCache.timestamp < TORRENT_COUNT_TTL
    ) {
        return databaseRouteState.torrentCountCache.data;
    }

    let cometCount = "0";
    let bitmagnetCount = "0";
    try {
        cometCount = stringFallback(
            parseTable<{ count: string }>(
                await queryPostgres(
                    "SELECT count(*)::text AS count FROM torrents;",
                    "comet"
                )
            )[0]?.count,
            "0"
        );
    } catch (error) {
        console.warn("[DatabaseOverview] Failed to read Comet torrent count:", error);
    }
    try {
        bitmagnetCount = stringFallback(
            parseTable<{ count: string }>(
                await queryPostgres(
                    "SELECT count(*)::text AS count FROM torrents;",
                    "bitmagnet"
                )
            )[0]?.count,
            "0"
        );
    } catch (error) {
        console.warn("[DatabaseOverview] Failed to read Bitmagnet torrent count:", error);
    }

    const data = { comet: numberFrom(cometCount), bitmagnet: numberFrom(bitmagnetCount) };
    databaseRouteState.torrentCountCache = { data, timestamp: Date.now() };
    return data;
}

/** Collects PostgreSQL and PgBouncer metrics used by the database overview endpoint. */
export async function getDatabaseOverview() {
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
    ) as PostgresDatabaseRow[];

    const connectionRows = parseTable<ConnectionCountsRow>(
        await queryPostgres(`
            SELECT COALESCE(state, 'unknown') AS state, COUNT(*)::text AS count
            FROM pg_stat_activity
            WHERE datname NOT IN ('template0', 'template1', 'postgres')
            GROUP BY COALESCE(state, 'unknown')
            ORDER BY COUNT(*) DESC;
        `)
    ) as ConnectionCountsRow[];

    const allDeadTupleRows = await queryAllUserDatabases<DeadTupleRow>(`
        SELECT
            schemaname,
            relname,
            n_live_tup::text,
            n_dead_tup::text,
            ROUND(
                CASE WHEN n_live_tup = 0 THEN 0
                ELSE (n_dead_tup::numeric / NULLIF(n_live_tup, 0)) * 100
                END,
                2
            )::text AS dead_pct,
            COALESCE(last_autovacuum::text, '') AS last_autovacuum,
            COALESCE(last_autoanalyze::text, '') AS last_autoanalyze
        FROM pg_stat_user_tables
        WHERE n_live_tup > 0 OR n_dead_tup > 0
        ORDER BY n_dead_tup DESC
        LIMIT 25;
    `);
    const deadTupleRows = allDeadTupleRows
        .toSorted((a, b) => numberFrom(b.n_dead_tup) - numberFrom(a.n_dead_tup))
        .slice(0, 25);

    // Catalog statistics keep this hourly check bounded; tuple overhead and 20% headroom
    // deliberately bias the estimate below what VACUUM FULL might actually recover.
    const bloatEstimates = await queryAllUserDatabases<BloatEstimateRow>(`
        WITH average_row_widths AS (
            SELECT schemaname, tablename, SUM(avg_width)::numeric AS row_width
            FROM pg_stats
            GROUP BY schemaname, tablename
        )
        SELECT
            tables.schemaname,
            tables.relname,
            pg_relation_size(tables.relid)::text AS physical_bytes,
            GREATEST(
                pg_relation_size(tables.relid) - CEIL(
                    tables.n_live_tup * (COALESCE(widths.row_width, 0) + 32) * 1.2
                ),
                0
            )::bigint::text AS estimated_reclaimable_bytes
        FROM pg_stat_user_tables AS tables
        INNER JOIN average_row_widths AS widths
          ON widths.schemaname = tables.schemaname
         AND widths.tablename = tables.relname
        WHERE pg_relation_size(tables.relid) > 0
          AND tables.n_live_tup > 0;
    `);
    const physicalTableBytes = sumBy(bloatEstimates, (row) =>
        numberFrom(row.physical_bytes)
    );
    const estimatedReclaimableBytes = sumBy(bloatEstimates, (row) =>
        numberFrom(row.estimated_reclaimable_bytes)
    );
    const estimatedReclaimablePercent =
        physicalTableBytes > 0
            ? (estimatedReclaimableBytes / physicalTableBytes) * 100
            : 0;
    const bloatNeedsReview =
        estimatedReclaimableBytes >= BLOAT_REVIEW_BYTES ||
        (estimatedReclaimableBytes >= BLOAT_REVIEW_MINIMUM_BYTES &&
            estimatedReclaimablePercent >= BLOAT_REVIEW_PERCENT);

    const pgStatStatementsResult = await queryPostgres(`
        SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements';
    `);
    const pgStatStatementsEnabled = pgStatStatementsResult.includes("pg_stat_statements");
    const topQueries = pgStatStatementsEnabled
        ? (parseTable<TopQueryRow>(
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
          ) as TopQueryRow[])
        : [];
    const slowQueryCount = topQueries.filter(
        (query) => numberFrom(query.mean_exec_time) >= SLOW_QUERY_MEAN_MS
    ).length;
    const highDeadTupleTableCount = deadTupleRows.filter(
        (table) =>
            numberFrom(table.dead_pct) >= HIGH_DEAD_TUPLE_PERCENT &&
            numberFrom(table.n_dead_tup) >= HIGH_DEAD_TUPLE_MINIMUM
    ).length;
    const maintenanceHintCount =
        slowQueryCount + highDeadTupleTableCount + (bloatNeedsReview ? 1 : 0);

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

    return {
        overview: {
            totalDatabaseSizeBytes,
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
                status: maintenanceHintCount > 0 ? "review" : "healthy",
                hintCount: maintenanceHintCount,
                bloatNeedsReview,
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
        deadTuples: deadTupleRows,
        bloatEstimates: bloatEstimates
            .filter(
                (row) =>
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
        pgbouncerPools: pgBouncerPools,
        pgbouncerStats: pgBouncerStats,
    };
}
