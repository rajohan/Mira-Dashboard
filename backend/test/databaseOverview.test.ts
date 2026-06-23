import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

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
        comet: table(["count"], [["7"]]),
        databases: table(["datname"], [["mira"], ["logs"]]),
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
                ["public", "logs", "20", "8", "40", "", "2026-06-22"],
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
            [["SELECT 1", "4", "12.5", "3.13", "4", "10", "1"]]
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
  key = "databases";
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
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-fake-docker-"));
        try {
            writeFakeDocker(path.join(temporaryRoot, "docker"));
            const { getDatabaseOverview } =
                await import("../src/services/databaseOverview.ts");
            process.env.PATH = `${temporaryRoot}:${originalPath ?? ""}`;
            const overview = await getDatabaseOverview();

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
                relname: "logs",
                n_dead_tup: "8",
            });
            expect(overview.topQueries[0]).toMatchObject({
                query: "SELECT 1",
                calls: "4",
            });
        } finally {
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });
});
