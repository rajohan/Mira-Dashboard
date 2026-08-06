import * as v from "valibot";

import { migrationManifest } from "./databaseMigrationManifest.ts";
import {
    fullCommitShaSchema,
    lowercaseSha256Schema,
    lowercaseUuidV7Schema,
    positiveSafeIntegerSchema,
} from "./validation.ts";

const invalidSnapshotManifest = "Database snapshot manifest is invalid";
const maximumSnapshotMigrations = 64;
const migrationIdentitySchema = v.strictObject({
    checksum: lowercaseSha256Schema(invalidSnapshotManifest),
    id: v.pipe(
        v.string(invalidSnapshotManifest),
        v.maxLength(128, invalidSnapshotManifest)
    ),
});

/** Strict durable identity stored beside one verified production database snapshot. */
export const databaseSnapshotManifestSchema = v.strictObject({
    formatVersion: v.literal(1, invalidSnapshotManifest),
    transitionId: lowercaseUuidV7Schema(invalidSnapshotManifest),
    releaseId: fullCommitShaSchema(invalidSnapshotManifest),
    database: v.strictObject({
        bytes: positiveSafeIntegerSchema(invalidSnapshotManifest),
        sha256: lowercaseSha256Schema(invalidSnapshotManifest),
    }),
    migrations: v.pipe(
        v.array(migrationIdentitySchema),
        v.minLength(1, invalidSnapshotManifest),
        v.maxLength(maximumSnapshotMigrations, invalidSnapshotManifest),
        v.readonly()
    ),
});

export type DatabaseSnapshotManifest = v.InferOutput<
    typeof databaseSnapshotManifestSchema
>;

/**
 * Returns the canonical migration identity embedded in snapshots from this release.
 * @returns Frozen ordered migration identities.
 */
export function currentDatabaseSnapshotMigrations() {
    return Object.freeze(
        migrationManifest.map((migration) =>
            Object.freeze({
                checksum: migration.migrationSha256,
                id: migration.id,
            })
        )
    );
}

/**
 * Parses and freezes one untrusted snapshot manifest.
 * @param input Unknown manifest boundary value.
 * @returns Validated immutable snapshot identity.
 */
export function parseDatabaseSnapshotManifest(input: unknown): DatabaseSnapshotManifest {
    const parsed = v.safeParse(databaseSnapshotManifestSchema, input, {
        abortEarly: true,
    });
    if (!parsed.success) throw new TypeError(invalidSnapshotManifest);
    Object.freeze(parsed.output.database);
    for (const migration of parsed.output.migrations) Object.freeze(migration);
    Object.freeze(parsed.output.migrations);
    return Object.freeze(parsed.output);
}

/**
 * Serializes one validated snapshot manifest canonically with one final newline.
 * @param input Parsed or untrusted manifest boundary value.
 * @returns Canonical JSON snapshot manifest.
 */
export function serializeDatabaseSnapshotManifest(input: unknown): string {
    return `${JSON.stringify(parseDatabaseSnapshotManifest(input), null, 2)}\n`;
}
