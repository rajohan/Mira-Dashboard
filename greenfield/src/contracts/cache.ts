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
    gatewayConnectionFreshnessSchema,
    gatewayConnectionPhaseSchema,
} from "./gatewayConnection.ts";
import { gatewaySessionProjectionMaximum } from "./gatewaySessions.ts";
import {
    jobIdempotencyKeySchema,
    jobRunIdSchema,
    jobRunStateSchema,
    jobRunSummarySchema,
    jobRunTerminalCodeSchema,
    jobTriggerTypeSchema,
    scheduleIdSchema,
} from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";
import { emptyInputSchema } from "./system.ts";
import { taskIdSchema, taskPrioritySchema, taskStatusSchema } from "./taskModel.ts";

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

/** Securely narrowed greenfield heartbeat schema; legacy schema-v3 rows are not mirrored. */
export const cacheHeartbeatSchemaVersion = 2 as const;
/** Hard row budget for the purpose-built heartbeat task projection. */
export const cacheHeartbeatTaskMaximum = 100;
/** Hard release-registry budget for Dashboard schedules exposed in one heartbeat. */
export const cacheHeartbeatDashboardJobMaximum = 32;

interface CacheHeartbeatConnectionState {
    readonly checkedAtMs: number;
    readonly freshness: "fresh" | "stale" | "unavailable";
    readonly phase: "connected" | "connecting" | "degraded" | "stopped" | "stopping";
}

/**
 * @param connection Compact connection state to validate.
 * @returns Whether the compact connection phase and freshness agree.
 */
export function cacheHeartbeatConnectionIsConsistent(
    connection: CacheHeartbeatConnectionState & Record<string, unknown>
): boolean {
    return (connection.freshness === "fresh") === (connection.phase === "connected");
}

function cacheHeartbeatLastKnownGoodTimesAreConsistent(projection: {
    readonly observedAtMs: number;
    readonly staleSinceMs: number;
}): boolean {
    return projection.staleSinceMs >= projection.observedAtMs;
}

const cacheHeartbeatConnectionSchema = v.pipe(
    v.strictObject({
        checkedAtMs: cacheTimestampSchema,
        freshness: gatewayConnectionFreshnessSchema,
        phase: gatewayConnectionPhaseSchema,
    }),
    v.check(
        cacheHeartbeatConnectionIsConsistent,
        "Heartbeat Gateway connection state is inconsistent"
    )
);

const cacheHeartbeatSessionCountSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Heartbeat Gateway session count is invalid"),
    v.maxValue(
        gatewaySessionProjectionMaximum,
        "Heartbeat Gateway session count is outside its budget"
    )
);
const cacheHeartbeatSessionsUnavailableSchema = v.strictObject({
    state: v.literal("unavailable"),
});
const cacheHeartbeatSessionsFreshSchema = v.strictObject({
    count: cacheHeartbeatSessionCountSchema,
    observedAtMs: cacheTimestampSchema,
    state: v.literal("fresh"),
    truncated: v.boolean("Heartbeat Gateway session truncation is invalid"),
});
interface CacheHeartbeatSessionsLastKnownGood {
    readonly count: number;
    readonly observedAtMs: number;
    readonly staleSinceMs: number;
    readonly state: "last-known-good";
    readonly truncated: boolean;
}

/**
 * @param projection Last-known-good session summary to validate.
 * @returns Whether session-projection staleness follows its observation.
 */
export function cacheHeartbeatSessionsLastKnownGoodIsConsistent(
    projection: CacheHeartbeatSessionsLastKnownGood & Record<string, unknown>
): boolean {
    return cacheHeartbeatLastKnownGoodTimesAreConsistent(projection);
}

const cacheHeartbeatSessionsLastKnownGoodSchema = v.pipe(
    v.strictObject({
        count: cacheHeartbeatSessionCountSchema,
        observedAtMs: cacheTimestampSchema,
        staleSinceMs: cacheTimestampSchema,
        state: v.literal("last-known-good"),
        truncated: v.boolean("Heartbeat Gateway session truncation is invalid"),
    }),
    v.check(
        cacheHeartbeatSessionsLastKnownGoodIsConsistent,
        "Heartbeat Gateway session freshness is inconsistent"
    )
);

