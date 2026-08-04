import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { toDate } from "date-fns";

import { migrationsDirectory } from "../../test/support/freshDatabase.ts";
import { applyVerifiedMigrations } from "./applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";

test("rejects an invalid migration timestamp without changing the database", async () => {
    const migrations = await loadVerifiedMigrations({ directory: migrationsDirectory });
    const database = new Database(":memory:", { strict: true });

    try {
        database.run("PRAGMA foreign_keys = ON");
        expect(() =>
            applyVerifiedMigrations(database, migrations, {
                appliedAt: toDate(Number.NaN),
                releaseId: "1".repeat(40),
            })
        ).toThrow("Migration appliedAt must be valid Date milliseconds");
        expect(
            database
                .query<{ name: string }, []>(`
                    SELECT name
                    FROM sqlite_schema
                    WHERE name NOT GLOB 'sqlite_*'
                `)
                .all()
        ).toEqual([]);
    } finally {
        database.close(true);
    }
});
