import { readdir, readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";

import { migrationManifest, type MigrationManifestEntry } from "./manifest.ts";

const migrationIdPattern = /^\d{14}_[a-z\d][a-z\d_-]*$/u;
const sha256Pattern = /^[a-f\d]{64}$/u;

export interface VerifiedMigration extends MigrationManifestEntry {
    folderMillis: number;
    statements: readonly string[];
}

export interface VerifyMigrationOptions {
    directory: string;
    manifest?: readonly MigrationManifestEntry[];
}

function sha256(content: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function assertManifestShape(manifest: readonly MigrationManifestEntry[]): void {
    const ids = manifest.map((entry) => entry.id);
    const sortedIds = ids.toSorted();

    if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !migrationIdPattern.test(id))
    ) {
        throw new Error(
            "Migration manifest contains an invalid or duplicate folder name"
        );
    }
    if (ids.some((id, index) => id !== sortedIds[index])) {
        throw new Error("Migration manifest is not in runtime application order");
    }
    if (
        manifest.some(
            (entry) =>
                !sha256Pattern.test(entry.migrationSha256) ||
                !sha256Pattern.test(entry.snapshotSha256)
        )
    ) {
        throw new Error("Migration manifest contains an invalid SHA-256 checksum");
    }
}

/**
 * Loads the Drizzle graph only after every tracked file matches the reviewed manifest.
 * @param options Migration directory and optional manifest override for isolated tests.
 * @returns Ordered, checksum-verified SQL statements ready for the migration runner.
 */
export async function loadVerifiedMigrations(
    options: VerifyMigrationOptions
): Promise<readonly VerifiedMigration[]> {
    const manifest = options.manifest ?? migrationManifest;
    assertManifestShape(manifest);

    const directoryEntries = await readdir(options.directory, { withFileTypes: true });
    const migrationDirectories = directoryEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
    const manifestIds = manifest.map((entry) => entry.id);

    if (migrationDirectories.join("\n") !== manifestIds.join("\n")) {
        throw new Error("Migration directory does not match the reviewed manifest");
    }

    const drizzleMigrations = readMigrationFiles({
        migrationsFolder: options.directory,
    });
    const drizzleByName = new Map(
        drizzleMigrations.map((migration) => [migration.name, migration])
    );

    return Promise.all(
        manifest.map(async (entry) => {
            const migration = drizzleByName.get(entry.id);

            if (!migration || migration.hash !== entry.migrationSha256) {
                throw new Error(`Migration SQL checksum mismatch: ${entry.id}`);
            }

            const snapshot = await readFile(
                `${options.directory}/${entry.id}/snapshot.json`
            );
            if (sha256(snapshot) !== entry.snapshotSha256) {
                throw new Error(`Migration snapshot checksum mismatch: ${entry.id}`);
            }

            return Object.freeze({
                ...entry,
                folderMillis: migration.folderMillis,
                statements: Object.freeze(migration.sql),
            });
        })
    );
}
