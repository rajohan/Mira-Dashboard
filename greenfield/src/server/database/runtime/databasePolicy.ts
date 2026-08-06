import type { Database } from "bun:sqlite";

import { Data, Duration, Effect, Predicate, Schedule } from "effect";
import * as v from "valibot";

import {
    DatabaseRuntimeCheckpointError,
    DatabaseRuntimeLockTimeoutError,
    DatabaseRuntimePathError,
    DatabaseRuntimeSnapshotRequiredError,
    DatabaseRuntimeStartupError,
} from "./databaseErrors.ts";

export const databaseRuntimePolicy = Object.freeze({
    busyTimeoutMs: 0,
    migrationLockRetryBaseDelayMs: 10,
    migrationLockRetryMaximumDelayMs: 250,
    migrationLockTimeoutMs: 5000,
    synchronousLevel: 2,
    walAutoCheckpointPages: 1000,
});

export interface DatabaseConnectionDiagnostics {
    readonly busyTimeoutMs: number;
    readonly checksEnforced: true;
    readonly foreignKeysEnabled: true;
    readonly journalMode: "wal";
    readonly synchronousLevel: 2;
    readonly trustedSchemaEnabled: false;
    readonly walAutoCheckpointPages: number;
}

export interface DatabaseCheckpointDiagnostics {
    readonly busy: number;
    readonly checkpointedFrames: number;
    readonly logFrames: number;
}

class DatabaseRuntimeBusyError extends Data.TaggedError("DatabaseRuntimeBusyError")<{
    readonly message: string;
}> {}

const integerSchema = v.pipe(v.number(), v.safeInteger());
const nonnegativeIntegerSchema = v.pipe(integerSchema, v.minValue(0));
const foreignKeysRowSchema = v.strictObject({ foreign_keys: nonnegativeIntegerSchema });
const ignoredChecksRowSchema = v.strictObject({
    ignore_check_constraints: nonnegativeIntegerSchema,
});
const journalModeRowSchema = v.strictObject({ journal_mode: v.string() });
const synchronousRowSchema = v.strictObject({ synchronous: nonnegativeIntegerSchema });
const busyTimeoutRowSchema = v.strictObject({ timeout: nonnegativeIntegerSchema });
const walAutoCheckpointRowSchema = v.strictObject({
    wal_autocheckpoint: nonnegativeIntegerSchema,
});
const trustedSchemaRowSchema = v.strictObject({
    trusted_schema: nonnegativeIntegerSchema,
});
const checkpointRowSchema = v.strictObject({
    busy: v.pipe(nonnegativeIntegerSchema, v.maxValue(1)),
    checkpointed: integerSchema,
    log: integerSchema,
});

function ownDataProperty(value: object, property: string): unknown {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        return descriptor !== undefined && "value" in descriptor
            ? descriptor.value
            : undefined;
    } catch {
        return undefined;
    }
}

function sqliteErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const code = ownDataProperty(error, "code");
    return typeof code === "string" && code.startsWith("SQLITE_") ? code : undefined;
}

function isBusyOrLockedCode(code: string | undefined): boolean {
    return (
        code === "SQLITE_BUSY" ||
        code?.startsWith("SQLITE_BUSY_") === true ||
        code === "SQLITE_LOCKED" ||
        code?.startsWith("SQLITE_LOCKED_") === true
    );
}

function invalidDatabasePolicy(): DatabaseRuntimeStartupError {
    return new DatabaseRuntimeStartupError({
        message: "Database connection policy validation failed",
        reason: "database-policy-invalid",
    });
}

function parsePolicyRow<
    TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, row: unknown): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, row, { abortEarly: true });
    if (!result.success) throw invalidDatabasePolicy();
    return result.output;
}

function readConnectionDiagnostics(database: Database): DatabaseConnectionDiagnostics {
    const foreignKeys = parsePolicyRow(
        foreignKeysRowSchema,
        database.query("PRAGMA foreign_keys").get()
    );
    const ignoredChecks = parsePolicyRow(
        ignoredChecksRowSchema,
        database.query("PRAGMA ignore_check_constraints").get()
    );
    const journalMode = parsePolicyRow(
        journalModeRowSchema,
        database.query("PRAGMA journal_mode").get()
    );
    const synchronous = parsePolicyRow(
        synchronousRowSchema,
        database.query("PRAGMA synchronous").get()
    );
    const busyTimeout = parsePolicyRow(
        busyTimeoutRowSchema,
        database.query("PRAGMA busy_timeout").get()
    );
    const walAutoCheckpoint = parsePolicyRow(
        walAutoCheckpointRowSchema,
        database.query("PRAGMA wal_autocheckpoint").get()
    );
    const trustedSchema = parsePolicyRow(
        trustedSchemaRowSchema,
        database.query("PRAGMA trusted_schema").get()
    );

    if (
        foreignKeys.foreign_keys !== 1 ||
        ignoredChecks.ignore_check_constraints !== 0 ||
        journalMode.journal_mode.toLowerCase() !== "wal" ||
        synchronous.synchronous !== databaseRuntimePolicy.synchronousLevel ||
        busyTimeout.timeout !== databaseRuntimePolicy.busyTimeoutMs ||
        walAutoCheckpoint.wal_autocheckpoint !==
            databaseRuntimePolicy.walAutoCheckpointPages ||
        trustedSchema.trusted_schema !== 0
    ) {
        throw invalidDatabasePolicy();
    }

    return Object.freeze({
        busyTimeoutMs: busyTimeout.timeout,
        checksEnforced: true,
        foreignKeysEnabled: true,
        journalMode: "wal",
        synchronousLevel: 2,
        trustedSchemaEnabled: false,
        walAutoCheckpointPages: walAutoCheckpoint.wal_autocheckpoint,
    });
}

