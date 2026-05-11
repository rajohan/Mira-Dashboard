import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalPath = process.env.PATH;

async function startServer(): Promise<TestServer> {
    const { default: databaseRoutes } = await import("./database.js");
    const app = express();
    databaseRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!/usr/bin/env node
const command = process.argv.at(-1) || "";
function out(value) { process.stdout.write(value); }
if (command.includes('/comet') && command.includes('FROM torrents')) {
  out('count\n42\n');
} else if (command.includes('/bitmagnet') && command.includes('FROM torrents')) {
  out('count\n7\n');
} else if (command.includes('FROM pg_stat_database')) {
  out('datname\tsize_pretty\tsize_bytes\tnumbackends\txact_commit\txact_rollback\tblks_hit\tblks_read\tcache_hit_ratio\napp\t10 MB\t10485760\t2\t100\t1\t900\t100\t90.00\nmedia\t5 MB\t5242880\t1\t50\t0\t80\t20\t80.00\n');
} else if (command.includes('FROM pg_stat_activity')) {
  out('state\tcount\nactive\t2\nidle\t3\n');
} else if (command.includes('FROM pg_database')) {
  out('datname\napp\nmedia\n');
} else if (command.includes('FROM pg_stat_user_tables')) {
  out('schemaname\trelname\tn_live_tup\tn_dead_tup\tdead_pct\tlast_autovacuum\tlast_autoanalyze\npublic\tlarge_table\t100\t25\t25.00\t2026-05-10\t2026-05-10\n');
} else if (command.includes('FROM pg_extension')) {
  out('extname\n');
} else if (command.includes('SHOW POOLS')) {
  out('database\tuser\tcl_active\tcl_waiting\tsv_active\tsv_idle\tsv_used\tmaxwait\tpool_mode\napp\tpostgres\t2\t1\t1\t3\t1\t4\ttransaction\n');
} else if (command.includes('SHOW STATS')) {
  out('database\ttotal_xact_count\ttotal_query_count\ttotal_xact_time\ttotal_query_time\tavg_xact_time\tavg_query_time\ttotal_received\ttotal_sent\napp\t10\t20\t100\t200\t10\t20\t1024\t2048\n');
} else {
  process.stderr.write('Unexpected fake docker command: ' + command);
  process.exit(1);
}
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

describe("database routes", () => {
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-route-"));
        await installFakeDocker(tempDir);
        server = await startServer();
    });

    after(async () => {
        await server.close();
        process.env.PATH = originalPath;
        await rm(tempDir, { recursive: true, force: true });
    });

    it("returns aggregated database overview from Postgres and PgBouncer", async () => {
        const response = await fetch(`${server.baseUrl}/api/database/overview`);
        const body = (await response.json()) as {
            overview: {
                totalDatabaseSizeBytes: number;
                totalBackends: number;
                averageCacheHitRatio: number;
                connections: Record<string, number>;
                pgStatStatementsEnabled: boolean;
                torrentCounts: { comet: number; bitmagnet: number };
                pgbouncer: {
                    clientConnections: number;
                    serverConnections: number;
                    waitingClients: number;
                    maxWait: number;
                    avgQueryTime: number;
                    avgTransactionTime: number;
                };
            };
            databases: Array<{ datname: string; size_pretty: string }>;
            deadTuples: Array<{ relname: string; n_dead_tup: string }>;
            topQueries: unknown[];
            pgbouncerPools: Array<{ database: string; pool_mode: string }>;
            pgbouncerStats: Array<{ database: string; avg_query_time: string }>;
        };

        assert.equal(response.status, 200);
        assert.deepEqual(body.overview.torrentCounts, { comet: 42, bitmagnet: 7 });
        assert.equal(body.overview.totalDatabaseSizeBytes, 15_728_640);
        assert.equal(body.overview.totalBackends, 3);
        assert.equal(body.overview.averageCacheHitRatio, 85);
        assert.deepEqual(body.overview.connections, { active: 2, idle: 3 });
        assert.equal(body.overview.pgStatStatementsEnabled, false);
        assert.deepEqual(body.overview.pgbouncer, {
            clientConnections: 3,
            serverConnections: 5,
            waitingClients: 1,
            maxWait: 4,
            avgQueryTime: 20,
            avgTransactionTime: 10,
        });
        assert.deepEqual(
            body.databases.map((database) => database.datname),
            ["app", "media"]
        );
        assert.equal(body.deadTuples[0]?.relname, "large_table");
        assert.equal(body.topQueries.length, 0);
        assert.deepEqual(body.pgbouncerPools[0], {
            database: "app",
            user: "postgres",
            cl_active: "2",
            cl_waiting: "1",
            sv_active: "1",
            sv_idle: "3",
            sv_used: "1",
            maxwait: "4",
            pool_mode: "transaction",
        });
        assert.equal(body.pgbouncerStats[0]?.avg_query_time, "20");
    });
});
