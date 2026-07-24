import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, jest } from "bun:test";

const DATABASE_OVERVIEW_ENV_KEYS = [
    "DATABASE_HOST",
    "DATABASE_PORT",
    "FAKE_DOCKER_FAIL_COMET",
    "FAKE_DOCKER_INVOCATION_LOG",
    "PGBOUNCER_HOST",
    "PGBOUNCER_PORT",
] as const;

function table(headers: string[], rows: string[][]): string {
    return [headers.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n");
}

function writeFakeDocker(binaryPath: string): void {
    const outputs: Record<string, string> = {
        activity: table(
            ["state", "count"],
            [
                ["active", "2"],
                ["idle", "1"],
            ]
        ),
        bitmagnet: table(["count"], [["11"]]),
        bloatEstimates: table(
            [
                "schemaname",
                "relname",
                "physical_bytes",
                "estimated_reclaimable_bytes",
                "assessed",
            ],
            [
                ["public", "events", "4294967296", "3221225472", "true"],
                ["public", "emptied", "2147483648", "", "false"],
            ]
        ),
        comet: table(["count"], [["7"]]),
        databases: table(["datname"], [["mira"], ["logs"]]),
        databasesUnfiltered: table(["datname"], [["mira"], ["logs"], ["postgres"]]),
        deadTuples: table(
            [
                "schemaname",
                "relname",
                "physical_bytes",
                "n_live_tup",
                "n_dead_tup",
                "dead_pct",
                "last_autovacuum",
                "last_autoanalyze",
            ],
            [
                ["public", "tasks", "1048576", "100", "5", "5", "2026-06-23", ""],
                [
                    "public",
                    "alerts",
                    "3045068",
                    "4482",
                    "1008",
                    "22.49",
                    "",
                    "2026-07-14",
                ],
                ...Array.from({ length: 25 }, (_, index) => [
                    "public",
                    `small_churn_${index}`,
                    "1048576",
                    "5000",
                    String(2000 + index),
                    "40",
                    "",
                    "2026-07-14",
                ]),
                ["public", "logs", "67108864", "2000", "1001", "50.05", "", "2026-06-22"],
            ]
        ),
        extensions: table(["extname"], [["pg_stat_statements"]]),
        pgbouncerPools: table(
            [
                "database",
                "user",
                "cl_active",
                "cl_waiting",
                "sv_active",
                "sv_idle",
                "sv_used",
                "maxwait",
                "pool_mode",
            ],
            [["mira", "postgres", "2", "1", "1", "2", "3", "9", "transaction"]]
        ),
        pgbouncerStats: table(
            [
                "database",
                "total_xact_count",
                "total_query_count",
                "total_xact_time",
                "total_query_time",
                "avg_xact_time",
                "avg_query_time",
                "total_received",
                "total_sent",
            ],
            [["mira", "10", "20", "100", "200", "10", "20", "1024", "2048"]]
        ),
        stats: table(
            [
                "datname",
                "size_pretty",
                "size_bytes",
                "numbackends",
                "xact_commit",
                "xact_rollback",
                "blks_hit",
                "blks_read",
                "cache_hit_ratio",
            ],
            [
                ["mira", "10 MB", "10485760", "2", "100", "3", "90", "10", "90"],
                ["logs", "5 MB", "5242880", "1", "50", "1", "75", "25", "75"],
            ]
        ),
        topQueries: table(
            [
                "query",
                "calls",
                "total_exec_time",
                "mean_exec_time",
                "rows",
                "shared_blks_hit",
                "shared_blks_read",
            ],
            [["SELECT 1", "4", "2500", "625", "4", "10", "1"]]
        ),
    };
    const script = String.raw`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const arguments_ = process.argv.slice(2);
const sql = arguments_.at(-1) ?? "";
const command = arguments_.join(" ");
const outputs = ${JSON.stringify(outputs)};
if (process.env.FAKE_DOCKER_INVOCATION_LOG) {
  appendFileSync(process.env.FAKE_DOCKER_INVOCATION_LOG, command + "\n");
}
if (process.env.FAKE_DOCKER_FAIL_COMET && sql.includes("FROM torrents") && command.includes("/comet")) {
  process.stderr.write("Comet unavailable");
  process.exit(1);
}
let key = "";
if (sql.includes("FROM torrents")) {
  key = command.includes("/comet") ? "comet" : "bitmagnet";
} else if (sql.includes("FROM pg_stat_database")) {
  key = "stats";
} else if (sql.includes("FROM pg_stat_activity")) {
  key = "activity";
} else if (sql.includes("FROM pg_database")) {
  key = sql.includes("datname <> 'postgres'") ? "databases" : "databasesUnfiltered";
} else if (sql.includes("estimated_reclaimable_bytes")) {
  key = "bloatEstimates";
} else if (sql.includes("FROM pg_stat_user_tables")) {
  key = "deadTuples";
} else if (sql.includes("FROM pg_extension")) {
  key = "extensions";
} else if (sql.includes("FROM pg_stat_statements")) {
  key = "topQueries";
} else if (sql === "SHOW POOLS;") {
  key = "pgbouncerPools";
} else if (sql === "SHOW STATS;") {
  key = "pgbouncerStats";
}
process.stdout.write(outputs[key] ?? "");
`;
    writeFileSync(binaryPath, script);
    chmodSync(binaryPath, 0o755);
}

describe("database overview service", () => {
    it("summarizes Postgres, PgBouncer, and torrent metrics from command output", async () => {
        const originalPath = process.env.PATH;
        const originalEnvironment = Object.fromEntries(
            DATABASE_OVERVIEW_ENV_KEYS.map((key) => [key, process.env[key]])
        );
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-fake-docker-"));
        try {
            writeFakeDocker(path.join(temporaryRoot, "docker"));
            const invocationLog = path.join(temporaryRoot, "invocations.log");
            const { getDatabaseOverview } =
                await import("../src/services/databaseOverview.ts");
            process.env.PATH = `${temporaryRoot}${path.delimiter}${originalPath ?? ""}`;
            process.env.DATABASE_HOST = "postgres";
            process.env.DATABASE_PORT = "5432";
            process.env.FAKE_DOCKER_INVOCATION_LOG = invocationLog;
            process.env.PGBOUNCER_HOST = "pgbouncer";
            process.env.PGBOUNCER_PORT = "6432";
            const { database } = await import("../src/database.ts");
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'database.maintenance'")
                .run();
            const overview = await getDatabaseOverview();
            const { databaseRoutes } = await import("../src/routes/databaseRoutes.ts");
            const routeResponse = await databaseRoutes["/api/database/overview"].GET();
            const routeOverview = (await routeResponse.json()) as typeof overview;

            expect(overview.overview).toMatchObject({
                totalDatabaseSizeBytes: 15_728_640,
                managedDatabaseCount: 3,
                totalBackends: 3,
                averageCacheHitRatio: 82.5,
                connections: { active: 2, idle: 1 },
                pgStatStatementsEnabled: true,
                torrentCounts: { comet: 7, bitmagnet: 11 },
                pgbouncer: {
                    clientConnections: 3,
                    serverConnections: 6,
                    waitingClients: 1,
                    maxWait: 9,
                    avgQueryTime: 20,
                    avgTransactionTime: 10,
                },
            });
            expect(overview.sqlite).toMatchObject({
                attention: [
                    "No verified SQLite backup exists",
                    "SQLite maintenance job is not registered",
                ],
                backup: { count: 0, current: false, reviewAgeHours: 48 },
                foreignKeysEnabled: true,
                journalMode: "wal",
                migrations: { applied: 5, current: true, latest: 5 },
                permissions: { secure: true },
                status: "review",
                walAutoCheckpointPages: 1000,
            });
            expect(overview.overview.totalManagedDatabaseSizeBytes).toBeGreaterThan(
                overview.overview.totalDatabaseSizeBytes
            );
            expect(overview.databases).toHaveLength(2);
            expect(overview.deadTuples).toHaveLength(25);
            expect(
                overview.deadTuples.find((table) => table.relname === "small_churn_24")
            ).toMatchObject({
                database: "mira",
                physical_bytes: "1048576",
                n_dead_tup: "2024",
            });
            expect(
                overview.deadTuples.find((table) => table.relname === "logs")
            ).toBeUndefined();
            expect(overview.overview.maintenance).toMatchObject({
                status: "review",
                hintCount: 4,
                requiresBloatReview: true,
                isBloatAssessmentIncomplete: true,
                unassessedTableCount: 2,
                unassessedPhysicalBytes: 4_294_967_296,
                slowQueryCount: 1,
                highDeadTupleTableCount: 2,
                physicalTableBytes: 8_589_934_592,
                estimatedReclaimableBytes: 6_442_450_944,
                estimatedReclaimablePercent: 75,
            });
            expect(overview.bloatEstimates[0]).toMatchObject({
                database: "mira",
                relname: "events",
            });
            expect(overview.topQueries[0]).toMatchObject({
                query: "SELECT 1",
                calls: "4",
            });
            expect(routeOverview.overview).toMatchObject({
                totalDatabaseSizeBytes: 15_728_640,
                totalBackends: 3,
            });
            expect(routeOverview.overview.pgbouncer).toMatchObject({
                clientConnections: 3,
                serverConnections: 6,
            });
            const invocationLogContents = await Bun.file(invocationLog).text();
            expect(invocationLogContents).toContain("classes.reltuples::numeric");
            expect(invocationLogContents).not.toMatch(/classes\.reltuples::numeric\s*-/u);
            expect(invocationLogContents).toContain("catalog_estimate_may_be_stale");
            expect(invocationLogContents).toContain("5368709120");
            expect(invocationLogContents).toContain("ABS(");
            expect(invocationLogContents).not.toMatch(
                /classes\.reltuples::numeric\s*\+\s*tables\.n_dead_tup::numeric/u
            );
            const torrentCountQueries = invocationLogContents
                .split("\n")
                .filter((line) =>
                    line.includes("SELECT count(*)::text AS count FROM torrents")
                );
            expect(torrentCountQueries).toHaveLength(4);

            process.env.FAKE_DOCKER_FAIL_COMET = "1";
            await expect(getDatabaseOverview()).rejects.toThrow(
                "docker exec failed with exit code 1"
            );
        } finally {
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
            for (const key of DATABASE_OVERVIEW_ENV_KEYS) {
                const value = originalEnvironment[key];
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });

    it("requests review for missing, disabled, stale, failed, and compaction states", async () => {
        const { database } = await import("../src/database.ts");
        const { getDashboardSqliteOverview } =
            await import("../src/services/sqliteOverview.ts");
        const now = new Date("2026-07-23T12:00:00.000Z");
        try {
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'database.maintenance'")
                .run();
            expect(getDashboardSqliteOverview(now).attention).toContain(
                "SQLite maintenance job is not registered"
            );

            database
                .prepare(
                    `INSERT INTO scheduled_jobs (
                         id, name, enabled, schedule_type, interval_seconds,
                         action_key, action_payload_json, created_at, updated_at
                     ) VALUES (
                         'database.maintenance', 'SQLite maintenance', 0, 'daily',
                         86400, 'database.maintenance', '{}', ?, ?
                     )`
                )
                .run(now.toISOString(), now.toISOString());
            const disabled = getDashboardSqliteOverview(now);
            expect(disabled.attention).toContain("SQLite maintenance job is disabled");
            expect(disabled.attention).toContain(
                "SQLite maintenance has never completed successfully"
            );

            database
                .prepare(
                    "UPDATE scheduled_jobs SET enabled = 1 WHERE id = 'database.maintenance'"
                )
                .run();
            database
                .prepare(
                    `INSERT INTO scheduled_job_runs (
                         job_id, status, trigger_type, started_at, finished_at
                     ) VALUES ('database.maintenance', 'success', 'schedule', ?, ?)`
                )
                .run("2026-07-20T11:00:00.000Z", "2026-07-20T11:01:00.000Z");
            expect(getDashboardSqliteOverview(now).attention).toContain(
                "Latest successful SQLite maintenance is older than 48 hours"
            );

            database
                .prepare(
                    `INSERT INTO scheduled_job_runs (
                         job_id, status, trigger_type, started_at, finished_at
                     ) VALUES
                       ('database.maintenance', 'success', 'schedule', ?, ?),
                       ('database.maintenance', 'failed', 'schedule', ?, ?)`
                )
                .run(
                    "2026-07-23T11:00:00.000Z",
                    "2026-07-23T11:01:00.000Z",
                    "2026-07-23T11:30:00.000Z",
                    "2026-07-23T11:31:00.000Z"
                );
            const failed = getDashboardSqliteOverview(now);
            expect(failed.attention).not.toContain(
                "Latest successful SQLite maintenance is older than 48 hours"
            );
            expect(failed.attention).toContain("Latest SQLite maintenance failed");

            database.run(
                "CREATE TABLE overview_reclaimable_fixture (payload BLOB NOT NULL)"
            );
            database.run(
                "INSERT INTO overview_reclaimable_fixture VALUES (zeroblob(20971520))"
            );
            database.run("DROP TABLE overview_reclaimable_fixture");
            expect(
                getDashboardSqliteOverview(now).attention.find((reason) =>
                    reason.startsWith("SQLite can reclaim ")
                )
            ).toMatch(
                /^SQLite can reclaim \d+\.\d MiB \(\d+\.\d%\)\. Consider a planned VACUUM$/u
            );
        } finally {
            database.run("DROP TABLE IF EXISTS overview_reclaimable_fixture");
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'database.maintenance'")
                .run();
            database.run("VACUUM");
        }
    });

    it("maps database overview service failures to a generic route error", async () => {
        const serviceModule = await import("../src/services/databaseOverview.ts");
        const databaseError = new Error("connection failed") as Error & {
            code?: string;
        };
        databaseError.code = "ECONNREFUSED";
        const overviewSpy = jest
            .spyOn(serviceModule, "getDatabaseOverview")
            .mockRejectedValue(databaseError);
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { databaseRoutes } = await import("../src/routes/databaseRoutes.ts");
            const response = await databaseRoutes["/api/database/overview"].GET();

            expect(response.status).toBe(500);
            expect(await response.json()).toEqual({
                error: "Failed to load database overview",
            });
            expect(consoleSpy).toHaveBeenCalledWith(
                "[databaseRoutes] Failed to load database overview",
                {
                    code: "ECONNREFUSED",
                    name: "Error",
                }
            );
        } finally {
            overviewSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });
});
