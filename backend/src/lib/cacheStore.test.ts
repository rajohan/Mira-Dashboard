import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { db } from "../db.js";
import { seedCacheEntry } from "../testUtils/cacheEntries.js";
import { __testing, getCacheEntry, parseJsonField } from "./cacheStore.js";

describe("cacheStore utilities", () => {
    it("parses valid JSON fields and safely rejects invalid or blank payloads", () => {
        assert.deepEqual(parseJsonField<{ ok: boolean }>('{"ok":true}'), { ok: true });
        assert.equal(parseJsonField("not json"), null);
        assert.equal(parseJsonField(""), null);
    });

    it("keeps legacy docker-bin test hooks as no-op compatibility helpers", () => {
        assert.equal(__testing.getDockerBinForTests(), undefined);
        assert.equal(__testing.setDockerBinForTests("/bin/docker"), undefined);
    });

    it("maps nullable SQLite cache payloads to legacy empty fields", async () => {
        seedCacheEntry({ key: "cache.null", data: undefined, source: "test" });
        try {
            const entry = await getCacheEntry("cache.null");
            assert.equal(entry?.data, "");
        } finally {
            db.prepare("DELETE FROM cache_entries WHERE key = 'cache.null'").run();
        }
    });

    it("marks expired fresh cache rows as stale", async () => {
        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, error_code, error_message, consecutive_failures, metadata_json
            ) VALUES
                ('cache.expired', '{}', 'test', '', '', '2020-01-01T00:00:00.000Z', 'fresh', NULL, NULL, 0, '{}'),
                ('cache.invalid-expiry', '{}', 'test', '', '', 'not a date', 'fresh', NULL, NULL, 0, '{}')`
        ).run();
        try {
            const expired = await getCacheEntry("cache.expired");
            const invalidExpiry = await getCacheEntry("cache.invalid-expiry");
            assert.equal(expired?.status, "stale");
            assert.equal(invalidExpiry?.status, "fresh");
        } finally {
            db.prepare(
                "DELETE FROM cache_entries WHERE key IN ('cache.expired', 'cache.invalid-expiry')"
            ).run();
        }
    });
});
