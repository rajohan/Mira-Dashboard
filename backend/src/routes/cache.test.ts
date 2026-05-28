import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import { setCacheStoreDockerBinForTests } from "../lib/cacheStore.js";
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

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function installFakeDocker(tempDir: string): Promise<string> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!${process.execPath}
const command = process.argv.join(" ");
const header = "key\tdata\tsource\tupdated_at\tlast_attempt_at\texpires_at\tstatus\terror_code\terror_message\tconsecutive_failures\tmeta";
const row = "quotas.summary\t{\"usage\":12}\tn8n\t2026-05-10T19:00:00.000Z\t2026-05-10T19:01:00.000Z\t2026-05-10T20:00:00.000Z\tfresh\t\t\t2\t{\"job\":\"quotas\"}";
if (command.includes("WHERE key = 'missing.key'")) {
  process.stdout.write(header + "\n");
} else {
  process.stdout.write(header + "\n" + row + "\n");
}
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    setCacheStoreDockerBinForTests(dockerPath);
    return dockerPath;
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
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

describe("cache route mapping helpers", { concurrency: false }, () => {
    let tempDir: string;
    let server: TestServer;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-cache-route-"));
        __testing.setCacheRefreshCwdForTests(tempDir);
        await installFakeDocker(tempDir);
        server = await startServer();
    });

    after(async () => {
        await server.close();
        __testing.setCacheRefreshCommandForTests("quotas.summary", undefined);
        __testing.setCacheRefreshCwdForTests(undefined);
        setCacheStoreDockerBinForTests(undefined);
        await rm(tempDir, { recursive: true, force: true });
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
        await assert.rejects(() => refreshCacheKey("not.configured"), {
            message: "No refresh command configured for cache key: not.configured",
        });
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
        assert.equal(refresh.status, 500);
        assert.deepEqual(await refresh.json(), {
            error: "No refresh command configured for cache key: not.configured",
        });
    });

    it("refreshes configured cache keys and reports missing refreshed rows", async () => {
        const refreshCommand = ["/bin/sh", "-c", "exit 0"];

        __testing.setCacheRefreshCommandForTests("quotas.summary", refreshCommand);
        const refreshed = await refreshCacheKey("quotas.summary");
        assert.equal(refreshed.key, "quotas.summary");

        __testing.setCacheRefreshCommandForTests("missing.key", refreshCommand);
        try {
            await assert.rejects(() => refreshCacheKey("missing.key"), {
                message: "Cache key not found after refresh: missing.key",
            });
        } finally {
            __testing.setCacheRefreshCommandForTests("missing.key", undefined);
        }

        const routeRefresh = await fetch(
            `${server.baseUrl}/api/cache/quotas.summary/refresh`,
            { method: "POST" }
        );
        assert.equal(routeRefresh.status, 200);
        assert.equal(((await routeRefresh.json()) as { ok: boolean }).ok, true);
    });
});
