import { Database } from "bun:sqlite";

import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { Context, Effect, Layer, Result } from "effect";

import {
    type DatabaseRuntimeAcquisitionError,
    DatabaseRuntimeCheckpointError,
    DatabaseRuntimeCloseError,
    DatabaseRuntimePathError,
    DatabaseRuntimeStartupError,
} from "./databaseErrors.ts";
import {
    assertDatabasePathStillValid,
    dashboardDatabaseFileName,
    prepareDatabasePath,
    readDatabasePathDiagnostics,
    type PreparedDatabasePath,
} from "./databasePath.ts";
import {
    checkpointDatabasePassive,
    checkpointDatabaseTruncate,
    type DatabaseCheckpointDiagnostics,
    retryDatabaseWriteOperation,
} from "./databasePolicy.ts";
import {
    initializeDatabaseCandidateMigration,
    initializeDatabaseRuntime,
    loadDatabaseRuntimeMigrations,
    normalizeDatabaseRuntimeOptions,
    type DatabaseRuntimeLayerOptions,
    type DatabaseStartupDiagnostics,
    type NormalizedDatabaseRuntimeOptions,
} from "./databaseStartup.ts";

export * from "./databaseErrors.ts";
export {
    databaseRuntimePolicy,
    type DatabaseCheckpointDiagnostics,
    type DatabaseConnectionDiagnostics,
} from "./databasePolicy.ts";
export type {
    DatabaseRuntimeLayerOptions,
    DatabaseRuntimeStartupMode,
} from "./databaseStartup.ts";

export type RuntimeOwnedDatabase = SQLiteBunDatabase & { readonly $client: Database };

/** Delivery-only inputs for migrating one isolated copied database candidate. */
export type DatabaseCandidateMigrationLayerOptions = Readonly<
    Omit<DatabaseRuntimeLayerOptions, "startupMode">
>;

export interface DatabaseRuntimeDiagnostics extends DatabaseStartupDiagnostics {
    readonly databaseFileName: typeof dashboardDatabaseFileName;
}

/** Live, path-free SQLite storage diagnostics read from the retained runtime. */
export interface DatabaseRuntimeSqliteDiagnostics {
    readonly databaseBytes: number;
    readonly freeBytes: number;
    readonly freePages: number;
    readonly freePercent: number;
    readonly pageCount: number;
    readonly pageSizeBytes: number;
    readonly permissions: {
        readonly dataDirectory: string;
        readonly database: string;
        readonly secure: true;
        readonly shm?: string;
        readonly wal?: string;
    };
    readonly shmBytes: number;
    readonly storageBytes: number;
    readonly walBytes: number;
}

/** Startup policy plus one live, sanitized SQLite storage observation. */
export interface DatabaseRuntimeObservation extends DatabaseRuntimeDiagnostics {
    readonly sqlite: DatabaseRuntimeSqliteDiagnostics;
}

interface DatabaseRuntimeServiceShape {
    readonly checkpointPassive: Effect.Effect<
        DatabaseCheckpointDiagnostics,
        DatabaseRuntimeCheckpointError
    >;
    readonly diagnostics: DatabaseRuntimeDiagnostics;
    readonly observeDiagnostics: Effect.Effect<
        DatabaseRuntimeObservation,
        DatabaseRuntimePathError | DatabaseRuntimeStartupError
    >;
    readonly orm: RuntimeOwnedDatabase;
    readonly runImmediateWrite: <A>(
        operation: (markTransactionStarted: () => void) => A
    ) => Effect.Effect<A, unknown>;
}

/** Process-scoped, migration-verified SQLite and Drizzle ownership boundary. */
export class DatabaseRuntimeService extends Context.Service<
    DatabaseRuntimeService,
    DatabaseRuntimeServiceShape
>()("mira-dashboard/server/database/runtime/DatabaseRuntimeService") {}

function emptyDatabaseFailure(): DatabaseRuntimeStartupError {
    return new DatabaseRuntimeStartupError({
        message: "Database validation requires an initialized database",
        reason: "database-empty",
    });
}

function prepareRuntimeDatabasePath(
    options: NormalizedDatabaseRuntimeOptions,
    createIfMissing = options.startupMode === "initialize-empty"
): Effect.Effect<
    PreparedDatabasePath,
    DatabaseRuntimePathError | DatabaseRuntimeStartupError
> {
    return Effect.tryPromise({
        catch: (error) =>
            error instanceof DatabaseRuntimePathError
                ? error
                : new DatabaseRuntimePathError({
                      message: "Database path validation failed",
                      reason: "database-file-invalid",
                  }),
        try: () => prepareDatabasePath(options.stateDirectory, createIfMissing),
    }).pipe(
        Effect.flatMap((prepared) =>
            prepared === undefined
                ? Effect.fail(emptyDatabaseFailure())
                : Effect.succeed(prepared)
        )
    );
}

