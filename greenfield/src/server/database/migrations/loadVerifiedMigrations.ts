import * as v from "valibot";

import { lowercaseSha256Schema } from "../../../shared/validation.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { migrationManifest, type MigrationManifestEntry } from "./manifest.ts";
import {
    type MigrationArtifactVerificationTestHooks,
    readStableMigrationArtifactGraph,
} from "./migrationArtifactFilesystem.ts";
import { migrationIdMaximumLength, migrationIdSchema } from "./validation.ts";

export {
    migrationArtifactByteLimits,
    type MigrationArtifactVerificationTestHooks,
    type MigrationArtifactVerificationTestStage,
} from "./migrationArtifactFilesystem.ts";

export const drizzleStatementBreakpoint = "--> statement-breakpoint";

const maximumMigrationCount = 64;
const invalidManifestFolderError =
    "Migration manifest contains an invalid or duplicate folder name";
const invalidManifestChecksumError =
    "Migration manifest contains an invalid SHA-256 checksum";
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

export interface VerifiedMigration extends MigrationManifestEntry {
    statements: readonly string[];
}

export interface VerifyMigrationOptions {
    directory: string;
    manifest?: unknown;
    /**
     * Deterministic mutation boundary for loader security tests.
     * @internal
     */
    testHooks?: MigrationArtifactVerificationTestHooks;
}

function invalidState(message: string): Error {
    return new Error(message);
}

function parseAndAssertManifest(
    unverifiedManifest: unknown
): readonly MigrationManifestEntry[] {
    if (
        !Array.isArray(unverifiedManifest) ||
        unverifiedManifest.length > maximumMigrationCount
    ) {
        throw invalidState(invalidManifestFolderError);
    }
    const validation = v.safeParse(
        unverifiedMigrationManifestSchema,
        unverifiedManifest,
        {
            abortEarly: true,
        }
    );
    if (!validation.success) {
        throw invalidState(validation.issues[0]?.message ?? invalidManifestFolderError);
    }
    const manifestWithValidatedIds = validation.output.map((entry) => {
        if (typeof entry.id !== "string" || entry.id.length > migrationIdMaximumLength) {
            throw invalidState(invalidManifestFolderError);
        }
        const idValidation = v.safeParse(manifestMigrationIdSchema, entry.id, {
            abortEarly: true,
        });
        if (!idValidation.success) {
            throw invalidState(invalidManifestFolderError);
        }
        return { ...entry, id: idValidation.output };
    });
    const ids = manifestWithValidatedIds.map((entry) => entry.id);
    const sortedIds = ids.toSorted();

    if (new Set(ids).size !== ids.length) {
        throw invalidState(invalidManifestFolderError);
    }
    if (ids.some((id, index) => id !== sortedIds[index])) {
        throw invalidState("Migration manifest is not in runtime application order");
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
            throw invalidState(invalidManifestChecksumError);
        }
        return {
            id: entry.id,
            migrationSha256: migrationChecksum.output,
            snapshotSha256: snapshotChecksum.output,
        };
    });
}

function decodeMigrationSql(bytes: Buffer, migrationId: string): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw invalidState(`Migration SQL is not valid UTF-8: ${migrationId}`);
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
    const manifest = parseAndAssertManifest(options.manifest ?? migrationManifest);
    const artifacts = await readStableMigrationArtifactGraph(
        options.directory,
        manifest.map((entry) => entry.id),
        options.testHooks
    );

    const verifiedMigrations = manifest.map((entry, index) => {
        const artifact = artifacts[index];
        if (!artifact) {
            throw invalidState(
                "Migration directory does not match the reviewed manifest"
            );
        }
        if (sha256Hex(artifact.migrationSql) !== entry.migrationSha256) {
            throw invalidState(`Migration SQL checksum mismatch: ${entry.id}`);
        }
        if (sha256Hex(artifact.snapshot) !== entry.snapshotSha256) {
            throw invalidState(`Migration snapshot checksum mismatch: ${entry.id}`);
        }
        const statements = Object.freeze(
            decodeMigrationSql(artifact.migrationSql, entry.id).split(
                drizzleStatementBreakpoint
            )
        );
        return Object.freeze({ ...entry, statements });
    });
    return Object.freeze(verifiedMigrations);
}
