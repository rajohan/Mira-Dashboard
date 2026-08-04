import { Database } from "bun:sqlite";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { applyVerifiedMigrations } from "./applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";

const testReleaseId = "0".repeat(40);

/** Root of the immutable Drizzle migration graph used by fresh-database tests. */
export const migrationsDirectory = path.resolve(
    import.meta.dir,
    "../../../../migrations"
);

/**
 * Opens an isolated database and applies every tracked migration.
 * @returns Paired native and typed clients for the migrated in-memory database.
 */
export async function openFreshMigratedDatabase() {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run("PRAGMA foreign_keys = ON");

    try {
        const orm = drizzle({ client: sqlite });
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        applyVerifiedMigrations(sqlite, migrations, {
            appliedAt: new Date("2026-08-03T23:32:57.000Z"),
            releaseId: testReleaseId,
        });

        return { orm, sqlite };
    } catch (error) {
        sqlite.close(true);
        throw error;
    }
}
