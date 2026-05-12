import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";

const execFileAsync = promisify(execFile);

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

interface ConnectionCountsRow {
    state: string | null;
    count: string;
}

interface DeadTupleRow {
    schemaname: string;
    relname: string;
    n_live_tup: string;
    n_dead_tup: string;
    dead_pct: string;
    last_autovacuum: string | null;
    last_autoanalyze: string | null;
}

interface TopQueryRow {
    query: string;
    calls: string;
    total_exec_time: string;
    mean_exec_time: string;
    rows: string;
    shared_blks_hit: string;
    shared_blks_read: string;
}

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

function parseTable<T extends object>(output: string): T[] {
    const trimmed = output.trim();
    if (!trimmed) {
        return [];
    }

    const lines = trimmed.split("\n").filter(Boolean);
    if (lines.length < 2) {
        return [];
    }

    const headers = lines[0].split("\t");
    return lines.slice(1).map((line) => {
        const cells = line.split("\t");
        return Object.fromEntries(
            headers.map((header, index) => [header, cells[index] ?? ""])
        ) as T;
    });
}

async function runDockerExec(container: string, command: string) {
    const options: ExecFileOptionsWithStringEncoding = {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
    };
    const { stdout } = await execFileAsync(
        "docker",
        ["exec", container, "bash", "-lc", command],
        options
    );
    return stdout;
}

function buildPostgresUri(database = "postgres") {
    const username = process.env.DATABASE_USERNAME || "postgres";
    const password = process.env.DATABASE_PASSWORD || "postgres";
    const host = process.env.DATABASE_HOST || "postgres";
    const port = process.env.DATABASE_PORT || "5432";
    return `postgresql://${username}:${password}@${host}:${port}/${database}`;
}

function buildPgBouncerUri(database = "pgbouncer") {
    const username = process.env.DATABASE_USERNAME || "postgres";
    const password = process.env.DATABASE_PASSWORD || "postgres";
    const host = process.env.PGBOUNCER_HOST || "pgbouncer";
    const port = process.env.PGBOUNCER_PORT || "5432";
    return `postgresql://${username}:${password}@${host}:${port}/${database}`;
}

async function queryPostgres(sql: string, database = "postgres") {
    const uri = buildPostgresUri(database);
    const escapedSql = sql.replaceAll('"', String.raw`\"`);
    return runDockerExec(
        "postgres",
        String.raw`psql "${uri}" -P footer=off -F $'\t' --no-align -c "${escapedSql}"`
    );
}

async function queryPgBouncer(sql: string) {
    const uri = buildPgBouncerUri();
    const escapedSql = sql.replaceAll('"', String.raw`\"`);
    return runDockerExec(
        "postgres",
        String.raw`psql "${uri}" -P footer=off -F $'\t' --no-align -c "${escapedSql}"`
    );
}

function sumBy<T>(rows: T[], selector: (row: T) => number): number {
    let total = 0;
    for (const row of rows) {
        total += selector(row);
    }
    return total;
}

async function queryAllUserDatabases<T extends object>(sql: string): Promise<T[]> {
    const databases = parseTable<{ datname: string }>(
        await queryPostgres(`
            SELECT datname
            FROM pg_database
            WHERE datistemplate = false
              AND datallowconn = true
            ORDER BY datname;
        `)
    );

    const results: T[] = [];
    for (const database of databases) {
        const rows = parseTable<T>(await queryPostgres(sql, database.datname));
        results.push(...rows);
    }

    return results;
}

const TORRENT_COUNT_TTL = 60 * 60 * 1000; // 1 hour
let torrentCountCache: {
    data: { comet: number; bitmagnet: number };
    timestamp: number;
} | null = null;

async function getTorrentCounts() {
    if (
        torrentCountCache &&
        Date.now() - torrentCountCache.timestamp < TORRENT_COUNT_TTL
    ) {
        return torrentCountCache.data;
    }

    const cometCount =
        parseTable<{ count: string }>(
            await queryPostgres("SELECT count(*)::text AS count FROM torrents;", "comet")
        )[0]?.count ?? "0";

    const bitmagnetCount =
        parseTable<{ count: string }>(
            await queryPostgres(
                "SELECT count(*)::text AS count FROM torrents;",
                "bitmagnet"
            )
        )[0]?.count ?? "0";

    const data = { comet: Number(cometCount), bitmagnet: Number(bitmagnetCount) };
    torrentCountCache = { data, timestamp: Date.now() };
    return data;
}

async function getDatabaseOverview() {
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
        .sort((a, b) => Number(b.n_dead_tup || 0) - Number(a.n_dead_tup || 0))
        .slice(0, 25);

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

    const pgBouncerPools = parseTable<PgBouncerPoolRow>(
        await queryPgBouncer("SHOW POOLS;")
    );
    const pgBouncerStats = parseTable<PgBouncerStatsRow>(
        await queryPgBouncer("SHOW STATS;")
    );

    const connections = Object.fromEntries(
        connectionRows.map((row) => [row.state || "unknown", Number(row.count || 0)])
    );
    const totalDatabaseSizeBytes = sumBy(databaseRows, (row) =>
        Number(row.size_bytes || 0)
    );
    const totalBackends = sumBy(databaseRows, (row) => Number(row.numbackends || 0));
    const averageCacheHitRatio =
        databaseRows.length > 0
            ? sumBy(databaseRows, (row) => Number(row.cache_hit_ratio || 0)) /
              databaseRows.length
            : 0;

    const waitingClients = sumBy(pgBouncerPools, (row) => Number(row.cl_waiting || 0));
    const clientConnections = sumBy(
        pgBouncerPools,
        (row) => Number(row.cl_active || 0) + Number(row.cl_waiting || 0)
    );
    const serverConnections = sumBy(
        pgBouncerPools,
        (row) =>
            Number(row.sv_active || 0) +
            Number(row.sv_idle || 0) +
            Number(row.sv_used || 0)
    );
    let maxWait = 0;
    for (const row of pgBouncerPools) {
        maxWait = Math.max(maxWait, Number(row.maxwait || 0));
    }
    const avgQueryTime =
        pgBouncerStats.length > 0
            ? sumBy(pgBouncerStats, (row) => Number(row.avg_query_time || 0)) /
              pgBouncerStats.length
            : 0;
    const avgTransactionTime =
        pgBouncerStats.length > 0
            ? sumBy(pgBouncerStats, (row) => Number(row.avg_xact_time || 0)) /
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
        },
        databases: databaseRows,
        deadTuples: deadTupleRows,
        topQueries,
        pgbouncerPools: pgBouncerPools,
        pgbouncerStats: pgBouncerStats,
    };
}

export default function databaseRoutes(app: express.Application): void {
    app.get("/api/database/overview", (async (_req, res) => {
        try {
            const data = await getDatabaseOverview();
            res.json(data);
        } catch (error) {
            res.status(500).json({
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }) as RequestHandler);
}