/** Identity-free state of the latest bounded current-session projection. */
export const cacheHeartbeatSessionsSchema = v.variant("state", [
    cacheHeartbeatSessionsUnavailableSchema,
    cacheHeartbeatSessionsFreshSchema,
    cacheHeartbeatSessionsLastKnownGoodSchema,
]);

export const cacheHeartbeatPendingSyncStates = ["none", "present", "unknown"] as const;
export const cacheHeartbeatPendingSyncSchema = v.picklist(
    cacheHeartbeatPendingSyncStates,
    "Heartbeat OpenClaw cron pending-sync state is invalid"
);

const cacheHeartbeatCronProjectionEntries = {
    count: nonnegativeSafeIntegerSchema("Heartbeat OpenClaw cron count is invalid"),
    observedAtMs: cacheTimestampSchema,
    pendingSync: cacheHeartbeatPendingSyncSchema,
};
const cacheHeartbeatCronUnavailableSchema = v.strictObject({
    pendingSync: v.picklist(
        ["present", "unknown"],
        "Unavailable heartbeat OpenClaw cron pending-sync state is invalid"
    ),
    state: v.literal("unavailable"),
});
const cacheHeartbeatCronFreshSchema = v.strictObject({
    ...cacheHeartbeatCronProjectionEntries,
    state: v.literal("fresh"),
});
interface CacheHeartbeatCronLastKnownGood {
    readonly count: number;
    readonly observedAtMs: number;
    readonly pendingSync: "none" | "present" | "unknown";
    readonly staleSinceMs: number;
    readonly state: "last-known-good";
}

/**
 * @param projection Last-known-good cron summary to validate.
 * @returns Whether cron-projection staleness follows its observation.
 */
export function cacheHeartbeatCronLastKnownGoodIsConsistent(
    projection: CacheHeartbeatCronLastKnownGood & Record<string, unknown>
): boolean {
    return cacheHeartbeatLastKnownGoodTimesAreConsistent(projection);
}

const cacheHeartbeatCronLastKnownGoodSchema = v.pipe(
    v.strictObject({
        ...cacheHeartbeatCronProjectionEntries,
        staleSinceMs: cacheTimestampSchema,
        state: v.literal("last-known-good"),
    }),
    v.check(
        cacheHeartbeatCronLastKnownGoodIsConsistent,
        "Heartbeat OpenClaw cron freshness is inconsistent"
    )
);

/** Identity- and payload-free state of the latest global OpenClaw cron projection. */
export const cacheHeartbeatOpenClawCronSchema = v.variant("state", [
    cacheHeartbeatCronUnavailableSchema,
    cacheHeartbeatCronFreshSchema,
    cacheHeartbeatCronLastKnownGoodSchema,
]);

export const cacheHeartbeatTaskRelevanceValues = [
    "automation-linked",
    "agent-priority",
    "owner-blocked",
] as const;
const cacheHeartbeatTaskRelevanceSchema = v.pipe(
    v.array(
        v.picklist(
            cacheHeartbeatTaskRelevanceValues,
            "Heartbeat task relevance is invalid"
        ),
        "Heartbeat task relevance is invalid"
    ),
    v.minLength(1, "Heartbeat task relevance is invalid"),
    v.maxLength(
        cacheHeartbeatTaskRelevanceValues.length,
        "Heartbeat task relevance is invalid"
    )
);
const cacheHeartbeatTaskSchema = v.strictObject({
    automation: v.optional(
        v.strictObject({
            recurring: v.boolean("Heartbeat task recurring state is invalid"),
        })
    ),
    id: taskIdSchema,
    priority: taskPrioritySchema,
    relevance: cacheHeartbeatTaskRelevanceSchema,
    status: taskStatusSchema,
});
const cacheHeartbeatTasksUnavailableSchema = v.strictObject({
    state: v.literal("unavailable"),
});
const cacheHeartbeatTasksAvailableSchema = v.strictObject({
    items: v.pipe(
        v.array(cacheHeartbeatTaskSchema, "Heartbeat task rows are invalid"),
        v.maxLength(cacheHeartbeatTaskMaximum, "Heartbeat task rows exceed their budget")
    ),
    state: v.literal("available"),
    totalCount: nonnegativeSafeIntegerSchema("Heartbeat task total count is invalid"),
    truncated: v.boolean("Heartbeat task truncation state is invalid"),
});
const cacheHeartbeatTasksVariantSchema = v.variant("state", [
    cacheHeartbeatTasksUnavailableSchema,
    cacheHeartbeatTasksAvailableSchema,
]);
export type CacheHeartbeatTasks = v.InferOutput<typeof cacheHeartbeatTasksVariantSchema>;

