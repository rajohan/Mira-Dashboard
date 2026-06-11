import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import express from "express";

import { db } from "../db.js";
import cacheRoutes from "./cache.js";
import {
    __testing,
    mapCacheRowForResponse,
    parseJsonFieldOrValue,
    refreshCacheKey,
} from "./cache.js";

function expectSingleRefresh(refreshed: Awaited<ReturnType<typeof refreshCacheKey>>) {
    assert.ok(!Array.isArray(refreshed));
    return refreshed;
}

function restorePath(originalPath: string | undefined): void {
    if (originalPath === undefined) {
        delete process.env.PATH;
    } else {
        process.env.PATH = originalPath;
    }
}

const baseRow = {
    key: "quotas.summary",
    data: '{"usage":12}',
    source: "n8n",
    updated_at: "2026-05-10T19:00:00.000Z",
    last_attempt_at: "2026-05-10T19:01:00.000Z",
    expires_at: "2026-05-10T20:00:00.000Z",
    status: "fresh",
    error_code: "",
    error_message: "",
    consecutive_failures: "2",
    meta: '{"job":"quotas"}',
};

const ownedCacheKeys = [
    "backup.walg.status",
    "custom.injected",
    "custom.scalar",
    "moltbook.feed.hot",
    "moltbook.home",
    "partial.one",
    "partial.two",
    "quotas.summary",
];

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

