import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, jest } from "bun:test";

const DATABASE_OVERVIEW_ENV_KEYS = [
    "DATABASE_HOST",
    "DATABASE_PORT",
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
                "n_live_tup",
                "n_dead_tup",
                "dead_pct",
                "last_autovacuum",
                "last_autoanalyze",
            ],
            [
                ["public", "tasks", "100", "5", "5", "2026-06-23", ""],
                ["public", "logs", "2000", "1001", "50.05", "", "2026-06-22"],
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
    const script = `#!/usr/bin/env bun
const arguments_ = process.argv.slice(2);
const sql = arguments_.at(-1) ?? "";
const command = arguments_.join(" ");
const outputs = ${JSON.stringify(outputs)};
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
            const { getDatabaseOverview } =
                await import("../src/services/databaseOverview.ts");
            process.env.PATH = `${temporaryRoot}${path.delimiter}${originalPath ?? ""}`;
            process.env.DATABASE_HOST = "postgres";
            process.env.DATABASE_PORT = "5432";
            process.env.PGBOUNCER_HOST = "pgbouncer";
            process.env.PGBOUNCER_PORT = "6432";
            const overview = await getDatabaseOverview();
            const { databaseRoutes } = await import("../src/routes/databaseRoutes.ts");
            const routeResponse = await databaseRoutes["/api/database/overview"].GET();
            const routeOverview = (await routeResponse.json()) as typeof overview;

            expect(overview.overview).toMatchObject({
                totalDatabaseSizeBytes: 15_728_640,
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
            expect(overview.databases).toHaveLength(2);
            expect(overview.deadTuples[0]).toMatchObject({
                database: "mira",
                relname: "logs",
                n_dead_tup: "1001",
            });
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