/** @returns Whether task rows, relevance, exact total, and truncation are canonical. */
export function cacheHeartbeatTasksAreConsistent(
    projection: CacheHeartbeatTasks
): boolean {
    if (projection.state === "unavailable") return true;
    const items = projection.items;
    return (
        items.length === Math.min(projection.totalCount, cacheHeartbeatTaskMaximum) &&
        projection.truncated === projection.totalCount > cacheHeartbeatTaskMaximum &&
        items.every((item, index) =>
            index === 0 ? true : compareStrings(items[index - 1]!.id, item.id) < 0
        ) &&
        items.every((item) => {
            const canonicalRelevance = cacheHeartbeatTaskRelevanceValues.filter((value) =>
                item.relevance.includes(value)
            );
            return (
                item.status !== "done" &&
                canonicalRelevance.length === item.relevance.length &&
                canonicalRelevance.every(
                    (value, index) => value === item.relevance[index]
                ) &&
                item.relevance.includes("automation-linked") ===
                    (item.automation !== undefined) &&
                (!item.relevance.includes("agent-priority") ||
                    item.priority === "medium" ||
                    item.priority === "high") &&
                (!item.relevance.includes("owner-blocked") || item.status === "blocked")
            );
        })
    );
}

/** Bounded content-free task state used only by cache-read automation. */
export const cacheHeartbeatTasksSchema = v.pipe(
    cacheHeartbeatTasksVariantSchema,
    v.check(cacheHeartbeatTasksAreConsistent, "Heartbeat task projection is inconsistent")
);

const cacheHeartbeatJobDisableIntentSchema = v.strictObject({
    expiresAtMs: v.optional(cacheTimestampSchema),
    valid: v.boolean("Heartbeat Dashboard-job disable validity is invalid"),
});
const cacheHeartbeatActiveRunSchema = v.strictObject({
    firstStartedAtMs: v.optional(cacheTimestampSchema),
    queuedAtMs: cacheTimestampSchema,
    state: v.picklist(
        ["queued", "running"],
        "Heartbeat Dashboard-job active-run state is invalid"
    ),
    updatedAtMs: cacheTimestampSchema,
});
const cacheHeartbeatLatestRunSchema = v.strictObject({
    finishedAtMs: v.optional(cacheTimestampSchema),
    firstStartedAtMs: v.optional(cacheTimestampSchema),
    queuedAtMs: cacheTimestampSchema,
    state: jobRunStateSchema,
    terminalCode: v.optional(jobRunTerminalCodeSchema),
    triggerType: jobTriggerTypeSchema,
    updatedAtMs: cacheTimestampSchema,
});
const cacheHeartbeatDashboardJobMissingSchema = v.strictObject({
    defaultEnabled: v.boolean("Heartbeat Dashboard-job default state is invalid"),
    id: scheduleIdSchema,
    state: v.literal("missing"),
});
const cacheHeartbeatDashboardJobPresentSchema = v.strictObject({
    activeRun: v.optional(cacheHeartbeatActiveRunSchema),
    defaultEnabled: v.boolean("Heartbeat Dashboard-job default state is invalid"),
    disableIntent: v.optional(cacheHeartbeatJobDisableIntentSchema),
    enabled: v.boolean("Heartbeat Dashboard-job enabled state is invalid"),
    id: scheduleIdSchema,
    latestRun: v.optional(cacheHeartbeatLatestRunSchema),
    nextRunAtMs: v.nullable(cacheTimestampSchema),
    state: v.literal("present"),
});
/** One code-owned schedule without action metadata, payloads, identities, or messages. */
export const cacheHeartbeatDashboardJobSchema = v.variant("state", [
    cacheHeartbeatDashboardJobMissingSchema,
    cacheHeartbeatDashboardJobPresentSchema,
]);
const cacheHeartbeatDashboardJobsUnavailableSchema = v.strictObject({
    state: v.literal("unavailable"),
});
const cacheHeartbeatDashboardJobsAvailableSchema = v.strictObject({
    items: v.pipe(
        v.array(
            cacheHeartbeatDashboardJobSchema,
            "Heartbeat Dashboard-job rows are invalid"
        ),
        v.maxLength(
            cacheHeartbeatDashboardJobMaximum,
            "Heartbeat Dashboard-job rows exceed their budget"
        )
    ),
    state: v.literal("available"),
});
const cacheHeartbeatDashboardJobsVariantSchema = v.variant("state", [
    cacheHeartbeatDashboardJobsUnavailableSchema,
    cacheHeartbeatDashboardJobsAvailableSchema,
]);
export type CacheHeartbeatDashboardJobs = v.InferOutput<
    typeof cacheHeartbeatDashboardJobsVariantSchema
