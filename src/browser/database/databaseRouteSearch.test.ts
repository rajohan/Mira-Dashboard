import { describe, expect, test } from "bun:test";

import { normalizeDatabaseSearch } from "./databaseRouteSearch.ts";

describe("database route search", () => {
    test("keeps either exact reviewed database source", () => {
        expect(normalizeDatabaseSearch({ ignored: true, source: "sqlite" })).toEqual({
            source: "sqlite",
        });
        expect(normalizeDatabaseSearch({ source: "postgresql" })).toEqual({
            source: "postgresql",
        });
    });

    test("normalizes unsupported or malformed sources to SQLite", () => {
        expect(normalizeDatabaseSearch({ source: "postgres" })).toEqual({
            source: "sqlite",
        });
        expect(normalizeDatabaseSearch({ source: "PostgreSQL" })).toEqual({
            source: "sqlite",
        });
        expect(normalizeDatabaseSearch({ source: ["sqlite"] })).toEqual({
            source: "sqlite",
        });
        expect(normalizeDatabaseSearch(null)).toEqual({ source: "sqlite" });
    });
});
