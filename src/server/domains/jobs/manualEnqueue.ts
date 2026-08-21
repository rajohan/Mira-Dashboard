import type { JobRunRecord } from "./records.ts";
import type { JobRepositoryReader } from "./repository.ts";

export interface ManualEnqueueReplayInput {
    readonly enqueueSha256: string;
    readonly idempotencyKey: string;
    readonly requestedById: string;
    readonly requestedByKind: JobRunRecord["requestedByKind"];
}

export type ManualEnqueueReplayResult =
    | { readonly kind: "idempotency-mismatch"; readonly run: JobRunRecord }
    | { readonly kind: "new" }
    | { readonly kind: "replayed"; readonly run: JobRunRecord };

/**
 * Resolves caller-scoped replay before any mutable action or schedule lookup.
 * The repository enqueue path repeats this check inside its write transaction.
 * @param repository Repository reader used for the caller-scoped lookup.
 * @param input Caller identity, idempotency key, and canonical enqueue digest.
 * @returns Whether the request is new, a matching replay, or a conflicting replay.
 */
export function preflightManualEnqueue(
    repository: Pick<JobRepositoryReader, "findRunByIdempotency">,
    input: ManualEnqueueReplayInput
): ManualEnqueueReplayResult {
    const run = repository.findRunByIdempotency(
        input.requestedByKind,
        input.requestedById,
        input.idempotencyKey
    );
    if (run === undefined) return { kind: "new" };
    return run.enqueueSha256 === input.enqueueSha256
        ? { kind: "replayed", run }
        : { kind: "idempotency-mismatch", run };
}