>;

/** @returns Whether schedule rows, run lifecycle, and optional expiry state are canonical. */
export function cacheHeartbeatDashboardJobsAreConsistent(
    projection: CacheHeartbeatDashboardJobs,
    generatedAtMs?: number
): boolean {
    if (projection.state === "unavailable") return true;
    return (
        projection.items.every((item, index) =>
            index === 0
                ? true
                : compareStrings(projection.items[index - 1]!.id, item.id) < 0
        ) &&
        projection.items.every((job) => {
            if (job.state === "missing") return true;
            const latestRunIsActive =
                job.latestRun !== undefined &&
                ["queued", "running"].includes(job.latestRun.state);
            if (
                job.enabled !== (job.nextRunAtMs !== null) ||
                (job.enabled && job.disableIntent !== undefined) ||
                (job.activeRun?.state === "running" &&
                    job.activeRun.firstStartedAtMs === undefined) ||
                (job.activeRun !== undefined) !== latestRunIsActive
            ) {
                return false;
            }
            if (
                job.activeRun !== undefined &&
                job.latestRun !== undefined &&
                (job.activeRun.state !== job.latestRun.state ||
                    job.activeRun.queuedAtMs !== job.latestRun.queuedAtMs ||
                    job.activeRun.firstStartedAtMs !== job.latestRun.firstStartedAtMs ||
                    job.activeRun.updatedAtMs !== job.latestRun.updatedAtMs)
            ) {
                return false;
            }
            const historicalTimestamps = [
                ...(job.activeRun === undefined
                    ? []
                    : [
                          job.activeRun.queuedAtMs,
                          job.activeRun.updatedAtMs,
                          ...(job.activeRun.firstStartedAtMs === undefined
                              ? []
                              : [job.activeRun.firstStartedAtMs]),
                      ]),
                ...(job.latestRun === undefined
                    ? []
                    : [
                          job.latestRun.queuedAtMs,
                          job.latestRun.updatedAtMs,
                          ...(job.latestRun.firstStartedAtMs === undefined
                              ? []
                              : [job.latestRun.firstStartedAtMs]),
                          ...(job.latestRun.finishedAtMs === undefined
                              ? []
                              : [job.latestRun.finishedAtMs]),
                      ]),
            ];
            if (
                generatedAtMs !== undefined &&
                (!historicalTimestamps.every((timestamp) => timestamp <= generatedAtMs) ||
                    (job.disableIntent !== undefined &&
                        job.disableIntent.valid !==
                            (job.disableIntent.expiresAtMs === undefined ||
                                job.disableIntent.expiresAtMs > generatedAtMs)))
            ) {
                return false;
            }
            return !(
                (job.activeRun !== undefined &&
                    !heartbeatRunTimesAreConsistent(job.activeRun)) ||
                (job.latestRun !== undefined &&
                    (!heartbeatRunTimesAreConsistent(job.latestRun) ||
                        ["queued", "running"].includes(job.latestRun.state) !==
                            (job.latestRun.finishedAtMs === undefined) ||
                        ["cancelled", "failed", "timed-out"].includes(
                            job.latestRun.state
                        ) !==
                            (job.latestRun.terminalCode !== undefined)))
            );
        })
    );
}

/** Complete code-owned Dashboard schedule inventory or an explicit safe read failure. */
export const cacheHeartbeatDashboardJobsSchema = v.pipe(
    cacheHeartbeatDashboardJobsVariantSchema,
    v.check(
        cacheHeartbeatDashboardJobsAreConsistent,
        "Heartbeat Dashboard-job projection is inconsistent"
    )
);