function seedCacheRow(): void {
    db.prepare(
        `INSERT OR REPLACE INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at,
            status, error_code, error_message, consecutive_failures, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(
        "quotas.summary",
        '{"usage":12}',
        "backend-test",
        "2026-05-10T19:00:00.000Z",
        "2026-05-10T19:01:00.000Z",
        "2026-05-10T20:00:00.000Z",
        "fresh",
        2,
        '{"job":"quotas"}'
    );
}

function clearOwnedCacheRows(): void {
    db.prepare(
        `DELETE FROM cache_entries
         WHERE key IN (${ownedCacheKeys.map(() => "?").join(", ")})`
    ).run(...ownedCacheKeys);
}

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    cacheRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            ),
    };
}

describe("cache route mapping helpers", { concurrency: false }, () => {
    let tempDir: string;
    let server: TestServer;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-cache-route-"));
        __testing.setCacheRefreshCwdForTests(tempDir);
        clearOwnedCacheRows();
        seedCacheRow();
        server = await startServer();
    });

    afterEach(async () => {
        try {
            if (server) {
                await server.close();
            }
        } finally {
            __testing.setCacheRefreshCwdForTests(undefined);
            __testing.resetCacheRefreshForTests();
            clearOwnedCacheRows();
            if (tempDir) {
                await rm(tempDir, { recursive: true, force: true });
            }
            server = undefined as unknown as TestServer;
            tempDir = "";
        }
    });

    it("keeps scalar cache payloads when they are not JSON", () => {
        assert.equal(parseJsonFieldOrValue("plain text"), "plain text");
        assert.deepEqual(parseJsonFieldOrValue("[1,2]"), [1, 2]);
    });

    it("maps cache database rows into API response shape", () => {
        assert.deepEqual(mapCacheRowForResponse(baseRow), {
            key: "quotas.summary",
            source: "n8n",
            status: "fresh",
            updatedAt: "2026-05-10T19:00:00.000Z",
            lastAttemptAt: "2026-05-10T19:01:00.000Z",
            expiresAt: "2026-05-10T20:00:00.000Z",
            errorCode: null,
            errorMessage: null,
            consecutiveFailures: 2,
            data: { usage: 12 },
            meta: { job: "quotas" },
        });
    });

    it("defaults nullable row fields and invalid meta safely", () => {
        const mapped = mapCacheRowForResponse({
            ...baseRow,
            updated_at: "",
            last_attempt_at: "",
            expires_at: "",
            error_code: "E_CACHE",
            error_message: "Refresh failed",
            consecutive_failures: "",
            data: "raw output",
            meta: "not json",
        });

        assert.equal(mapped.updatedAt, null);
        assert.equal(mapped.lastAttemptAt, null);
        assert.equal(mapped.expiresAt, null);
        assert.equal(mapped.errorCode, "E_CACHE");
        assert.equal(mapped.errorMessage, "Refresh failed");
        assert.equal(mapped.consecutiveFailures, 0);
        assert.equal(mapped.data, "raw output");
        assert.deepEqual(mapped.meta, {});
    });

    it("rejects refresh requests for unconfigured cache keys before shelling out", async () => {
        assert.equal(__testing.getCacheRefreshCommand("quotas.summary"), undefined);

        await assert.rejects(
            () => refreshCacheKey("not.configured"),
            (error: unknown) => {
                assert.equal(
                    (error as Error).message,
                    "No backend refresh producer configured for cache key: not.configured"
                );
                assert.equal((error as { statusCode?: number }).statusCode, 400);
                return true;
            }
        );
    });

    it("serves heartbeat and cache entries from the cache store", async () => {
        const heartbeat = await fetch(`${server.baseUrl}/api/cache/heartbeat`);
        const heartbeatBody = (await heartbeat.json()) as {
            count: number;
            entries: Array<{ key: string; data: { usage: number } }>;
        };

        assert.equal(heartbeat.status, 200);
        assert.equal(heartbeatBody.count, 1);
        assert.equal(heartbeatBody.entries[0]?.key, "quotas.summary");
        assert.deepEqual(heartbeatBody.entries[0]?.data, { usage: 12 });

        const entry = await fetch(`${server.baseUrl}/api/cache/quotas.summary`);
        const entryBody = (await entry.json()) as { key: string };

        assert.equal(entry.status, 200);
        assert.equal(entryBody.key, "quotas.summary");
    });

    it("reports missing cache entries and refresh errors", async () => {
        const missingRefreshKey = await fetch(`${server.baseUrl}/api/cache/%20/refresh`, {
            method: "POST",
        });
        assert.equal(missingRefreshKey.status, 400);
        assert.deepEqual(await missingRefreshKey.json(), { error: "Missing cache key" });

        const missingGetKey = await fetch(`${server.baseUrl}/api/cache/%20`);
        assert.equal(missingGetKey.status, 400);
        assert.deepEqual(await missingGetKey.json(), { error: "Missing cache key" });

        const missing = await fetch(`${server.baseUrl}/api/cache/missing.key`);
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), {
            error: "Cache key not found",
            key: "missing.key",
        });

        const refresh = await fetch(
            `${server.baseUrl}/api/cache/not.configured/refresh`,
            {
                method: "POST",
            }
        );
        assert.equal(refresh.status, 400);
        assert.deepEqual(await refresh.json(), {
            error: "No backend refresh producer configured for cache key: not.configured",
        });

        __testing.setCacheRefreshRunnerForTests(async () => {
            throw "primitive refresh failure";
        });
        const primitiveFailure = await fetch(
            `${server.baseUrl}/api/cache/quotas.summary/refresh`,
            { method: "POST" }
        );
        assert.equal(primitiveFailure.status, 500);
        assert.deepEqual(await primitiveFailure.json(), {
            error: "Cache refresh failed",
        });
    });

    it("falls back for non-error refresh status codes", async () => {
        __testing.setCacheRefreshRunnerForTests(async () => {
            throw Object.assign(new Error("unexpected status"), { statusCode: 200 });
        });
        try {
            const routeRefresh = await fetch(
                `${server.baseUrl}/api/cache/quotas.summary/refresh`,
                { method: "POST" }
            );
            assert.equal(routeRefresh.status, 500);
            assert.deepEqual(await routeRefresh.json(), { error: "unexpected status" });
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("refreshes configured cache keys and reports missing refreshed rows", async () => {
        const refreshCommand = ["/bin/sh", "-c", "exit 0"];

        __testing.setCacheRefreshCommandForTests("quotas.summary", refreshCommand);
        try {
            const refreshed = expectSingleRefresh(
                await refreshCacheKey("quotas.summary")
            );
            assert.equal(refreshed.key, "quotas.summary");

            db.prepare(
                "DELETE FROM cache_entries WHERE key = 'backup.walg.status'"
            ).run();
            const originalPath = process.env.PATH;
            process.env.PATH = tempDir;
            try {
                await assert.rejects(
                    () => refreshCacheKey("backup.walg.status"),
                    /spawn docker ENOENT/u
                );
            } finally {
                restorePath(originalPath);
            }

            __testing.setCacheRefreshCommandForTests("missing.key", refreshCommand);
            try {
                await assert.rejects(() => refreshCacheKey("missing.key"), {
                    message: "Cache key not found after refresh: missing.key",
                    statusCode: 404,
                });
                const missingRouteRefresh = await fetch(
                    `${server.baseUrl}/api/cache/missing.key/refresh`,
                    { method: "POST" }
                );
                assert.equal(missingRouteRefresh.status, 404);
                assert.deepEqual(await missingRouteRefresh.json(), {
                    error: "Cache key not found after refresh: missing.key",
                });
            } finally {
                __testing.setCacheRefreshCommandForTests("missing.key", undefined);
            }

            const routeRefresh = await fetch(
                `${server.baseUrl}/api/cache/quotas.summary/refresh`,
                { method: "POST" }
            );
            const routeRefreshBody = (await routeRefresh.json()) as {
                entries: Array<{ key: string }>;
                ok: boolean;
            };
            assert.equal(routeRefresh.status, 200);
            assert.equal(routeRefreshBody.ok, true);
            assert.deepEqual(
                routeRefreshBody.entries.map((entry) => entry.key),
                ["quotas.summary"]
            );

            __testing.setCacheRefreshCommandForTests("quotas.summary", []);
            assert.equal(__testing.getCacheRefreshCommand("quotas.summary"), undefined);

            __testing.setCacheRefreshCommandForTests("quotas.summary", [
                "/bin/sh",
                "-c",
                "exit 2",
            ]);
            const failedRouteRefresh = await fetch(
                `${server.baseUrl}/api/cache/quotas.summary/refresh`,
                { method: "POST" }
            );
            assert.equal(failedRouteRefresh.status, 500);
        } finally {
            __testing.setCacheRefreshCommandForTests("quotas.summary", undefined);
        }
    });

    it("uses injected cache refresh runners for tests", async () => {
        __testing.setCacheRefreshRunnerForTests(async (key) => {
            db.prepare(
                `INSERT OR REPLACE INTO cache_entries (
                    key, data_json, source, updated_at, last_attempt_at, expires_at,
                    status, error_code, error_message, consecutive_failures, metadata_json
                ) VALUES (?, '{"ok":true}', 'injected', ?, ?, ?, 'fresh', NULL, NULL, 0, '{}')`
            ).run(
                key,
                "2026-06-06T00:00:00.000Z",
                "2026-06-06T00:00:00.000Z",
                "2026-06-06T01:00:00.000Z"
            );
            return { refreshed: [key] };
        });
        try {
            const refreshed = expectSingleRefresh(
                await refreshCacheKey("custom.injected")
            );
            assert.equal(refreshed.key, "custom.injected");
            assert.equal(refreshed.source, "injected");
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("rejects refresh output without a refreshed key list", async () => {
        __testing.setCacheRefreshRunnerForTests(async (key) => {
            db.prepare(
                `INSERT OR REPLACE INTO cache_entries (
                    key, data_json, source, updated_at, last_attempt_at, expires_at,
                    status, error_code, error_message, consecutive_failures, metadata_json
                ) VALUES (?, '{"ok":true}', 'scalar', ?, ?, ?, 'fresh', NULL, NULL, 0, '{}')`
            ).run(
                key,
                "2026-06-06T00:00:00.000Z",
                "2026-06-06T00:00:00.000Z",
                "2026-06-06T01:00:00.000Z"
            );
            return { refreshed: key } as unknown as { refreshed: string[] };
        });
        try {
            await assert.rejects(() => refreshCacheKey("custom.scalar"), {
                message:
                    "Invalid refreshed payload for custom.scalar: refreshed must be an array",
            });
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("rejects null refresh output before reading refreshed keys", async () => {
        __testing.setCacheRefreshRunnerForTests(
            async () => null as unknown as { refreshed: string[] }
        );
        try {
            await assert.rejects(() => refreshCacheKey("custom.null"), {
                message:
                    "Invalid refreshed payload for custom.null: result is null or undefined",
            });
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("rejects refresh output with an empty refreshed key list", async () => {
        __testing.setCacheRefreshRunnerForTests(async () => ({ refreshed: [] }));
        try {
            await assert.rejects(() => refreshCacheKey("custom.empty"), {
                message: "Cache key not found after refresh: custom.empty",
                statusCode: 404,
            });
            const routeRefresh = await fetch(
                `${server.baseUrl}/api/cache/custom.empty/refresh`,
                { method: "POST" }
            );
            assert.equal(routeRefresh.status, 404);
            assert.deepEqual(await routeRefresh.json(), {
                error: "Cache key not found after refresh: custom.empty",
            });
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("rejects refresh output without string refreshed keys", async () => {
        __testing.setCacheRefreshRunnerForTests(async () => {
            return { refreshed: [123] } as unknown as { refreshed: string[] };
        });
        try {
            await assert.rejects(() => refreshCacheKey("custom.numeric"), {
                message: "Invalid refreshed cache key for custom.numeric: 123",
                statusCode: 500,
            });
            const routeRefresh = await fetch(
                `${server.baseUrl}/api/cache/custom.numeric/refresh`,
                { method: "POST" }
            );
            assert.equal(routeRefresh.status, 500);
            assert.deepEqual(await routeRefresh.json(), {
                error: "Invalid refreshed cache key for custom.numeric: 123",
            });
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("rejects undefined refreshed keys before cache lookup", async () => {
        __testing.setCacheRefreshRunnerForTests(async () => {
            return { refreshed: [undefined] } as unknown as { refreshed: string[] };
        });
        try {
            await assert.rejects(() => refreshCacheKey("custom.undefined"), {
                message: "Invalid refreshed cache key for custom.undefined: undefined",
                statusCode: 500,
            });
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("rejects blank refreshed keys before cache lookup", async () => {
        __testing.setCacheRefreshRunnerForTests(async () => {
            return { refreshed: ["  "] };
        });
        try {
            await assert.rejects(() => refreshCacheKey("custom.blank"), {
                message: 'Invalid refreshed cache key for custom.blank: "  "',
                statusCode: 500,
            });
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("uses aggregate refresh results when the producer returns multiple keys", async () => {
        __testing.setCacheRefreshRunnerForTests(async () => {
            for (const key of ["moltbook.home", "moltbook.feed.hot"]) {
                db.prepare(
                    `INSERT INTO cache_entries (
                        key, data_json, source, updated_at, last_attempt_at, expires_at,
                        status, error_code, error_message, consecutive_failures, metadata_json
                    ) VALUES (?, '{"ok":true}', 'aggregate', ?, ?, ?, 'fresh', NULL, NULL, 0, '{}')`
                ).run(
                    key,
                    "2026-06-06T00:00:00.000Z",
                    "2026-06-06T00:00:00.000Z",
                    "2026-06-06T01:00:00.000Z"
                );
            }
            return { refreshed: ["moltbook.home", "moltbook.feed.hot"] };
        });
        try {
            const refreshed = await refreshCacheKey("moltbook");

            assert.ok(Array.isArray(refreshed));
            assert.deepEqual(
                refreshed.map((entry) => entry.key),
                ["moltbook.home", "moltbook.feed.hot"]
            );
            assert.equal(refreshed[0]?.source, "aggregate");

            db.prepare(
                "DELETE FROM cache_entries WHERE key IN ('moltbook.home', 'moltbook.feed.hot')"
            ).run();
            const routeRefresh = await fetch(
                `${server.baseUrl}/api/cache/moltbook/refresh`,
                { method: "POST" }
            );
            const routeBody = (await routeRefresh.json()) as {
                entries: Array<{ key: string }>;
                ok: boolean;
            };
            assert.equal(routeBody.ok, true);
            assert.deepEqual(
                routeBody.entries.map((entry) => entry.key),
                ["moltbook.home", "moltbook.feed.hot"]
            );
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("fails aggregate refreshes when a declared refreshed key is missing", async () => {
        __testing.setCacheRefreshRunnerForTests(async () => {
            db.prepare(
                `INSERT OR REPLACE INTO cache_entries (
                    key, data_json, source, updated_at, last_attempt_at, expires_at,
                    status, error_code, error_message, consecutive_failures, metadata_json
                ) VALUES ('partial.one', '{"ok":true}', 'aggregate', ?, ?, ?, 'fresh', NULL, NULL, 0, '{}')`
            ).run(
                "2026-06-06T00:00:00.000Z",
                "2026-06-06T00:00:00.000Z",
                "2026-06-06T01:00:00.000Z"
            );
            return { refreshed: ["partial.one", "partial.two"] };
        });
        try {
            await assert.rejects(() => refreshCacheKey("moltbook"), {
                message: "Cache key not found after refresh: partial.two",
                statusCode: 404,
            });
            const routeRefresh = await fetch(
                `${server.baseUrl}/api/cache/moltbook/refresh`,
                { method: "POST" }
            );
            assert.equal(routeRefresh.status, 404);
            assert.deepEqual(await routeRefresh.json(), {
                error: "Cache key not found after refresh: partial.two",
            });
        } finally {
            __testing.resetCacheRefreshForTests();
        }
    });

    it("refreshes WAL-G backup status through backend SQLite cache", async () => {
        const binDir = await mkdtemp(path.join(tempDir, "fake-bin-"));
        const dockerPath = path.join(binDir, "docker");
        await writeFile(
            dockerPath,
            String.raw`#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(" ") !== "exec walg wal-g backup-list --detail --json") {
    console.error("unexpected docker args: " + args.join(" "));
    process.exit(2);
}
process.stdout.write(JSON.stringify([
    {
        backup_name: "base_0002",
        modified: "2099-01-02T03:04:05.000Z",
        time: "2099-01-02T03:00:00.000Z",
        start_time: "2099-01-02T03:00:00.000Z",
        finish_time: "2099-01-02T03:04:05.000Z",
        wal_file_name: "0000000100000000000000BB",
        storage_name: "default"
    },
    {
        backup_name: "base_0001",
        finish_time: "2099-01-01T03:04:05.000Z",
        wal_file_name: "0000000100000000000000AA"
    }
]));
`,
            "utf8"
        );
        await chmod(dockerPath, 0o755);
        const originalPath = process.env.PATH;
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        try {
            const refreshed = expectSingleRefresh(
                await refreshCacheKey("backup.walg.status")
            );

            assert.equal(refreshed.key, "backup.walg.status");
            assert.equal(refreshed.source, "backend");
            assert.equal(refreshed.status, "fresh");
            assert.equal(
                (refreshed.data as { latest?: { backupName?: string } }).latest
                    ?.backupName,
                "base_0002"
            );
            assert.equal(
                (refreshed.data as { latest?: { walFileName?: string } }).latest
                    ?.walFileName,
                "0000000100000000000000BB"
            );
            assert.equal((refreshed.data as { backupCount?: number }).backupCount, 2);
            assert.equal((refreshed.data as { ok?: boolean }).ok, true);
        } finally {
            restorePath(originalPath);
        }
    });
});
