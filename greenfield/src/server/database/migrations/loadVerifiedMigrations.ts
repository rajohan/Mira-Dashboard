import { readdir, readFile } from "node:fs/promises";

import * as v from "valibot";

import { lowercaseSha256Schema } from "../../../shared/validation.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { migrationManifest, type MigrationManifestEntry } from "./manifest.ts";
import { migrationIdSchema } from "./validation.ts";

export const drizzleStatementBreakpoint = "--> statement-breakpoint";

const invalidManifestFolderError =
    "Migration manifest contains an invalid or duplicate folder name";
const invalidManifestChecksumError =
    "Migration manifest contains an invalid SHA-256 checksum";
const migrationDirectoryMismatchError =
    "Migration directory does not match the reviewed manifest";
const manifestMigrationIdSchema = migrationIdSchema(invalidManifestFolderError);
const unverifiedMigrationManifestEntrySchema = v.strictObject(
    {
        id: v.optional(v.unknown()),
        migrationSha256: v.optional(v.unknown()),
        snapshotSha256: v.optional(v.unknown()),
    },
    invalidManifestFolderError
);
const unverifiedMigrationManifestSchema = v.array(
    unverifiedMigrationManifestEntrySchema,
    invalidManifestFolderError
);
const manifestChecksumSchema = lowercaseSha256Schema(invalidManifestChecksumError);
const migrationDirectoryNamesSchema = v.array(
    migrationIdSchema(migrationDirectoryMismatchError),
    migrationDirectoryMismatchError
);

export interface VerifiedMigration extends MigrationManifestEntry {
    statements: readonly string[];
}

export interface VerifyMigrationOptions {
    directory: string;
    manifest?: unknown;
}

function parseAndAssertManifest(
    unverifiedManifest: unknown
): readonly MigrationManifestEntry[] {
    const validation = v.safeParse(
        unverifiedMigrationManifestSchema,
        unverifiedManifest,
        {
            abortEarly: true,
        }
    );
    if (!validation.success) {
        throw new Error(validation.issues[0]?.message ?? invalidManifestFolderError);
    }
    const manifestWithValidatedIds = validation.output.map((entry) => {
        const idValidation = v.safeParse(manifestMigrationIdSchema, entry.id, {
            abortEarly: true,
        });
        if (!idValidation.success) {
            throw new Error(invalidManifestFolderError);
        }
        return { ...entry, id: idValidation.output };
    });
    const ids = manifestWithValidatedIds.map((entry) => entry.id);
    const sortedIds = ids.toSorted();

    if (new Set(ids).size !== ids.length) {
        throw new Error(invalidManifestFolderError);
    }
    if (ids.some((id, index) => id !== sortedIds[index])) {
        throw new Error("Migration manifest is not in runtime application order");
    }

    return manifestWithValidatedIds.map((entry) => {
        const migrationChecksum = v.safeParse(
            manifestChecksumSchema,
            entry.migrationSha256,
            { abortEarly: true }
        );
        const snapshotChecksum = v.safeParse(
            manifestChecksumSchema,
            entry.snapshotSha256,
            { abortEarly: true }
        );
        if (!migrationChecksum.success || !snapshotChecksum.success) {
            throw new Error(invalidManifestChecksumError);
        }
        return {
            id: entry.id,
            migrationSha256: migrationChecksum.output,
            snapshotSha256: snapshotChecksum.output,
        };
    });
}

/**
 * Loads the Drizzle graph only after every tracked file matches the reviewed manifest.
 * @param options Migration directory and optional manifest override for isolated tests.
 * @returns Ordered, checksum-verified SQL statements ready for the migration runner.
 */
export async function loadVerifiedMigrations(
    options: VerifyMigrationOptions
): Promise<readonly VerifiedMigration[]> {
    const manifest = parseAndAssertManifest(options.manifest ?? migrationManifest);

    const directoryEntries = await readdir(options.directory, { withFileTypes: true });
    const directoryValidation = v.safeParse(
        migrationDirectoryNamesSchema,
        directoryEntries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
        { abortEarly: true }
    );
    if (!directoryValidation.success) {
        throw new Error(migrationDirectoryMismatchError);
    }
    const migrationDirectories = directoryValidation.output.toSorted();
    const manifestIds = manifest.map((entry) => entry.id);

    if (migrationDirectories.join("\n") !== manifestIds.join("\n")) {
        throw new Error(migrationDirectoryMismatchError);
    }

    const verifiedMigrations: VerifiedMigration[] = [];
    for (const entry of manifest) {
        const migrationDirectory = `${options.directory}/${entry.id}`;
        const [migrationSql, snapshot] = await Promise.all([
            readFile(`${migrationDirectory}/migration.sql`),
            readFile(`${migrationDirectory}/snapshot.json`),
        ]);

        if (sha256Hex(migrationSql) !== entry.migrationSha256) {
            throw new Error(`Migration SQL checksum mismatch: ${entry.id}`);
        }

        if (sha256Hex(snapshot) !== entry.snapshotSha256) {
            throw new Error(`Migration snapshot checksum mismatch: ${entry.id}`);
        }

        const statements = Object.freeze(
            migrationSql.toString().split(drizzleStatementBreakpoint)
        );
        const verifiedMigration = Object.freeze({ ...entry, statements });
        verifiedMigrations.push(verifiedMigration);
    }

    return Object.freeze(verifiedMigrations);
}
