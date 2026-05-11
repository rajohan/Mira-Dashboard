import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseJsonField, parseTable } from "./cacheStore.js";

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
});
