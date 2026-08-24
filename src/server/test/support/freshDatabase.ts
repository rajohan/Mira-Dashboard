import { Database } from "bun:sqlite";
import path from "node:path";

import { parseISO } from "date-fns";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { applyVerifiedMigrations } from "../../database/migrations/applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "../../database/migrations/loadVerifiedMigrations.ts";

const testReleaseId = "0".repeat(40);
let migratedDatabaseImagePromise: Promise<Uint8Array> | undefined;

/** Root of the reviewed Drizzle baseline used by fresh-database tests. */
export const migrationsDirectory = path.resolve(
    import.meta.dir,
    "../../../../migrations"
);

async function createMigratedDatabaseImage(): Promise<Uint8Array> {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run("PRAGMA foreign_keys = ON");
    try {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        applyVerifiedMigrations(sqlite, migrations, {
            appliedAt: parseISO("2026-08-03T23:32:57.000Z"),
            releaseId: testReleaseId,
        });
        return sqlite.serialize();
    } finally {
        sqlite.close(true);
    }
}

async function migratedDatabaseImage(): Promise<Uint8Array> {
    const pending = migratedDatabaseImagePromise ?? createMigratedDatabaseImage();
    migratedDatabaseImagePromise = pending;
    try {
        return await pending;
    } catch (error) {
        if (migratedDatabaseImagePromise === pending) {
            migratedDatabaseImagePromise = undefined;
        }
        throw error;
    }
}

/**
 * Opens an isolated writable clone of the canonical per-worker migrated image.
 * @returns Paired native and typed clients for the migrated in-memory database.
 */
export async function openFreshMigratedDatabase() {
    const sqlite = Database.deserialize(await migratedDatabaseImage(), {
        strict: true,
    });
    sqlite.run("PRAGMA foreign_keys = ON");

    try {
        const orm = drizzle({ client: sqlite });
        return { orm, sqlite };
    } catch (error) {
        sqlite.close(true);
        throw error;
    }
}
