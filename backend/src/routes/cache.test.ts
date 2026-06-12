import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import express from "express";

import {
    clearCacheEntries,
    insertCacheEntry as insertCacheFixture,
} from "../testUtils/cacheFixtures.js";
import cacheRoutes from "./cache.js";
import {
    __testing,
    mapCacheRowForResponse,
    parseJsonFieldOrValue,
    refreshCacheKey,
} from "./cache.js";

const baseRow = {
    key: "quotas.summary",
    data: '{"usage":12}',
    source: "backend",
    updated_at: "2026-05-10T19:00:00.000Z",
    last_attempt_at: "2026-05-10T19:01:00.000Z",
    expires_at: "2026-05-10T20:00:00.000Z",
    status: "fresh",
    error_code: "",
    error_message: "",
    consecutive_failures: "2",
    meta: '{"job":"quotas"}',
};

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

function insertCacheEntry(key = "quotas.summary"): void {
    insertCacheFixture({
        key,
        data: { usage: 12 },
        source: "backend",
        updatedAt: "2026-05-10T19:00:00.000Z",
        lastAttemptAt: "2026-05-10T19:01:00.000Z",
        expiresAt: "2099-05-10T20:00:00.000Z",
        status: "fresh",
        errorCode: null,
        errorMessage: null,
        consecutiveFailures: 2,
        meta: { job: "quotas" },
    });
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
    let server: TestServer;

    before(async () => {
        server = await startServer();
    });

    beforeEach(() => {
        clearCacheEntries();
        __testing.resetCacheRefreshForTests();
    });

    after(async () => {
        if (server) {
            await server.close();
        }
        __testing.resetCacheRefreshForTests();
    });

    it("keeps scalar cache payloads when they are not JSON", () => {
        assert.equal(parseJsonFieldOrValue("plain text"), "plain text");
        assert.deepEqual(parseJsonFieldOrValue("[1,2]"), [1, 2]);
    });

    it("maps cache database rows into API response shape", () => {
        assert.deepEqual(mapCacheRowForResponse(baseRow), {
            key: "quotas.summary",
            source: "backend",
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

    it("serves heartbeat and cache entries from the cache store", async () => {
        insertCacheEntry();

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

        __testing.setCacheRefreshProducerForTests(async () => {
            throw Object.assign(new Error("fallback status"), { statusCode: 0 });
        });
        const fallbackStatus = await fetch(
            `${server.baseUrl}/api/cache/fallback.status/refresh`,
            { method: "POST" }
        );
        assert.equal(fallbackStatus.status, 500);
        assert.deepEqual(await fallbackStatus.json(), { error: "fallback status" });
    });

    it("refreshes cache keys through the configured producer", async () => {
        __testing.setCacheRefreshProducerForTests(async (key) => {
            insertCacheEntry(key);
        });

        const refreshed = await refreshCacheKey("quotas.summary");
        assert.equal(refreshed.key, "quotas.summary");

        const routeRefresh = await fetch(
            `${server.baseUrl}/api/cache/quotas.summary/refresh`,
            { method: "POST" }
        );
        assert.equal(routeRefresh.status, 200);
        assert.equal(((await routeRefresh.json()) as { ok: boolean }).ok, true);
    });

    it("reports when a producer does not write the requested cache row", async () => {
        __testing.setCacheRefreshProducerForTests(async () => {});

        await assert.rejects(() => refreshCacheKey("missing.key"), {
            message: "Cache key not found after refresh: missing.key",
        });
    });
});
