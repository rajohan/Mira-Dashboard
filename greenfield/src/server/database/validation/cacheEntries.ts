import { compareAsc } from "date-fns";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    cacheConsecutiveFailuresSchema,
    cacheEntryKeySchema,
    cacheEntryMetadataSchema,
    cacheEntryPayloadSchema,
    cacheEntrySchemaIdSchema,
    cacheEntrySourceSchema,
    cacheFailureCodeSchema,
    cacheFailureMessageSchema,
    cacheLastAttemptDurationSchema,
    cacheLastAttemptNumberSchema,
    cacheLastAttemptStatusSchema,
} from "../../../contracts/cache.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { cacheEntries } from "../schema/cacheEntries.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

function cacheJsonTextSchema(
    objectSchema: typeof cacheEntryPayloadSchema | typeof cacheEntryMetadataSchema,
    message: string
) {
    return v.pipe(
        v.string(message),
        v.check(
            (value) => v.safeParse(objectSchema, parseJsonText(value)).success,
            message
        )
    );
}

const payloadJsonSchema = cacheJsonTextSchema(
    cacheEntryPayloadSchema,
    "Stored cache payload is invalid"
);
const metadataJsonSchema = cacheJsonTextSchema(
    cacheEntryMetadataSchema,
    "Stored cache metadata is invalid"
);

const cacheEntryRefinements = {
    consecutiveFailures: () => cacheConsecutiveFailuresSchema,
    expiresAt: nonnegativeDateSchema,
    failureCode: () => cacheFailureCodeSchema,
    failureMessage: () => cacheFailureMessageSchema,
    key: () => cacheEntryKeySchema,
    lastAttemptAt: nonnegativeDateSchema,
    lastAttemptDurationMs: () => cacheLastAttemptDurationSchema,
    lastAttemptNumber: () => cacheLastAttemptNumberSchema,
    lastAttemptRunId: uuidV7TextSchema,
    lastAttemptStatus: () => cacheLastAttemptStatusSchema,
    lastSuccessAt: nonnegativeDateSchema,
    metadataJson: () => metadataJsonSchema,
    payloadJson: () => payloadJsonSchema,
    schemaId: () => cacheEntrySchemaIdSchema,
    source: () => cacheEntrySourceSchema,
    updatedAt: nonnegativeDateSchema,
};

interface CacheEntryRowLike {
    readonly consecutiveFailures: number;
    readonly expiresAt?: Date | null;
    readonly failureCode?: string | null;
    readonly failureMessage?: string | null;
    readonly lastAttemptAt: Date;
    readonly lastAttemptStatus: "failed" | "succeeded";
    readonly lastSuccessAt?: Date | null;
    readonly metadataJson?: string | null;
    readonly payloadJson?: string | null;
    readonly schemaId?: string | null;
    readonly source?: string | null;
    readonly updatedAt: Date;
}

/**
 * @param row Candidate cache persistence row.
 * @returns Whether last-known-good projection, attempt result, and time fields agree.
 */
export function cacheEntryRowIsConsistent(row: CacheEntryRowLike): boolean {
    const successFields = [
        row.expiresAt,
        row.lastSuccessAt,
        row.metadataJson,
        row.payloadJson,
        row.schemaId,
        row.source,
    ];
    const hasProjection = successFields.every((value) => value != null);
    if (!hasProjection && !successFields.every((value) => value == null)) return false;
    if (compareAsc(row.updatedAt, row.lastAttemptAt) < 0) return false;
    if (
        hasProjection &&
        (row.lastSuccessAt == null ||
            row.expiresAt == null ||
            compareAsc(row.lastSuccessAt, row.lastAttemptAt) > 0 ||
            compareAsc(row.expiresAt, row.lastSuccessAt) <= 0)
    ) {
        return false;
    }
    if (row.lastAttemptStatus === "succeeded") {
        return (
            hasProjection &&
            row.lastSuccessAt?.getTime() === row.lastAttemptAt.getTime() &&
            row.consecutiveFailures === 0 &&
            row.failureCode == null &&
            row.failureMessage == null
        );
    }
    return (
        row.consecutiveFailures > 0 &&
        row.failureCode != null &&
        row.failureMessage != null
    );
}

const generatedCacheEntrySelectSchema = createSelectSchema(
    cacheEntries,
    cacheEntryRefinements
);
const cacheEntryConsistencyMessage = "Stored cache entry is inconsistent";

/** Validates complete cache rows read from SQLite. */
export const cacheEntrySelectSchema = v.pipe(
    v.strictObject(generatedCacheEntrySelectSchema.entries),
    v.check<
        v.InferOutput<typeof generatedCacheEntrySelectSchema>,
        typeof cacheEntryConsistencyMessage
    >(cacheEntryRowIsConsistent, cacheEntryConsistencyMessage)
);

const generatedCacheEntryInsertSchema = createInsertSchema(
    cacheEntries,
    cacheEntryRefinements
);

/** Validates a complete first refresh attempt before inserting a cache row. */
export const cacheEntryInsertSchema = v.pipe(
    v.strictObject(generatedCacheEntryInsertSchema.entries),
    v.check<
        v.InferOutput<typeof generatedCacheEntryInsertSchema>,
        typeof cacheEntryConsistencyMessage
    >(cacheEntryRowIsConsistent, cacheEntryConsistencyMessage)
);
