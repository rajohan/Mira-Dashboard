import { Data } from "effect";

import type { DatabaseRuntimeWriteUnavailableError } from "../../database/runtime/databaseErrors.ts";

export class CacheNotFoundError extends Data.TaggedError("CacheNotFoundError")<{
    readonly key: string;
}> {}

export class CacheConflictError extends Data.TaggedError("CacheConflictError")<{
    readonly key: string;
    readonly reason: "action-unavailable" | "idempotency-mismatch" | "run-already-active";
}> {}

export type CacheOperationError =
    | CacheConflictError
    | CacheNotFoundError
    | DatabaseRuntimeWriteUnavailableError;
