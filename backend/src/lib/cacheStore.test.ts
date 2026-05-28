import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __testing, parseJsonField, parseTable } from "./cacheStore.js";

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

    it("builds Postgres URIs from defaults and environment overrides", () => {
        const original = {
            username: process.env.DATABASE_USERNAME,
            password: process.env.DATABASE_PASSWORD,
            host: process.env.DATABASE_HOST,
            port: process.env.DATABASE_PORT,
        };

        try {
            delete process.env.DATABASE_USERNAME;
            delete process.env.DATABASE_PASSWORD;
            delete process.env.DATABASE_HOST;
            delete process.env.DATABASE_PORT;
            assert.equal(
                __testing.buildPostgresUri(),
                "postgresql://postgres:postgres@postgres:5432/n8n"
            );

            process.env.DATABASE_USERNAME = "user@name";
            process.env.DATABASE_PASSWORD = "p:a/ss#";
            process.env.DATABASE_HOST = "db";
            process.env.DATABASE_PORT = "6543";
            assert.equal(
                __testing.buildPostgresUri("cache/name?#"),
                "postgresql://user%40name:p%3Aa%2Fss%23@db:6543/cache%2Fname%3F%23"
            );
        } finally {
            if (original.username === undefined) delete process.env.DATABASE_USERNAME;
            else process.env.DATABASE_USERNAME = original.username;
            if (original.password === undefined) delete process.env.DATABASE_PASSWORD;
            else process.env.DATABASE_PASSWORD = original.password;
            if (original.host === undefined) delete process.env.DATABASE_HOST;
            else process.env.DATABASE_HOST = original.host;
            if (original.port === undefined) delete process.env.DATABASE_PORT;
            else process.env.DATABASE_PORT = original.port;
        }
    });
});