function openRuntimeDatabase(
    prepared: PreparedDatabasePath
): Effect.Effect<Database, DatabaseRuntimeStartupError> {
    return Effect.try({
        catch: () =>
            new DatabaseRuntimeStartupError({
                message: "Database could not be opened",
                reason: "database-open-failed",
            }),
        try: () => {
            const database = new Database(prepared.filePath, {
                create: false,
                readwrite: true,
                strict: true,
            });
            if (database.filename !== prepared.filePath) {
                database.close(true);
                throw new Error("Database filename changed during open");
            }
            return database;
        },
    });
}

function verifyOpenDatabasePath(
    prepared: PreparedDatabasePath
): Effect.Effect<void, DatabaseRuntimePathError> {
    return Effect.tryPromise({
        catch: (error) =>
            error instanceof DatabaseRuntimePathError
                ? error
                : new DatabaseRuntimePathError({
                      message: "Database file identity validation failed",
                      reason: "database-file-invalid",
                  }),
        try: () => assertDatabasePathStillValid(prepared),
    });
}

function closeRuntimeDatabase(
    database: Database
): Effect.Effect<void, DatabaseRuntimeCloseError> {
    return Effect.try({
        catch: () =>
            new DatabaseRuntimeCloseError({
                message: "Database native handle failed to close",
            }),
        try: () => database.close(true),
    });
}

function releaseRuntimeDatabase(
    database: Database,
    checkpointBeforeClose: boolean
): Effect.Effect<void> {
    if (!checkpointBeforeClose) {
        // Preserve the sanitized acquisition failure. A strict-close double fault
        // cannot be recovered in-process and must not replace its initiating cause.
        return closeRuntimeDatabase(database).pipe(Effect.ignore);
    }

    return Effect.gen(function* () {
        const checkpointResult = yield* Effect.result(
            checkpointDatabasePassive(database)
        );
        const closeResult = yield* Effect.result(closeRuntimeDatabase(database));

        if (Result.isFailure(closeResult)) {
            return yield* Effect.die(closeResult.failure);
        }
        if (Result.isFailure(checkpointResult)) {
            return yield* Effect.die(checkpointResult.failure);
        }
    });
}

function releaseCandidateDatabase(
    database: Database,
    checkpointBeforeClose: boolean
): Effect.Effect<void> {
    if (!checkpointBeforeClose) return closeRuntimeDatabase(database).pipe(Effect.ignore);

    return Effect.gen(function* () {
        const checkpointResult = yield* Effect.result(
            checkpointDatabaseTruncate(database)
        );
        const closeResult = yield* Effect.result(closeRuntimeDatabase(database));

        if (Result.isFailure(closeResult)) return yield* Effect.die(closeResult.failure);
        if (Result.isFailure(checkpointResult)) {
            return yield* Effect.die(checkpointResult.failure);
        }
    });
}

const sqliteObservationPragmas = Object.freeze([
    "freelist_count",
    "page_count",
    "page_size",
] as const);

type SqliteObservationPragma = (typeof sqliteObservationPragmas)[number];

function readSqlitePragmaInteger(
    database: Database,
    pragma: SqliteObservationPragma
): number {
    const row: unknown = database.query(`PRAGMA ${pragma}`).get();
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new TypeError("SQLite observation row is invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(row, pragma);
    const value: unknown =
        descriptor !== undefined && "value" in descriptor
            ? (descriptor.value as unknown)
            : undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("SQLite observation value is invalid");
    }
    return value;
}

function safeIntegerProduct(left: number, right: number): number {
    const value = left * right;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("SQLite observation size is outside its budget");
    }
    return value;
}

function safeIntegerSum(values: readonly number[]): number {
    const value = values.reduce((total, current) => total + current, 0);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("SQLite observation size is outside its budget");
    }
    return value;
}

function observeDatabaseRuntime(
    database: Database,
    prepared: PreparedDatabasePath,
    diagnostics: DatabaseRuntimeDiagnostics
): Effect.Effect<
    DatabaseRuntimeObservation,
    DatabaseRuntimePathError | DatabaseRuntimeStartupError
