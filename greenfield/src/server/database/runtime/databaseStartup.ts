import type { Database } from "bun:sqlite";

import { Effect } from "effect";
import * as v from "valibot";

import {
    fullCommitShaSchema,
    lowercaseSha256Schema,
} from "../../../shared/validation.ts";
import { applyVerifiedMigrations } from "../migrations/applyVerifiedMigrations.ts";
import {
    loadVerifiedMigrations,
    type VerifiedMigration,
} from "../migrations/loadVerifiedMigrations.ts";
import { migrationIdSchema } from "../migrations/validation.ts";
import { assertDatabaseIntegrity } from "../migrations/verifyDatabaseIntegrity.ts";
import {
    DatabaseRuntimeSnapshotRequiredError,
    DatabaseRuntimeStartupError,
} from "./databaseErrors.ts";
import {
    configureDatabaseConnection,
    retryDatabaseStartupOperation,
    type DatabaseConnectionDiagnostics,
} from "./databasePolicy.ts";

export type DatabaseRuntimeStartupMode = "initialize-empty" | "validate-only";

export interface DatabaseRuntimeLayerOptions {
    readonly migrationsDirectory: string;
    readonly releaseId: string;
    readonly startupMode: DatabaseRuntimeStartupMode;
    readonly stateDirectory: string;
}

export type NormalizedDatabaseRuntimeOptions = Readonly<DatabaseRuntimeLayerOptions>;

export interface DatabaseStartupDiagnostics {
    readonly appliedMigrations: number;
    readonly connection: DatabaseConnectionDiagnostics;
    readonly migrationCount: number;
    readonly startupMode: DatabaseRuntimeStartupMode;
}

const startupModeSchema = v.picklist(
    ["initialize-empty", "validate-only"] as const,
    "Database startup mode is invalid"
);
const absolutePathSchema = v.pipe(
    v.string("Database runtime path must be a string"),
    v.maxLength(4096, "Database runtime path is too long"),
    v.check(
        (value) => value.startsWith("/") && !value.includes("\0"),
        "Database runtime path must be absolute and NUL-free"
    )
);
const runtimeOptionsSchema = v.pipe(
    v.strictObject({
        migrationsDirectory: absolutePathSchema,
        releaseId: fullCommitShaSchema("Database release identity is invalid"),
        startupMode: startupModeSchema,
        stateDirectory: absolutePathSchema,
    }),
    v.readonly()
);
const migrationHistoryRowSchema = v.strictObject({
    checksum: lowercaseSha256Schema("Database migration history is invalid"),
    id: migrationIdSchema("Database migration history is invalid"),
});
const migrationHistoryRowsSchema = v.array(migrationHistoryRowSchema);
const schemaObjectRowSchema = v.strictObject({ name: v.string(), type: v.string() });
const schemaObjectRowsSchema = v.array(schemaObjectRowSchema);

type MigrationHistoryRow = v.InferOutput<typeof migrationHistoryRowSchema>;

function invalidOptions(): DatabaseRuntimeStartupError {
    return new DatabaseRuntimeStartupError({
        message: "Database runtime options are invalid",
        reason: "options-invalid",
    });
}

function invalidHistory(): DatabaseRuntimeStartupError {
    return new DatabaseRuntimeStartupError({
        message: "Database history does not match the reviewed migration graph",
        reason: "database-history-invalid",
    });
}

function emptyDatabase(): DatabaseRuntimeStartupError {
    return new DatabaseRuntimeStartupError({
        message: "Database validation requires an initialized database",
        reason: "database-empty",
    });
}

/**
 * Validates external composition inputs before any filesystem mutation.
 * @param options Untrusted runtime composition options.
 * @returns Immutable validated runtime options.
 */
export function normalizeDatabaseRuntimeOptions(
    options: DatabaseRuntimeLayerOptions
): NormalizedDatabaseRuntimeOptions {
    const validation = v.safeParse(runtimeOptionsSchema, options, { abortEarly: true });
    if (!validation.success) throw invalidOptions();
    return validation.output;
}

/**
 * Loads the reviewed migration graph before the database write boundary is opened.
 * @param migrationsDirectory Canonical release-owned migration directory.
 * @returns Checksum-verified migration artifacts.
 */
