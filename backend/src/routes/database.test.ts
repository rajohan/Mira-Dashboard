import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalPath = process.env.PATH;
const originalFakeDbMode = process.env.FAKE_DB_MODE;

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
        String.raw`#!${process.execPath}
	const command = process.argv.slice(2).join(" ");
	const mode = process.env.FAKE_DB_MODE || "default";
	function out(value) { process.stdout.write(value); }
	if (mode === 'error') {
	  process.stderr.write('database unavailable');
	  process.exit(12);
	} else if (command.includes('/comet') && command.includes('FROM torrents')) {
	  out('count\n42\n');
	} else if (command.includes('/bitmagnet') && command.includes('FROM torrents')) {
	  out('count\n7\n');
	} else if (command.includes('FROM pg_stat_database')) {
	  out(mode === 'empty' ? 'datname\tsize_pretty\tsize_bytes\tnumbackends\txact_commit\txact_rollback\tblks_hit\tblks_read\tcache_hit_ratio\n' : 'datname\tsize_pretty\tsize_bytes\tnumbackends\txact_commit\txact_rollback\tblks_hit\tblks_read\tcache_hit_ratio\napp\t10 MB\t10485760\t2\t100\t1\t900\t100\t90.00\nmedia\t5 MB\t5242880\t1\t50\t0\t80\t20\t80.00\n');
	} else if (command.includes('FROM pg_stat_activity')) {
	  out(mode === 'empty' ? 'state\tcount\n' : 'state\tcount\nactive\t2\nidle\t3\n');
	} else if (command.includes('FROM pg_database')) {
	  out(mode === 'empty' ? 'datname\n' : 'datname\napp\nmedia\n');
	} else if (command.includes('FROM pg_stat_user_tables')) {
	  out('schemaname\trelname\tn_live_tup\tn_dead_tup\tdead_pct\tlast_autovacuum\tlast_autoanalyze\npublic\tlarge_table\t100\t25\t25.00\t2026-05-10\t2026-05-10\n');
	} else if (command.includes('FROM pg_extension')) {
	  out(mode === 'pgstat' ? 'extname\npg_stat_statements\n' : 'extname\n');
	} else if (command.includes('FROM pg_stat_statements')) {
	  out('query\tcalls\ttotal_exec_time\tmean_exec_time\trows\tshared_blks_hit\tshared_blks_read\nSELECT * FROM table\t3\t12.50\t4.17\t9\t20\t2\n');
	} else if (command.includes('SHOW POOLS')) {
	  out(mode === 'empty' ? 'database\tuser\tcl_active\tcl_waiting\tsv_active\tsv_idle\tsv_used\tmaxwait\tpool_mode\n' : 'database\tuser\tcl_active\tcl_waiting\tsv_active\tsv_idle\tsv_used\tmaxwait\tpool_mode\napp\tpostgres\t2\t1\t1\t3\t1\t4\ttransaction\n');
	} else if (command.includes('SHOW STATS')) {
	  out(mode === 'empty' ? 'database\ttotal_xact_count\ttotal_query_count\ttotal_xact_time\ttotal_query_time\tavg_xact_time\tavg_query_time\ttotal_received\ttotal_sent\n' : 'database\ttotal_xact_count\ttotal_query_count\ttotal_xact_time\ttotal_query_time\tavg_xact_time\tavg_query_time\ttotal_received\ttotal_sent\napp\t10\t20\t100\t200\t10\t20\t1024\t2048\n');
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

    afterEach(() => {
        if (originalFakeDbMode === undefined) {
            delete process.env.FAKE_DB_MODE;
            return;
        }
        process.env.FAKE_DB_MODE = originalFakeDbMode;
    });

    it("covers table parser blank and malformed output", async () => {
        const { __testing } = await import("./database.js");

        assert.deepEqual(__testing.parseTable(""), []);
        assert.deepEqual(__testing.parseTable("header-only"), []);
        assert.deepEqual(__testing.parseTable("a\tb\n1"), [{ a: "1", b: "" }]);
        assert.equal(__testing.stringWithDefault("", "fallback"), "fallback");
        assert.equal(__testing.stringWithDefault("value", "fallback"), "value");
        assert.equal(__testing.numberFrom(""), 0);
        assert.equal(__testing.numberFrom("12"), 12);

        const originalEnv = {
            DATABASE_USERNAME: process.env.DATABASE_USERNAME,
            DATABASE_PASSWORD: process.env.DATABASE_PASSWORD,
            DATABASE_HOST: process.env.DATABASE_HOST,
            DATABASE_PORT: process.env.DATABASE_PORT,
            PGBOUNCER_HOST: process.env.PGBOUNCER_HOST,
            PGBOUNCER_PORT: process.env.PGBOUNCER_PORT,
        };
        try {
            delete process.env.DATABASE_USERNAME;
            delete process.env.DATABASE_PASSWORD;
            delete process.env.DATABASE_HOST;
            delete process.env.DATABASE_PORT;
            delete process.env.PGBOUNCER_HOST;
            delete process.env.PGBOUNCER_PORT;
            assert.equal(
                __testing.buildPostgresUri(),
                "postgresql://postgres:postgres@postgres:5432/postgres"
            );
            assert.equal(
                __testing.buildPgBouncerUri(),
                "postgresql://postgres:postgres@pgbouncer:5432/pgbouncer"
            );

            process.env.DATABASE_USERNAME = "user@name";
            process.env.DATABASE_PASSWORD = "";
            process.env.DATABASE_HOST = "db";
            process.env.DATABASE_PORT = "6543";
            process.env.PGBOUNCER_HOST = "pool";
            process.env.PGBOUNCER_PORT = "7654";
            assert.equal(
                __testing.buildPostgresUri("custom/name #1"),
                "postgresql://user%40name:@db:6543/custom%2Fname%20%231"
            );
            assert.equal(
                __testing.buildPgBouncerUri("pool admin"),
                "postgresql://user%40name:@pool:7654/pool%20admin"
            );

            process.env.DATABASE_PASSWORD = "p:a/ss#";
            assert.equal(
                __testing.buildPostgresUri(),
                "postgresql://user%40name:p%3Aa%2Fss%23@db:6543/postgres"
            );

            process.env.DATABASE_HOST = "   ";
            process.env.DATABASE_PORT = "  ";
            process.env.PGBOUNCER_HOST = "   ";
            process.env.PGBOUNCER_PORT = "  ";
            assert.equal(
                __testing.buildPostgresUri(),
                "postgresql://user%40name:p%3Aa%2Fss%23@postgres:5432/postgres"
            );
            assert.equal(
                __testing.buildPgBouncerUri(),
                "postgresql://user%40name:p%3Aa%2Fss%23@pgbouncer:5432/pgbouncer"
            );

            process.env.DATABASE_HOST = "[::1]";
            process.env.DATABASE_PORT = "05432";
            assert.equal(
                __testing.buildPostgresUri("ipv6"),
                "postgresql://user%40name:p%3Aa%2Fss%23@[::1]:5432/ipv6"
            );
            process.env.DATABASE_HOST = "::1";
            assert.equal(
                __testing.buildPostgresUri("raw-ipv6"),
                "postgresql://user%40name:p%3Aa%2Fss%23@[::1]:5432/raw-ipv6"
            );
            process.env.DATABASE_HOST = "pg_bouncer";
            assert.equal(
                __testing.buildPostgresUri("underscore-host"),
                "postgresql://user%40name:p%3Aa%2Fss%23@pg_bouncer:5432/underscore-host"
            );

            process.env.DATABASE_HOST = "999.1.1.1";
            assert.throws(() => __testing.buildPostgresUri(), {
                code: "EINVAL",
            });
            process.env.DATABASE_HOST = "db;touch /tmp/pwned";
            assert.throws(() => __testing.buildPostgresUri(), {
                code: "EINVAL",
            });
            process.env.DATABASE_HOST = "db";
            process.env.DATABASE_PORT = "5432;id";
            assert.throws(() => __testing.buildPostgresUri(), {
                code: "EINVAL",
            });
            process.env.DATABASE_PORT = "70000";
            assert.throws(() => __testing.buildPostgresUri(), {
                code: "EINVAL",
            });
        } finally {
            for (const [key, value] of Object.entries(originalEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    it("returns aggregated database overview from Postgres and PgBouncer", async () => {
        delete process.env.FAKE_DB_MODE;
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

    it("includes pg_stat_statements top queries when the extension is enabled", async () => {
        process.env.FAKE_DB_MODE = "pgstat";
        const response = await fetch(`${server.baseUrl}/api/database/overview`);
        const body = (await response.json()) as {
            overview: { pgStatStatementsEnabled: boolean };
            topQueries: Array<{ query: string; calls: string; mean_exec_time: string }>;
        };

        assert.equal(response.status, 200);
        assert.equal(body.overview.pgStatStatementsEnabled, true);
        assert.deepEqual(body.topQueries, [
            {
                query: "SELECT * FROM table",
                calls: "3",
                total_exec_time: "12.50",
                mean_exec_time: "4.17",
                rows: "9",
                shared_blks_hit: "20",
                shared_blks_read: "2",
            },
        ]);
    });

    it("defaults aggregate metrics when database and PgBouncer tables are empty", async () => {
        process.env.FAKE_DB_MODE = "empty";
        const response = await fetch(`${server.baseUrl}/api/database/overview`);
        const body = (await response.json()) as {
            overview: {
                totalDatabaseSizeBytes: number;
                totalBackends: number;
                averageCacheHitRatio: number;
                pgbouncer: { avgQueryTime: number; avgTransactionTime: number };
            };
            databases: unknown[];
            pgbouncerStats: unknown[];
        };

        assert.equal(response.status, 200);
        assert.equal(body.overview.totalDatabaseSizeBytes, 0);
        assert.equal(body.overview.totalBackends, 0);
        assert.equal(body.overview.averageCacheHitRatio, 0);
        assert.equal(body.overview.pgbouncer.avgQueryTime, 0);
        assert.equal(body.overview.pgbouncer.avgTransactionTime, 0);
        assert.deepEqual(body.databases, []);
        assert.deepEqual(body.pgbouncerStats, []);
    });

    it("returns route errors when docker queries fail", async () => {
        process.env.FAKE_DB_MODE = "error";
        const response = await fetch(`${server.baseUrl}/api/database/overview`);
        const body = (await response.json()) as { error: string };

        assert.equal(response.status, 500);
        assert.equal(body.error, "Failed to load database overview");
    });
});
