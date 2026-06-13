import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { clearCacheEntries, insertCacheEntry } from "../testUtils/cacheFixtures.js";
import { fetchCachedSystemHost } from "./systemCache.js";

function insertSystemHost(
    data: unknown,
    options: Partial<Parameters<typeof insertCacheEntry>[0]> = {}
): void {
    insertCacheEntry({
        key: "system.host",
        data,
        source: "system",
        errorCode: "WARN",
        errorMessage: "Careful",
        consecutiveFailures: 2,
        meta: { producer: "test" },
        ...options,
    });
}

describe("system cache helpers", () => {
    beforeEach(() => {
        clearCacheEntries();
    });

    it("maps fresh system.host cache rows into API shape", async () => {
        insertSystemHost({
            version: {
                current: "v2026.5.4",
                latest: "v2026.5.5",
                updateAvailable: true,
                checkedAt: 1_800_000_000_000,
            },
            doctorWarningCount: 2,
        });

        const cached = await fetchCachedSystemHost();

        assert.equal(cached.source, "system");
        assert.equal(cached.status, "fresh");
        assert.equal(cached.updatedAt, "2026-05-11T00:00:00.000Z");
        assert.equal(cached.expiresAt, "2099-05-11T01:00:00.000Z");
        assert.equal(cached.errorCode, "WARN");
        assert.equal(cached.errorMessage, "Careful");
        assert.equal(cached.consecutiveFailures, 2);
        assert.deepEqual(cached.meta, { producer: "test" });
        assert.deepEqual(cached.data.version, {
            current: "v2026.5.4",
            latest: "v2026.5.5",
            updateAvailable: true,
            checkedAt: 1_800_000_000_000,
        });
        assert.equal(cached.data.doctorWarningCount, 2);
    });

    it("maps nullable metadata fields to null/default values", async () => {
        insertSystemHost(
            {
                version: {
                    current: "v2026.5.4",
                    latest: null,
                    updateAvailable: false,
                },
            },
            {
                consecutiveFailures: 0,
                errorCode: null,
                errorMessage: null,
                expiresAt: "",
                lastAttemptAt: "",
                meta: "not-json",
                updatedAt: null,
            }
        );

        const cached = await fetchCachedSystemHost();

        assert.equal(cached.updatedAt, null);
        assert.equal("lastAttemptAt" in cached, false);
        assert.equal(cached.expiresAt, null);
        assert.equal(cached.errorCode, null);
        assert.equal(cached.errorMessage, null);
        assert.equal(cached.consecutiveFailures, 0);
        assert.deepEqual(cached.meta, {});
    });

    it("rejects missing, stale, and invalid system host cache rows", async () => {
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache entry not found or not fresh",
        });

        insertSystemHost({ version: {} }, { status: "stale" });
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache entry not found or not fresh",
        });

        insertSystemHost("not-json");
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache payload is invalid",
        });
    });
});
