import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import { jsonObjectSchema, type JsonObject } from "../shared/json.ts";
import {
    boundedControlSafeTextSchema,
    compareStrings,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import {
    jobIdempotencyKeySchema,
    jobRunIdSchema,
    jobRunSummarySchema,
} from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";
import { emptyInputSchema } from "./system.ts";

/** Hard cache-status row budget for one complete status response. */
export const cacheStatusMaximumEntries = 128;
/** Maximum encoded last-known-good provider payload retained in one cache row. */
export const cacheEntryPayloadMaximumBytes = 256 * 1024;
/** Maximum encoded provider metadata retained beside one cache payload. */
export const cacheEntryMetadataMaximumBytes = 16 * 1024;

export const cacheEntryKeyMaximumLength = 128;
export const cacheFailureMessageMaximumLength = 2000;
export const cacheLastAttemptNumberMaximum = 10;

function canonicalCacheKeySchema(message: string) {
    return v.pipe(
        v.string(message),
        v.minLength(1, message),
        v.maxLength(cacheEntryKeyMaximumLength, message),
        v.regex(/^[a-z0-9][a-z0-9._-]*$/u, message)
    );
}

/** @returns Whether one cache payload fits its reviewed serialized byte budget. */
export function cacheEntryPayloadFitsBudget(value: JsonObject): boolean {
    return utf8ByteLength(JSON.stringify(value)) <= cacheEntryPayloadMaximumBytes;
}

/** @returns Whether one cache metadata object fits its reviewed serialized byte budget. */
export function cacheEntryMetadataFitsBudget(value: JsonObject): boolean {
    return utf8ByteLength(JSON.stringify(value)) <= cacheEntryMetadataMaximumBytes;
}

/** Canonical provider-owned cache entry identity. */
export const cacheEntryKeySchema = canonicalCacheKeySchema("Cache entry key is invalid");

/** Canonical versioned schema identity attached to one last-known-good payload. */
export const cacheEntrySchemaIdSchema = canonicalCacheKeySchema(
    "Cache entry schema id is invalid"
);

/** Bounded provider source label attached to one last-known-good payload. */
export const cacheEntrySourceSchema = boundedControlSafeTextSchema(
    128,
    "Cache entry source is invalid"
);

/** Bounded structured last-known-good provider payload. */
export const cacheEntryPayloadSchema = v.pipe(
    jsonObjectSchema,
    v.check(cacheEntryPayloadFitsBudget, "Cache entry payload is outside its budget")
);

/** Bounded structured metadata retained with one provider payload. */
export const cacheEntryMetadataSchema = v.pipe(
    jsonObjectSchema,
    v.check(cacheEntryMetadataFitsBudget, "Cache entry metadata is outside its budget")
);

const systemHostByteCountSchema = nonnegativeSafeIntegerSchema(
    "System host byte count is invalid"
);
const systemHostCapacityEntries = {
    freeBytes: systemHostByteCountSchema,
    totalBytes: systemHostByteCountSchema,
};
/** @returns Whether free capacity does not exceed total capacity. */
export function systemHostCapacityIsConsistent<
    T extends { readonly freeBytes: number; readonly totalBytes: number },
>(value: T): boolean {
    return value.freeBytes <= value.totalBytes;
}

const systemHostCapacitySchema = v.pipe(
    v.strictObject(systemHostCapacityEntries),
    v.check(
        systemHostCapacityIsConsistent,
        "System host free bytes cannot exceed total bytes"
    )
);
const systemHostIdentitySchema = boundedControlSafeTextSchema(
    255,
    "System host identity is invalid"
);

/** Strict first-party payload projected by the worker-only system.host provider. */
export const systemHostCachePayloadSchema = v.strictObject({
    architecture: systemHostIdentitySchema,
    disk: v.pipe(
        v.strictObject({
            ...systemHostCapacityEntries,
            path: v.literal("/"),
        }),
        v.check(
            systemHostCapacityIsConsistent,
            "System host free bytes cannot exceed total bytes"
        )
    ),
    hostname: systemHostIdentitySchema,
    memory: systemHostCapacitySchema,
    platform: systemHostIdentitySchema,
    release: systemHostIdentitySchema,
    uptimeSeconds: nonnegativeSafeIntegerSchema("System host uptime is invalid"),
});

/** Persisted outcome of the most recent refresh attempt. */
export const cacheLastAttemptStatuses = ["failed", "succeeded"] as const;
export const cacheLastAttemptStatusSchema = v.picklist(
    cacheLastAttemptStatuses,
    "Cache last-attempt status is invalid"
);

/** Client-facing freshness derived separately from persisted attempt outcome. */
export const cacheFreshnessStates = ["fresh", "missing", "stale"] as const;
export const cacheFreshnessSchema = v.picklist(
    cacheFreshnessStates,
    "Cache freshness is invalid"
);

/** Canonical provider failure code safe for logs, filters, and persistence. */
export const cacheFailureCodeSchema = v.pipe(
    v.string("Cache failure code is invalid"),
    v.minLength(1, "Cache failure code is invalid"),
    v.maxLength(128, "Cache failure code is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._/-]*$/u, "Cache failure code is invalid")
);

/** Redacted operator-facing failure summary; stack traces do not cross this boundary. */
export const cacheFailureMessageSchema = boundedControlSafeTextSchema(
    cacheFailureMessageMaximumLength,
    "Cache failure message is invalid"
);

/** One-based durable job attempt that produced the latest cache attempt. */
export const cacheLastAttemptNumberSchema = v.pipe(
    positiveSafeIntegerSchema("Cache attempt number is invalid"),
    v.maxValue(cacheLastAttemptNumberMaximum, "Cache attempt number is invalid")
);

/** Nonnegative monotonic execution duration for the latest cache attempt. */
export const cacheLastAttemptDurationSchema = nonnegativeSafeIntegerSchema(
    "Cache attempt duration is invalid"
);

/** Consecutive failed refreshes since the last successful attempt. */
export const cacheConsecutiveFailuresSchema = nonnegativeSafeIntegerSchema(
    "Cache consecutive failure count is invalid"
);

const cacheTimestampSchema = timestampMillisecondsSchema("Cache timestamp is invalid");

const cacheSuccessProjectionEntries = {
    expiresAtMs: v.optional(cacheTimestampSchema),
    lastSuccessAtMs: v.optional(cacheTimestampSchema),
    metadata: v.optional(cacheEntryMetadataSchema),
    schemaId: v.optional(cacheEntrySchemaIdSchema),
    source: v.optional(cacheEntrySourceSchema),
};

const cacheAttemptEntries = {
    consecutiveFailures: cacheConsecutiveFailuresSchema,
    failureCode: v.optional(cacheFailureCodeSchema),
    failureMessage: v.optional(cacheFailureMessageSchema),
    lastAttemptAtMs: cacheTimestampSchema,
    lastAttemptDurationMs: cacheLastAttemptDurationSchema,
    lastAttemptNumber: cacheLastAttemptNumberSchema,
    lastAttemptRunId: jobRunIdSchema,
    lastAttemptStatus: cacheLastAttemptStatusSchema,
    updatedAtMs: cacheTimestampSchema,
};

const cachePublicProjectionEntries = {
    freshness: cacheFreshnessSchema,
    key: cacheEntryKeySchema,
    manualRunAvailable: v.boolean("Cache manual-run availability is invalid"),
};

const cacheEntryObjectSchema = v.strictObject({
    ...cacheAttemptEntries,
    ...cachePublicProjectionEntries,
    ...cacheSuccessProjectionEntries,
    payload: v.optional(cacheEntryPayloadSchema),
});

export type CacheEntry = v.InferOutput<typeof cacheEntryObjectSchema>;

function successProjectionIsComplete(entry: CacheEntry): boolean {
    const successFields = [
        entry.expiresAtMs,
        entry.lastSuccessAtMs,
        entry.metadata,
        entry.payload,
        entry.schemaId,
        entry.source,
    ];
    return (
        successFields.every((value) => value === undefined) ||
        successFields.every((value) => value !== undefined)
    );
}

/**
 * Checks public cache-state invariants without conflating refresh outcome and freshness.
 * @param entry Cache entry returned to a client.
 * @returns Whether last-known-good, failure, and timing fields agree.
 */
export function cacheEntryIsConsistent(entry: CacheEntry): boolean {
    if (
        !successProjectionIsComplete(entry) ||
        entry.updatedAtMs < entry.lastAttemptAtMs
    ) {
        return false;
    }

    const hasProjection = entry.payload !== undefined;
    if ((entry.freshness === "missing") !== !hasProjection) return false;
    if (
        hasProjection &&
        (entry.lastSuccessAtMs === undefined ||
            entry.expiresAtMs === undefined ||
            entry.expiresAtMs <= entry.lastSuccessAtMs ||
            entry.lastSuccessAtMs > entry.lastAttemptAtMs)
    ) {
        return false;
    }

    if (entry.lastAttemptStatus === "succeeded") {
        return (
            hasProjection &&
            entry.lastSuccessAtMs === entry.lastAttemptAtMs &&
            entry.failureCode === undefined &&
            entry.failureMessage === undefined &&
            entry.consecutiveFailures === 0
        );
    }
    return (
        entry.failureCode !== undefined &&
        entry.failureMessage !== undefined &&
        entry.consecutiveFailures > 0
    );
}

/** Complete public cache row with bounded last-known-good payload and derived freshness. */
export const cacheEntrySchema = v.pipe(
    cacheEntryObjectSchema,
    v.check(cacheEntryIsConsistent, "Cache entry is inconsistent")
);

const cacheEntryStatusObjectSchema = v.strictObject({
    ...cacheAttemptEntries,
    ...cachePublicProjectionEntries,
    ...cacheSuccessProjectionEntries,
});

export type CacheEntryStatus = v.InferOutput<typeof cacheEntryStatusObjectSchema>;

/**
 * Reuses complete-entry invariants for one payload-free status row.
 * @param status Cache status row returned to a client.
 * @returns Whether its projection, failure, and timing fields agree.
 */
export function cacheEntryStatusIsConsistent(status: CacheEntryStatus): boolean {
    const hasProjection = status.lastSuccessAtMs !== undefined;
    const syntheticPayload: JsonObject | undefined = hasProjection ? {} : undefined;
    return cacheEntryIsConsistent({ ...status, payload: syntheticPayload });
}

/** Payload-free cache row used by bounded status inventories. */
export const cacheEntryStatusSchema = v.pipe(
    cacheEntryStatusObjectSchema,
    v.check(cacheEntryStatusIsConsistent, "Cache entry status is inconsistent")
);

/** Exact cache-entry lookup request. */
export const getCacheEntryInputSchema = v.strictObject({ key: cacheEntryKeySchema });

/** Lost-response-safe request to enqueue one manual cache refresh. */
export const refreshCacheEntryInputSchema = v.strictObject({
    idempotencyKey: jobIdempotencyKeySchema,
    key: cacheEntryKeySchema,
});

/**
 * @param entries Cache status rows to validate.
 * @returns Whether cache status rows use strict canonical key order.
 */
export function cacheStatusEntriesAreCanonical(entries: CacheEntryStatus[]): boolean {
    return entries.every((entry, index) => {
        const previous = entries[index - 1];
        return previous === undefined || compareStrings(previous.key, entry.key) < 0;
    });
}

const cacheStatusEntriesSchema = v.pipe(
    v.array(cacheEntryStatusSchema, "Cache status entries are invalid"),
    v.maxLength(cacheStatusMaximumEntries, "Cache status is outside its row budget"),
    v.check(
        cacheStatusEntriesAreCanonical,
        "Cache status entries are not in canonical key order"
    )
);

const cacheStatusResultObjectSchema = v.strictObject({
    entries: cacheStatusEntriesSchema,
    generatedAtMs: cacheTimestampSchema,
    totalCount: nonnegativeSafeIntegerSchema("Cache total count is invalid"),
    truncated: v.boolean("Cache truncation state is invalid"),
});

export type CacheStatusResult = v.InferOutput<typeof cacheStatusResultObjectSchema>;

/**
 * @param result Bounded cache inventory and exact total count.
 * @returns Whether truncation is explicitly and consistently represented.
 */
export function cacheStatusResultIsConsistent(result: CacheStatusResult): boolean {
    return (
        result.totalCount >= result.entries.length &&
        result.entries.every((entry) => entry.updatedAtMs <= result.generatedAtMs) &&
        result.entries.every((entry) =>
            entry.expiresAtMs === undefined
                ? entry.freshness === "missing"
                : entry.freshness ===
                  (entry.expiresAtMs > result.generatedAtMs ? "fresh" : "stale")
        ) &&
        result.truncated === result.totalCount > result.entries.length
    );
}

/** Complete bounded cache status with an explicit total and truncation marker. */
export const cacheStatusResultSchema = v.pipe(
    cacheStatusResultObjectSchema,
    v.check(cacheStatusResultIsConsistent, "Cache status result is inconsistent")
);

const cacheReadAccess = {
    capabilities: ["cache:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const cacheWriteAccess = {
    capabilities: ["cache:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const cacheQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const cacheMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;

/** Cache projection lookup, bounded status, and durable refresh contracts. */
export const cacheProcedureContracts = [
    {
        access: cacheReadAccess,
        domain: "cache",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: getCacheEntryInputSchema,
        inputSchemaId: "cache.getEntry.input",
        kind: "query",
        name: "cache.getEntry",
        output: cacheEntrySchema,
        outputSchemaId: "cache.getEntry.output",
        summary: "Loads one cache projection with last-known-good data and freshness.",
        transport: cacheQueryTransport,
    },
    {
        access: cacheReadAccess,
        domain: "cache",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "cache.getStatus.input",
        kind: "query",
        name: "cache.getStatus",
        output: cacheStatusResultSchema,
        outputSchemaId: "cache.getStatus.output",
        summary: "Lists bounded cache freshness and attempt state with an exact total.",
        transport: cacheQueryTransport,
    },
    {
        access: cacheWriteAccess,
        domain: "cache",
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: refreshCacheEntryInputSchema,
        inputSchemaId: "cache.refreshEntry.input",
        kind: "mutation",
        name: "cache.refreshEntry",
        output: jobRunSummarySchema,
        outputSchemaId: "cache.refreshEntry.output",
        summary: "Enqueues one caller-scoped idempotent cache refresh.",
        transport: cacheMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type GetCacheEntryInput = v.InferOutput<typeof getCacheEntryInputSchema>;
export type RefreshCacheEntryInput = v.InferOutput<typeof refreshCacheEntryInputSchema>;
