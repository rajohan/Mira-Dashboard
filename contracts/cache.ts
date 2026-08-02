import * as v from "valibot";

import { jobDisableIntentSchema } from "./jobs/scheduled";
import {
    jobExecutionStatusSchema,
    jobExecutionTriggerTypeSchema,
    jobResourceClassSchema,
} from "./jobs/shared";
import type { ContractParser } from "./runtime";
import {
    finiteNumberSchema,
    jsonObjectSchema,
    nonNegativeIntegerSchema,
    parseContract,
    successLiteralSchema,
} from "./runtime";
import { TASK_ASSIGNEE_IDS } from "./tasks";

export const CACHE_STATUSES = ["error", "fresh", "stale"] as const;
export const cacheStatusSchema = v.picklist(CACHE_STATUSES);

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const nonBlankStringSchema = v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank")
);

export function createCacheEnvelopeSchema<
    const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(dataSchema: TSchema) {
    return v.strictObject({
        consecutiveFailures: nonNegativeIntegerSchema,
        data: dataSchema,
        errorCode: v.nullable(nonBlankStringSchema),
        errorMessage: v.nullable(nonBlankStringSchema),
        expiresAt: v.nullable(v.string()),
        key: trimmedNonEmptyStringSchema,
        lastAttemptAt: v.nullable(v.string()),
        meta: jsonObjectSchema,
        source: trimmedNonEmptyStringSchema,
        status: cacheStatusSchema,
        updatedAt: v.nullable(v.string()),
    });
}

const unknownCacheEnvelopeSchema = createCacheEnvelopeSchema(v.unknown());

export const cacheHeartbeatCronJobSchema = v.strictObject({
    disableIntent: v.optional(jobDisableIntentSchema),
    enabled: v.optional(v.boolean()),
    id: trimmedNonEmptyStringSchema,
    lastDurationMs: v.optional(finiteNumberSchema),
    lastRunAtMs: v.optional(finiteNumberSchema),
    lastRunStatus: v.optional(trimmedNonEmptyStringSchema),
    name: v.optional(trimmedNonEmptyStringSchema),
    nextRunAtMs: v.optional(finiteNumberSchema),
    runningAtMs: v.optional(finiteNumberSchema),
});

const cacheHeartbeatLastRunSchema = v.strictObject({
    finishedAt: v.optional(trimmedNonEmptyStringSchema),
    message: v.optional(v.string()),
    startedAt: trimmedNonEmptyStringSchema,
    status: jobExecutionStatusSchema,
    triggerType: jobExecutionTriggerTypeSchema,
});

export const cacheHeartbeatDashboardJobSchema = v.strictObject({
    actionKey: trimmedNonEmptyStringSchema,
    disableIntent: v.optional(jobDisableIntentSchema),
    enabled: v.boolean(),
    id: trimmedNonEmptyStringSchema,
    isQueued: v.boolean(),
    isRunning: v.boolean(),
    lastRun: v.optional(cacheHeartbeatLastRunSchema),
    name: trimmedNonEmptyStringSchema,
    nextRunAt: v.optional(trimmedNonEmptyStringSchema),
    resourceClass: jobResourceClassSchema,
});

export const cacheHeartbeatTaskSchema = v.strictObject({
    assignee: v.optional(v.picklist(TASK_ASSIGNEE_IDS)),
    automation: v.optional(
        v.strictObject({
            cronJobId: trimmedNonEmptyStringSchema,
            missing: v.optional(v.boolean()),
            recurring: v.boolean(),
        })
    ),
    number: nonNegativeIntegerSchema,
    priority: v.picklist(["high", "low", "medium"]),
    status: v.picklist(["blocked", "done", "in-progress", "todo"]),
    title: trimmedNonEmptyStringSchema,
});

export const cacheHeartbeatResponseSchema = v.strictObject({
    count: nonNegativeIntegerSchema,
    cronJobs: v.strictObject({
        dataAvailable: v.boolean(),
        error: v.optional(nonBlankStringSchema),
        items: v.array(cacheHeartbeatCronJobSchema),
    }),
    dashboardJobs: v.array(cacheHeartbeatDashboardJobSchema),
    entries: v.array(unknownCacheEnvelopeSchema),
    generatedAt: trimmedNonEmptyStringSchema,
    schemaVersion: v.literal(3),
    tasks: v.array(cacheHeartbeatTaskSchema),
});

export const cacheStatusResponseSchema = v.strictObject({
    count: nonNegativeIntegerSchema,
    entries: v.array(createCacheEnvelopeSchema(v.null())),
    generatedAt: trimmedNonEmptyStringSchema,
});

const unknownCacheRefreshResponseSchema = v.strictObject({
    entry: unknownCacheEnvelopeSchema,
    isOk: successLiteralSchema,
});

export type CacheStatus = v.InferOutput<typeof cacheStatusSchema>;

export interface CacheEnvelope<T> {
    consecutiveFailures: number;
    data: T;
    errorCode: string | null;
    errorMessage: string | null;
    expiresAt: string | null;
    key: string;
    lastAttemptAt: string | null;
    meta: Record<string, unknown>;
    source: string;
    status: CacheStatus;
    updatedAt: string | null;
}

export type CacheHeartbeatCronJob = v.InferOutput<typeof cacheHeartbeatCronJobSchema>;
export type CacheHeartbeatDashboardJob = v.InferOutput<
    typeof cacheHeartbeatDashboardJobSchema
>;
export type CacheHeartbeatTask = v.InferOutput<typeof cacheHeartbeatTaskSchema>;
export type CacheHeartbeatResponse = v.InferOutput<typeof cacheHeartbeatResponseSchema>;
export type CacheStatusResponse = v.InferOutput<typeof cacheStatusResponseSchema>;

export interface CacheRefreshResponse<T> {
    entry: CacheEnvelope<T>;
    isOk: true;
}

/**
 * Parses one cache envelope while delegating its domain payload contract.
 * @param value Value to process.
 * @param parseData Parse data value.
 * @param path File or resource path.
 * @returns Parsed one cache envelope while delegating its domain payload contract.
 */
export function parseCacheEnvelope<T>(
    value: unknown,
    parseData: ContractParser<T>,
    path = "cacheEntry"
): CacheEnvelope<T> {
    const envelope = parseContract(unknownCacheEnvelopeSchema, value, path);
    return {
        ...envelope,
        data: parseData(envelope.data),
    };
}

export function cacheEnvelopeParser<T>(
    parseData: ContractParser<T>,
    path = "cacheEntry"
): ContractParser<CacheEnvelope<T>> {
    return (value) => parseCacheEnvelope(value, parseData, path);
}

/**
 * Parses the compact heartbeat cache projection.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the compact heartbeat cache projection.
 */
export function parseCacheHeartbeatResponse(
    value: unknown,
    path = "cacheHeartbeat"
): CacheHeartbeatResponse {
    return parseContract(cacheHeartbeatResponseSchema, value, path);
}

/**
 * Parses the cache metadata-only status response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the cache metadata-only status response.
 */
export function parseCacheStatusResponse(
    value: unknown,
    path = "cacheStatus"
): CacheStatusResponse {
    return parseContract(cacheStatusResponseSchema, value, path);
}

export function cacheRefreshResponseParser<T>(
    parseData: ContractParser<T>,
    path = "cacheRefresh"
): ContractParser<CacheRefreshResponse<T>> {
    return (value) => {
        const response = parseContract(unknownCacheRefreshResponseSchema, value, path);
        return {
            entry: {
                ...response.entry,
                data: parseData(response.entry.data),
            },
            isOk: true,
        };
    };
}
