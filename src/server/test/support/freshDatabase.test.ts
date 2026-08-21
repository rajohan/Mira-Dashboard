import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "./freshDatabase.ts";

describe("fresh migrated database fixture", () => {
    test("returns independent writable clones with foreign keys enabled", async () => {
        const [first, second] = await Promise.all([
            openFreshMigratedDatabase(),
            openFreshMigratedDatabase(),
        ]);
        try {
            expect(first.sqlite.query("PRAGMA foreign_keys").values()).toEqual([[1]]);
            expect(second.sqlite.query("PRAGMA foreign_keys").values()).toEqual([[1]]);

            first.sqlite.exec(
                "CREATE TABLE cache_isolation_fixture (id INTEGER PRIMARY KEY)"
            );
            const observed = second.sqlite
                .query<{ count: number }, [string]>(
                    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?"
                )
                .get("cache_isolation_fixture");
            expect(observed?.count).toBe(0);

            const third = await openFreshMigratedDatabase();
            try {
                expect(
                    third.sqlite
                        .query<{ count: number }, [string]>(
                            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?"
                        )
                        .get("cache_isolation_fixture")?.count
                ).toBe(0);
            } finally {
                third.sqlite.close(true);
            }
        } finally {
            first.sqlite.close(true);
            second.sqlite.close(true);
        }
    });
});
