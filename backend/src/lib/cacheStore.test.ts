import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { db } from "../db.js";
import { clearCacheEntries, insertCacheEntry } from "../testUtils/cacheFixtures.js";
import {
    getAllCacheEntries,
    getCacheEntry,
    parseJsonField,
    parseTable,
} from "./cacheStore.js";

describe("cacheStore utilities", () => {
    it("parses tab-delimited psql output into keyed rows", () => {
        const rows = parseTable<{ key: string; status: string; error: string }>(
            "key\tstatus\terror\nquotas.summary\tfresh\t\nweather.spydeberg\tstale\ttimeout\n"
        );

        assert.deepEqual(rows, [
            { key: "quotas.summary", status: "fresh", error: "" },
            { key: "weather.spydeberg", status: "stale", error: "timeout" },
        ]);
    });

    it("returns an empty list for empty or header-only table output", () => {
        assert.deepEqual(parseTable(""), []);
        assert.deepEqual(parseTable("key\tstatus\n"), []);
    });

    it("parses valid JSON fields and safely rejects invalid or blank payloads", () => {
        assert.deepEqual(parseJsonField<{ ok: boolean }>('{"ok":true}'), { ok: true });
        assert.equal(parseJsonField("not json"), null);
        assert.equal(parseJsonField(""), null);
    });

    it("reads local SQLite cache rows and marks expired fresh rows stale", async () => {
        clearCacheEntries();
        insertCacheEntry({
            key: "weather.spydeberg",
            data: { temperatureC: 12 },
            expiresAt: "2000-01-01T00:00:00.000Z",
            meta: "{}",
        });
        insertCacheEntry({
            key: "quotas.summary",
            data: '{"ok":true}',
            meta: "{}",
        });
        db.prepare("UPDATE cache_entries SET data_json = NULL WHERE key = ?").run(
            "quotas.summary"
        );

        const entry = await getCacheEntry("weather.spydeberg");
        assert.equal(entry?.status, "stale");
        assert.equal(entry?.data, '{"temperatureC":12}');
        const nullPayloadEntry = await getCacheEntry("quotas.summary");
        assert.equal(nullPayloadEntry?.data, "");

        const entries = await getAllCacheEntries();
        assert.deepEqual(
            entries.map((row) => row.key),
            ["quotas.summary", "weather.spydeberg"]
        );
    });
});
