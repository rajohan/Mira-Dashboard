import { Database } from "bun:sqlite";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/** Root of the immutable Drizzle migration graph used by fresh-database tests. */
export const migrationsDirectory = path.resolve(
    import.meta.dir,
    "../../../../migrations"
);

/**
 * Opens an isolated database and applies every tracked migration.
 * @returns Paired native and typed clients for the migrated in-memory database.
 */
export function openFreshMigratedDatabase() {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");

    try {
        const orm = drizzle({ client: sqlite });
        const migrationFailure = migrate(orm, { migrationsFolder: migrationsDirectory });

        if (migrationFailure) {
            throw new Error(
                `Drizzle migration initialization failed: ${migrationFailure.exitCode}`
            );
        }

        return { orm, sqlite };
    } catch (error) {
        sqlite.close(true);
        throw error;
    }
}
