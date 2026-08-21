import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
    assertConstraintEnforcement,
    assertDatabaseIntegrity,
} from "./verifyDatabaseIntegrity.ts";

interface FakeQueryResult {
    all?: readonly unknown[];
    get?: unknown;
}

function fakeDatabase(results: Readonly<Record<string, FakeQueryResult>>): Database {
    return {
        query: (sql: string) => ({
            all: () => results[sql]?.all ?? [],
            get: () => results[sql]?.get ?? null,
        }),
    } as unknown as Database;
}

describe("raw SQLite integrity rows", () => {
    test("maps a malformed foreign-key pragma row to the operational error", () => {
        const database = fakeDatabase({
            "PRAGMA foreign_keys": { get: { foreign_keys: "1" } },
        });

        expect(() => assertConstraintEnforcement(database)).toThrow(
            "Database foreign key enforcement must be enabled"
        );
    });

    test("maps a malformed check-constraint pragma row to the operational error", () => {
        const database = fakeDatabase({
            "PRAGMA foreign_keys": { get: { foreign_keys: 1 } },
            "PRAGMA ignore_check_constraints": {
                get: { ignore_check_constraints: "0" },
            },
        });

        expect(() => assertConstraintEnforcement(database)).toThrow(
            "Database check constraint enforcement must be enabled"
        );
    });

    test("maps malformed integrity rows to the operational error", () => {
        const database = fakeDatabase({
            "PRAGMA foreign_key_check": { get: null },
            "PRAGMA integrity_check": { all: [{ integrity_check: 1 }] },
        });

        expect(() => assertDatabaseIntegrity(database)).toThrow(
            "Database integrity check failed"
        );
    });
});