> {
    return Effect.tryPromise({
        catch: (error) =>
            error instanceof DatabaseRuntimePathError
                ? error
                : new DatabaseRuntimeStartupError({
                      message: "Database observability validation failed",
                      reason: "database-startup-failed",
                  }),
        try: async () => {
            const files = await readDatabasePathDiagnostics(prepared);
            const freePages = readSqlitePragmaInteger(database, "freelist_count");
            const pageCount = readSqlitePragmaInteger(database, "page_count");
            const pageSizeBytes = readSqlitePragmaInteger(database, "page_size");
            if (
                freePages > pageCount ||
                pageSizeBytes < 512 ||
                pageSizeBytes > 65_536 ||
                !Number.isInteger(Math.log2(pageSizeBytes))
            ) {
                throw new RangeError("SQLite page observation is invalid");
            }
            const freeBytes = safeIntegerProduct(freePages, pageSizeBytes);
            const storageBytes = safeIntegerSum([
                files.databaseBytes,
                files.walBytes,
                files.shmBytes,
            ]);
            const freePercent = pageCount === 0 ? 0 : (freePages / pageCount) * 100;
            if (!Number.isFinite(freePercent) || freePercent < 0 || freePercent > 100) {
                throw new RangeError("SQLite free-space observation is invalid");
            }
            // Revalidate fixed identities after both the filesystem and PRAGMA reads.
            await assertDatabasePathStillValid(prepared);

            return Object.freeze({
                ...diagnostics,
                sqlite: Object.freeze({
                    databaseBytes: files.databaseBytes,
                    freeBytes,
                    freePages,
                    freePercent,
                    pageCount,
                    pageSizeBytes,
                    permissions: files.permissions,
                    shmBytes: files.shmBytes,
                    storageBytes,
                    walBytes: files.walBytes,
                }),
            });
        },
    });
}

function acquireDatabaseRuntime(unverifiedOptions: DatabaseRuntimeLayerOptions) {
    return Effect.gen(function* () {
        const options = yield* Effect.try({
            catch: (error) =>
                error instanceof DatabaseRuntimeStartupError
                    ? error
                    : new DatabaseRuntimeStartupError({
                          message: "Database runtime options are invalid",
                          reason: "options-invalid",
                      }),
            try: () => normalizeDatabaseRuntimeOptions(unverifiedOptions),
        });
        const migrations = yield* loadDatabaseRuntimeMigrations(
            options.migrationsDirectory
        );
        const prepared = yield* prepareRuntimeDatabasePath(options);
        let checkpointOnRelease = false;
        const database = yield* Effect.acquireRelease(
            openRuntimeDatabase(prepared),
            (openedDatabase) =>
                releaseRuntimeDatabase(openedDatabase, checkpointOnRelease)
        );
        yield* verifyOpenDatabasePath(prepared);
        const startup = yield* initializeDatabaseRuntime(database, migrations, options);
        yield* verifyOpenDatabasePath(prepared);

        const orm = drizzle({ client: database });
        const diagnostics: DatabaseRuntimeDiagnostics = Object.freeze({
            ...startup,
            databaseFileName: dashboardDatabaseFileName,
        });
        const service = Object.freeze({
            checkpointPassive: checkpointDatabasePassive(database),
            diagnostics,
            observeDiagnostics: observeDatabaseRuntime(database, prepared, diagnostics),
            orm,
            runImmediateWrite: retryDatabaseWriteOperation,
        });
        checkpointOnRelease = true;
        return service;
    });
}

/**
 * Creates one memoized database layer for the composition root's existing ManagedRuntime.
 * Layer scope owns passive checkpoint and strict native-handle closure.
 * @param options Explicit state, migration, release, and startup-mode inputs.
 * @returns Scoped database service layer for the process runtime.
 */
export function databaseRuntimeLayer(
    options: DatabaseRuntimeLayerOptions
): Layer.Layer<DatabaseRuntimeService, DatabaseRuntimeAcquisitionError> {
    return Layer.effect(DatabaseRuntimeService, acquireDatabaseRuntime(options));
}

function acquireDatabaseCandidateMigration(
    candidate: DatabaseCandidateMigrationLayerOptions
) {
    return Effect.gen(function* () {
        const options = yield* Effect.try({
            catch: (error) =>
                error instanceof DatabaseRuntimeStartupError
                    ? error
                    : new DatabaseRuntimeStartupError({
                          message: "Database candidate options are invalid",
                          reason: "options-invalid",
                      }),
            try: () =>
                normalizeDatabaseRuntimeOptions({
                    ...candidate,
                    startupMode: "initialize-empty",
                }),
        });
        const migrations = yield* loadDatabaseRuntimeMigrations(
            options.migrationsDirectory
        );
        const prepared = yield* prepareRuntimeDatabasePath(options, true);
        let checkpointOnRelease = false;
        const database = yield* Effect.acquireRelease(
            openRuntimeDatabase(prepared),
            (openedDatabase) =>
                releaseCandidateDatabase(openedDatabase, checkpointOnRelease)
        );
        yield* verifyOpenDatabasePath(prepared);
        yield* initializeDatabaseCandidateMigration(
            database,
            migrations,
            options.releaseId
        );
        yield* verifyOpenDatabasePath(prepared);
        checkpointOnRelease = true;
    });
}

/**
 * Creates a scoped delivery-only layer that migrates an isolated database candidate.
 * It intentionally provides no ORM service to the caller.
 * @param options Exact candidate state, migration graph, and release identity.
 * @returns Scoped no-service candidate migration layer.
 */
export function databaseCandidateMigrationLayer(
    options: DatabaseCandidateMigrationLayerOptions
): Layer.Layer<never, DatabaseRuntimeAcquisitionError> {
    return Layer.effectDiscard(acquireDatabaseCandidateMigration(options));
}