const cacheHeartbeatResultObjectSchema = v.strictObject({
    cache: cacheStatusResultSchema,
    dashboardJobs: cacheHeartbeatDashboardJobsSchema,
    gateway: v.strictObject({
        connection: cacheHeartbeatConnectionSchema,
        sessions: cacheHeartbeatSessionsSchema,
    }),
    generatedAtMs: cacheTimestampSchema,
    openClawCron: cacheHeartbeatOpenClawCronSchema,
    schemaVersion: v.literal(cacheHeartbeatSchemaVersion),
    tasks: cacheHeartbeatTasksSchema,
});

export type CacheHeartbeatResult = v.InferOutput<typeof cacheHeartbeatResultObjectSchema>;

function heartbeatRunTimesAreConsistent(run: {
    readonly finishedAtMs?: number;
    readonly firstStartedAtMs?: number;
    readonly queuedAtMs: number;
    readonly updatedAtMs: number;
}): boolean {
    return (
        run.queuedAtMs <= run.updatedAtMs &&
        (run.firstStartedAtMs === undefined ||
            (run.firstStartedAtMs >= run.queuedAtMs &&
                run.firstStartedAtMs <= run.updatedAtMs)) &&
        (run.finishedAtMs === undefined ||
            (run.finishedAtMs >= (run.firstStartedAtMs ?? run.queuedAtMs) &&
                run.finishedAtMs <= run.updatedAtMs))
    );
}

/** @returns Whether all bounded rows, totals, and timestamps agree with the response clock. */
export function cacheHeartbeatResultIsConsistent(result: CacheHeartbeatResult): boolean {
    if (
        !cacheHeartbeatTasksAreConsistent(result.tasks) ||
        !cacheHeartbeatDashboardJobsAreConsistent(
            result.dashboardJobs,
            result.generatedAtMs
        )
    ) {
        return false;
    }
    const dashboardJobs =
        result.dashboardJobs.state === "available" ? result.dashboardJobs.items : [];
    const timestamps = [
        result.cache.generatedAtMs,
        result.gateway.connection.checkedAtMs,
        ...(result.gateway.sessions.state === "unavailable"
            ? []
            : [
                  result.gateway.sessions.observedAtMs,
                  ...(result.gateway.sessions.state === "last-known-good"
                      ? [result.gateway.sessions.staleSinceMs]
                      : []),
              ]),
        ...(result.openClawCron.state === "unavailable"
            ? []
            : [
                  result.openClawCron.observedAtMs,
                  ...(result.openClawCron.state === "last-known-good"
                      ? [result.openClawCron.staleSinceMs]
                      : []),
              ]),
        ...dashboardJobs.flatMap((job) =>
            job.state === "missing"
                ? []
                : [
                      ...(job.activeRun === undefined
                          ? []
                          : [
                                job.activeRun.queuedAtMs,
                                job.activeRun.updatedAtMs,
                                ...(job.activeRun.firstStartedAtMs === undefined
                                    ? []
                                    : [job.activeRun.firstStartedAtMs]),
                            ]),
                      ...(job.latestRun === undefined
                          ? []
                          : [
                                job.latestRun.queuedAtMs,
                                job.latestRun.updatedAtMs,
                                ...(job.latestRun.firstStartedAtMs === undefined
                                    ? []
                                    : [job.latestRun.firstStartedAtMs]),
                                ...(job.latestRun.finishedAtMs === undefined
                                    ? []
                                    : [job.latestRun.finishedAtMs]),
                            ]),
                  ]
        ),
    ];
    return (
        timestamps.every((timestamp) => timestamp <= result.generatedAtMs) &&
        (result.gateway.connection.freshness === "fresh" ||
            (result.gateway.sessions.state !== "fresh" &&
                result.openClawCron.state !== "fresh"))
    );
}

/** Compact cache, Gateway, task, schedule, and OpenClaw-cron heartbeat projection. */
export const cacheHeartbeatResultSchema = v.pipe(
    cacheHeartbeatResultObjectSchema,
    v.check(cacheHeartbeatResultIsConsistent, "Cache heartbeat result is inconsistent")
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

/** Cache projection lookup, bounded status/heartbeat, and durable refresh contracts. */
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
        inputSchemaId: "cache.getHeartbeat.input",
        kind: "query",
        name: "cache.getHeartbeat",
        output: cacheHeartbeatResultSchema,
        outputSchemaId: "cache.getHeartbeat.output",
        summary: "Returns compact cache status plus sanitized operational projections.",
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
