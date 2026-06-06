import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { db } from "../db.js";
import { clearCacheEntries, seedCacheEntry } from "../testUtils/cacheEntries.js";
import { fetchCachedSystemHost } from "./systemCache.js";

const systemPayload = {
    version: {
        current: "v2026.5.4",
        latest: "v2026.5.5",
        updateAvailable: true,
        checkedAt: 1_800_000_000_000,
    },
    doctorWarningCount: 2,
};

describe("system cache helpers", () => {
    beforeEach(() => {
        clearCacheEntries();
        seedCacheEntry({
            key: "system.host",
            data: systemPayload,
            source: "system",
            errorCode: "WARN",
            errorMessage: "Careful",
            consecutiveFailures: 2,
            metadata: { producer: "test" },
        });
    });

    it("maps fresh system.host cache rows into API shape", async () => {
        const cached = await fetchCachedSystemHost();

        assert.equal(cached.source, "system");
        assert.equal(cached.status, "fresh");
        assert.equal(cached.updatedAt, "2026-05-11T00:00:00.000Z");
        assert.equal(cached.expiresAt, "2099-05-11T01:00:00.000Z");
        assert.equal(cached.errorCode, "WARN");
        assert.equal(cached.errorMessage, "Careful");
        assert.equal(cached.consecutiveFailures, 2);
        assert.deepEqual(cached.meta, { producer: "test" });
        assert.deepEqual(cached.data.version, systemPayload.version);
        assert.equal(cached.data.doctorWarningCount, 2);
    });

    it("maps nullable metadata fields to null/default values", async () => {
        clearCacheEntries();
        seedCacheEntry({
            key: "system.host",
            data: systemPayload,
            source: "system",
            updatedAt: "",
            expiresAt: "",
        });

        const cached = await fetchCachedSystemHost();

        assert.equal(cached.updatedAt, null);
        assert.equal("lastAttemptAt" in cached, false);
        assert.equal(cached.expiresAt, null);
        assert.equal(cached.errorCode, null);
        assert.equal(cached.errorMessage, null);
        assert.equal(cached.consecutiveFailures, 0);
        assert.deepEqual(cached.meta, {});

        db.prepare(
            "UPDATE cache_entries SET consecutive_failures = ?, metadata_json = ? WHERE key = ?"
        ).run("", "", "system.host");
        const invalidMeta = await fetchCachedSystemHost();
        assert.equal(invalidMeta.consecutiveFailures, 0);
        assert.deepEqual(invalidMeta.meta, {});
    });

    it("rejects missing, stale, and invalid system host cache rows", async () => {
        clearCacheEntries();
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache entry not found or not fresh",
        });

        seedCacheEntry({
            key: "system.host",
            data: systemPayload,
            source: "system",
            status: "stale",
        });
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache entry not found or not fresh",
        });

        seedCacheEntry({
            key: "system.host",
            data: "not-json",
            source: "system",
        });
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache payload is invalid",
        });
    });
});
