import { getTime } from "date-fns";
import * as v from "valibot";

import {
    type CacheEntry,
    type CacheEntryStatus,
    cacheEntrySchema,
    cacheEntryStatusSchema,
} from "../../../contracts/cache.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { cacheManualRunAvailable } from "./providerRegistry.ts";
import type { CacheEntryRecord } from "./repository.ts";

function publicFields(record: CacheEntryRecord, nowMs: number) {
    let freshness: CacheEntry["freshness"] = "stale";
    if (record.payloadJson === null) {
        freshness = "missing";
    } else if (record.expiresAt !== null && getTime(record.expiresAt) > nowMs) {
        freshness = "fresh";
    }
    return {
        consecutiveFailures: record.consecutiveFailures,
        ...(record.expiresAt === null ? {} : { expiresAtMs: getTime(record.expiresAt) }),
        ...(record.failureCode === null ? {} : { failureCode: record.failureCode }),
        ...(record.failureMessage === null
            ? {}
            : { failureMessage: record.failureMessage }),
        freshness,
        key: record.key,
        lastAttemptAtMs: getTime(record.lastAttemptAt),
        lastAttemptDurationMs: record.lastAttemptDurationMs,
        lastAttemptNumber: record.lastAttemptNumber,
        lastAttemptRunId: record.lastAttemptRunId,
        lastAttemptStatus: record.lastAttemptStatus,
        ...(record.lastSuccessAt === null
            ? {}
            : { lastSuccessAtMs: getTime(record.lastSuccessAt) }),
        manualRunAvailable: cacheManualRunAvailable(record.key),
        ...(record.metadataJson === null
            ? {}
            : { metadata: parseJsonText(record.metadataJson) }),
        ...(record.schemaId === null ? {} : { schemaId: record.schemaId }),
        ...(record.source === null ? {} : { source: record.source }),
        updatedAtMs: getTime(record.updatedAt),
    } as const;
}

/**
 * Converts one durable row to a full public projection at the supplied read clock.
 * @param record Durable cache row.
 * @param nowMs Read timestamp used to derive freshness.
 * @returns A validated public cache entry.
 */
export function toCacheEntry(record: CacheEntryRecord, nowMs: number): CacheEntry {
    return v.parse(cacheEntrySchema, {
        ...publicFields(record, nowMs),
        ...(record.payloadJson === null
            ? {}
            : { payload: parseJsonText(record.payloadJson) }),
    });
}

/**
 * Converts one durable row to its payload-free status projection.
 * @param record Durable cache row.
 * @param nowMs Read timestamp used to derive freshness.
 * @returns A validated payload-free cache status row.
 */
export function toCacheEntryStatus(
    record: CacheEntryRecord,
    nowMs: number
): CacheEntryStatus {
    return v.parse(cacheEntryStatusSchema, publicFields(record, nowMs));
}