export function loadDatabaseRuntimeMigrations(
    migrationsDirectory: string
): Effect.Effect<readonly VerifiedMigration[], DatabaseRuntimeStartupError> {
    return Effect.tryPromise({
        catch: () =>
            new DatabaseRuntimeStartupError({
                message: "Database migration artifacts failed verification",
                reason: "artifact-invalid",
            }),
        try: () => loadVerifiedMigrations({ directory: migrationsDirectory }),
    });
}

function readSchemaObjects(
    database: Database
): readonly { name: string; type: string }[] {
    const rows: unknown = database
        .query(`
            SELECT name, type
            FROM sqlite_schema
            WHERE name NOT GLOB 'sqlite_*'
            ORDER BY type, name
        `)
        .all();
    const validation = v.safeParse(schemaObjectRowsSchema, rows, { abortEarly: true });
    if (!validation.success) throw invalidHistory();
    return validation.output;
}

function readMigrationHistory(database: Database): readonly MigrationHistoryRow[] {
    const rows: unknown = database
        .query(`
            SELECT checksum, id
            FROM schema_migrations
            ORDER BY id
        `)
        .all();
    const validation = v.safeParse(migrationHistoryRowsSchema, rows, {
        abortEarly: true,
    });
    if (!validation.success) throw invalidHistory();
    return validation.output;
}

function isReviewedPrefix(
    history: readonly MigrationHistoryRow[],
    migrations: readonly VerifiedMigration[]
): boolean {
    return history.every((applied, index) => {
        const expected = migrations[index];
        return (
            expected !== undefined &&
            applied.id === expected.id &&
            applied.checksum === expected.migrationSha256
        );
    });
}

function inspectMigrationState(
    database: Database,
    migrations: readonly VerifiedMigration[]
): "current" | "empty" | "pending" {
    const schemaObjects = readSchemaObjects(database);
    if (schemaObjects.length === 0) return "empty";
    if (
        !schemaObjects.some(
            (object) => object.type === "table" && object.name === "schema_migrations"
        )
    ) {
        throw invalidHistory();
    }

    const history = readMigrationHistory(database);
    if (
        history.length === 0 ||
        history.length > migrations.length ||
        !isReviewedPrefix(history, migrations)
    ) {
        throw invalidHistory();
    }
    return history.length === migrations.length ? "current" : "pending";
}

function startOrValidateDatabase(
    database: Database,
    migrations: readonly VerifiedMigration[],
    options: NormalizedDatabaseRuntimeOptions
): DatabaseStartupDiagnostics {
    const connection = configureDatabaseConnection(database);
    let state = inspectMigrationState(database, migrations);

    if (state === "empty" && options.startupMode === "validate-only") {
        const recheck = database.transaction(() =>
            inspectMigrationState(database, migrations)
        );
        state = recheck.immediate();
        if (state === "empty") throw emptyDatabase();
    }
    if (state === "pending") {
        assertDatabaseIntegrity(database);
        throw new DatabaseRuntimeSnapshotRequiredError({
            message: "Database migration requires a verified release snapshot",
        });
    }

    const appliedMigrations = applyVerifiedMigrations(database, migrations, {
        releaseId: options.releaseId,
    });
    if (state === "current" && appliedMigrations !== 0) throw invalidHistory();
    if (
        state === "empty" &&
        appliedMigrations !== 0 &&
        appliedMigrations !== migrations.length
    ) {
        throw invalidHistory();
    }

    return Object.freeze({
        appliedMigrations,
        connection,
        migrationCount: migrations.length,
        startupMode: options.startupMode,
    });
}

/**
 * Initializes an empty file or validates an already-current reviewed database.
 * @param database Retained process-owned native connection.
 * @param migrations Checksum-verified canonical migration graph.
 * @param options Validated startup policy and release identity.
 * @returns Immutable startup and connection diagnostics.
 */
export function initializeDatabaseRuntime(
    database: Database,
    migrations: readonly VerifiedMigration[],
    options: NormalizedDatabaseRuntimeOptions
) {
    return retryDatabaseStartupOperation(() =>
        startOrValidateDatabase(database, migrations, options)
    );
}
