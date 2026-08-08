import { Data } from "effect";

import type { DatabaseRuntimeWriteUnavailableError } from "../../database/runtime/databaseErrors.ts";

export type JobResourceKind = "job-run" | "schedule" | "worker-control";

/** Expected exact-record lookup failure in the durable jobs domain. */
export class JobNotFoundError extends Data.TaggedError("JobNotFoundError")<{
    readonly id: string;
    readonly resource: JobResourceKind;
}> {}

/** Expected optimistic, idempotency, lifecycle, or action-policy conflict. */
export class JobConflictError extends Data.TaggedError("JobConflictError")<{
    readonly id: string;
    readonly reason:
        | "action-not-manually-exposed"
        | "cancellation-not-supported"
        | "idempotency-mismatch"
        | "run-already-active"
        | "state-changed"
        | "version-changed";
    readonly resource: JobResourceKind;
}> {}

/** Expected time-dependent schedule input failure after write admission. */
export class JobValidationError extends Data.TaggedError("JobValidationError")<{
    readonly id: string;
    readonly reason:
        | "disable-intent-expired"
        | "enabled-state-unchanged"
        | "next-occurrence-unavailable"
        | "schedule-unchanged";
    readonly resource: "schedule";
}> {}

export type JobOperationError =
    | DatabaseRuntimeWriteUnavailableError
    | JobConflictError
    | JobNotFoundError
    | JobValidationError;