/**
 * Applies and then verifies the fixed, security-first production connection policy.
 * @param database Retained process-owned native connection.
 * @returns Immutable verified connection diagnostics.
 */
export function configureDatabaseConnection(
    database: Database
): DatabaseConnectionDiagnostics {
    database.run("PRAGMA busy_timeout = 0");
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA ignore_check_constraints = OFF");
    database.run("PRAGMA trusted_schema = OFF");
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = FULL");
    database.run("PRAGMA wal_autocheckpoint = 1000");
    return readConnectionDiagnostics(database);
}

const isBusyError = Predicate.isTagged("DatabaseRuntimeBusyError");

function busyRetrySchedule(): Schedule.Schedule<Duration.Duration> {
    const baseDelay = Duration.millis(
        databaseRuntimePolicy.migrationLockRetryBaseDelayMs
    );
    return Schedule.exponential(baseDelay).pipe(
        Schedule.modifyDelay(({ duration }) => {
            const delayMs = Math.min(
                Duration.toMillis(duration),
                databaseRuntimePolicy.migrationLockRetryMaximumDelayMs
            );
            return Effect.succeed(Duration.millis(delayMs));
        }),
        Schedule.while(({ input }) => isBusyError(input))
    );
}

function classifyStartupFailure(
    error: unknown
): DatabaseRuntimeBusyError | DatabaseRuntimeStartupError {
    if (error instanceof DatabaseRuntimeStartupError) return error;
    if (isBusyOrLockedCode(sqliteErrorCode(error))) {
        return new DatabaseRuntimeBusyError({
            message: "Database startup is waiting for migration admission",
        });
    }
    return new DatabaseRuntimeStartupError({
        message: "Database startup validation failed",
        reason: "database-startup-failed",
    });
}

/**
 * Runs synchronous startup work with Effect-owned retry, cancellation and deadline.
 * A synchronous SQLite transaction is never interrupted mid-callback.
 * @param operation One synchronous and idempotent database startup attempt.
 * @returns The operation result or a sanitized operational failure.
 */
export function retryDatabaseStartupOperation<A>(
    operation: () => A
): Effect.Effect<
    A,
    | DatabaseRuntimeLockTimeoutError
    | DatabaseRuntimePathError
    | DatabaseRuntimeSnapshotRequiredError
    | DatabaseRuntimeStartupError
> {
    const attempt: Effect.Effect<
        A,
        | DatabaseRuntimeBusyError
        | DatabaseRuntimePathError
        | DatabaseRuntimeSnapshotRequiredError
        | DatabaseRuntimeStartupError
    > = Effect.suspend<
        A,
        | DatabaseRuntimeBusyError
        | DatabaseRuntimePathError
        | DatabaseRuntimeSnapshotRequiredError
        | DatabaseRuntimeStartupError,
        never
    >(() => {
        try {
            return Effect.succeed(operation());
        } catch (error) {
            if (
                error instanceof DatabaseRuntimePathError ||
                error instanceof DatabaseRuntimeSnapshotRequiredError
            ) {
                return Effect.fail(error);
            }
            return Effect.fail(classifyStartupFailure(error));
        }
    });

    return attempt.pipe(
        Effect.retry({ schedule: busyRetrySchedule() }),
        Effect.timeoutOrElse({
            duration: databaseRuntimePolicy.migrationLockTimeoutMs,
            orElse: () =>
                Effect.fail(
                    new DatabaseRuntimeLockTimeoutError({
                        message: "Database migration admission timed out",
                        timeoutMs: databaseRuntimePolicy.migrationLockTimeoutMs,
                    })
                ),
        }),
        Effect.catchTag("DatabaseRuntimeBusyError", () =>
            Effect.fail(
                new DatabaseRuntimeLockTimeoutError({
                    message: "Database migration admission timed out",
                    timeoutMs: databaseRuntimePolicy.migrationLockTimeoutMs,
                })
            )
        )
    );
}

/**
 * Runs one non-blocking passive checkpoint and validates its bounded diagnostics.
 * @param database Retained process-owned native connection.
 * @returns Validated WAL checkpoint counters.
 */
export function checkpointDatabasePassive(
    database: Database
): Effect.Effect<DatabaseCheckpointDiagnostics, DatabaseRuntimeCheckpointError> {
    return Effect.try({
        catch: () =>
            new DatabaseRuntimeCheckpointError({
                message: "Database passive checkpoint failed",
            }),
        try: () => {
            const row = parsePolicyRow(
                checkpointRowSchema,
                database.query("PRAGMA wal_checkpoint(PASSIVE)").get()
            );
            if (row.log < 0 || row.checkpointed < 0 || row.checkpointed > row.log) {
                throw new Error("Invalid checkpoint diagnostics");
            }
            return Object.freeze({
                busy: row.busy,
                checkpointedFrames: row.checkpointed,
                logFrames: row.log,
            });
        },
    });
}
