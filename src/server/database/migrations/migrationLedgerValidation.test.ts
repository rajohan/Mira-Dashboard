import { expect, test } from "bun:test";

import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "../../test/support/freshDatabase.ts";
import { applyVerifiedMigrations } from "./applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";

test("validates every raw field in the durable migration ledger", async () => {
    const migrations = await loadVerifiedMigrations({ directory: migrationsDirectory });
    const corruptions = [
        "UPDATE schema_migrations SET applied_at = -1",
        "UPDATE schema_migrations SET id = 'invalid'",
        `UPDATE schema_migrations SET release_id = '${"A".repeat(40)}'`,
    ] as const;

    for (const corruption of corruptions) {
        const database = await openFreshMigratedDatabase();
        try {
            database.sqlite.run(corruption);
            expect(() =>
                applyVerifiedMigrations(database.sqlite, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database migration history does not match the reviewed manifest");
        } finally {
            database.sqlite.close(true);
        }
    }
});
