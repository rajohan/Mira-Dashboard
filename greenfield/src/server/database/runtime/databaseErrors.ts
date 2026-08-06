import { Schema } from "effect";

export type DatabaseRuntimePathFailureReason =
    | "database-file-invalid"
    | "state-directory-invalid";

export type DatabaseRuntimeStartupFailureReason =
    | "artifact-invalid"
    | "database-empty"
    | "database-history-invalid"
    | "database-open-failed"
    | "database-policy-invalid"
    | "database-startup-failed"
    | "options-invalid";

/** Expected failure when the retained database path violates its private-file policy. */
export class DatabaseRuntimePathError extends Schema.TaggedErrorClass<DatabaseRuntimePathError>(
    "mira-dashboard/server/database/runtime/DatabaseRuntimePathError"
)("DatabaseRuntimePathError", {
    message: Schema.String,
    reason: Schema.Literals([
        "database-file-invalid",
        "state-directory-invalid",
    ] satisfies readonly DatabaseRuntimePathFailureReason[]),
}) {}

/** Expected, redacted startup failure that is safe to cross the runtime boundary. */
export class DatabaseRuntimeStartupError extends Schema.TaggedErrorClass<DatabaseRuntimeStartupError>(
    "mira-dashboard/server/database/runtime/DatabaseRuntimeStartupError"
)("DatabaseRuntimeStartupError", {
    message: Schema.String,
    reason: Schema.Literals([
        "artifact-invalid",
        "database-empty",
        "database-history-invalid",
        "database-open-failed",
        "database-policy-invalid",
        "database-startup-failed",
        "options-invalid",
    ] satisfies readonly DatabaseRuntimeStartupFailureReason[]),
}) {}

/** Expected startup failure while another process owns SQLite migration admission. */
export class DatabaseRuntimeLockTimeoutError extends Schema.TaggedErrorClass<DatabaseRuntimeLockTimeoutError>(
    "mira-dashboard/server/database/runtime/DatabaseRuntimeLockTimeoutError"
)("DatabaseRuntimeLockTimeoutError", {
    message: Schema.String,
    timeoutMs: Schema.Number,
}) {}

/** Expected write failure after bounded asynchronous SQLite admission retry. */
export class DatabaseRuntimeWriteAdmissionTimeoutError extends Schema.TaggedErrorClass<DatabaseRuntimeWriteAdmissionTimeoutError>(
    "mira-dashboard/server/database/runtime/DatabaseRuntimeWriteAdmissionTimeoutError"
)("DatabaseRuntimeWriteAdmissionTimeoutError", {
    message: Schema.String,
    timeoutMs: Schema.Number,
}) {}

/** Expected non-replayed contention after an immediate transaction was admitted. */
export class DatabaseRuntimeWriteContentionError extends Schema.TaggedErrorClass<DatabaseRuntimeWriteContentionError>(
    "mira-dashboard/server/database/runtime/DatabaseRuntimeWriteContentionError"
)("DatabaseRuntimeWriteContentionError", {
    message: Schema.String,
}) {}

/** Fail-closed signal that a published database needs a verified release snapshot. */
export class DatabaseRuntimeSnapshotRequiredError extends Schema.TaggedErrorClass<DatabaseRuntimeSnapshotRequiredError>(
    "mira-dashboard/server/database/runtime/DatabaseRuntimeSnapshotRequiredError"
)("DatabaseRuntimeSnapshotRequiredError", {
    message: Schema.String,
}) {}

/** Sanitized failure from a process-owned passive WAL checkpoint. */
export class DatabaseRuntimeCheckpointError extends Schema.TaggedErrorClass<DatabaseRuntimeCheckpointError>(
    "mira-dashboard/server/database/runtime/DatabaseRuntimeCheckpointError"
)("DatabaseRuntimeCheckpointError", {
    message: Schema.String,
}) {}

/** Sanitized failure while closing the process-owned native SQLite handle. */
export class DatabaseRuntimeCloseError extends Schema.TaggedErrorClass<DatabaseRuntimeCloseError>(
    "mira-dashboard/server/database/runtime/DatabaseRuntimeCloseError"
)("DatabaseRuntimeCloseError", {
    message: Schema.String,
}) {}

export type DatabaseRuntimeAcquisitionError =
    | DatabaseRuntimeLockTimeoutError
    | DatabaseRuntimePathError
    | DatabaseRuntimeSnapshotRequiredError
    | DatabaseRuntimeStartupError;

const databaseRuntimeErrorSchema = Schema.Union([
    DatabaseRuntimeCheckpointError,
    DatabaseRuntimeCloseError,
    DatabaseRuntimeLockTimeoutError,
    DatabaseRuntimePathError,
    DatabaseRuntimeSnapshotRequiredError,
    DatabaseRuntimeStartupError,
    DatabaseRuntimeWriteAdmissionTimeoutError,
    DatabaseRuntimeWriteContentionError,
]);

/** Runtime guard for failures crossing the database layer boundary. */
export const isDatabaseRuntimeError = Schema.is(databaseRuntimeErrorSchema);

export type DatabaseRuntimeError =
    | DatabaseRuntimeAcquisitionError
    | DatabaseRuntimeCheckpointError
    | DatabaseRuntimeCloseError
    | DatabaseRuntimeWriteAdmissionTimeoutError
    | DatabaseRuntimeWriteContentionError;

export type DatabaseRuntimeWriteUnavailableError =
    | DatabaseRuntimeWriteAdmissionTimeoutError
    | DatabaseRuntimeWriteContentionError;

/**
 * Runtime guard for temporary write-contention failures safe to map to HTTP 503.
 * @param error Unknown failure crossing the database boundary.
 * @returns Whether the failure represents bounded write unavailability.
 */
export function isDatabaseRuntimeWriteUnavailableError(
    error: unknown
): error is DatabaseRuntimeWriteUnavailableError {
    return (
        error instanceof DatabaseRuntimeWriteAdmissionTimeoutError ||
        error instanceof DatabaseRuntimeWriteContentionError
    );
}
