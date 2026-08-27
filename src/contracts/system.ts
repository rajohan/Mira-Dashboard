import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { nonnegativeSafeIntegerSchema } from "../shared/validation.ts";
import {
    gatewayConnectionFreshnessSchema,
    gatewayConnectionPhaseSchema,
} from "./gatewayConnection.ts";
import { gatewaySessionProjectionMaximum } from "./gatewaySessions.ts";
import { jobWorkerCapacityMaximum, jobWorkerSummaryMaximum } from "./jobLimits.ts";
import type { ProcedureContract, RawHttpContract } from "./registry.ts";

/** Stable raw HTTP liveness endpoint shared by contracts and runtime dispatch. */
export const healthLivenessPath = "/api/health/live";
/** Stable raw HTTP readiness endpoint shared by contracts and runtime dispatch. */
export const healthReadinessPath = "/api/health/ready";

/** Empty object accepted by procedures without user input. */
export const emptyInputSchema = v.optional(v.strictObject({}), {});

/** Authenticated generated-document payload served outside the public browser bundle. */
export const documentationReferenceSchema = v.pipe(
    v.array(
        v.strictObject({
            content: v.optional(v.string()),
            kind: v.picklist(["json", "markdown", "schema"]),
            path: v.string(),
            source: v.picklist(["generated", "maintained"]),
        })
    ),
    v.maxLength(1000)
);
export type DocumentationReference = v.InferOutput<typeof documentationReferenceSchema>;

const openClawVersionSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u)
);

/** Sanitized OpenClaw installation/update projection. */
export const openClawUpdateStatusSchema = v.variant("state", [
    v.strictObject({ state: v.literal("unavailable") }),
    v.strictObject({
        available: v.boolean(),
        channel: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
        installedVersion: openClawVersionSchema,
        latestVersion: openClawVersionSchema,
        state: v.literal("observed"),
    }),
]);
export type OpenClawUpdateStatus = v.InferOutput<typeof openClawUpdateStatusSchema>;
export const openClawUpdateCacheKey = "system.openclaw";
export const openClawUpdateCacheSchemaId = "system.openclaw.v1";
export const openClawUpdateCacheSource = "openclaw.cli";
export const openClawUpdateCacheTtlMs = 15 * 60_000;

const systemMetricByteCountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const systemMetricPercentSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(100));
const systemMetricLoadSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(100_000));

function roundedCapacityPercent(usedBytes: number, totalBytes: number): number {
    return totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 1000) / 10;
}

/**
 * @param capacity - Capacity fields emitted by the sampler.
 * @returns Whether the bytes and rounded percentage describe one state.
 */
export function systemMetricCapacityIsConsistent(capacity: {
    freeBytes: number;
    totalBytes: number;
    usedBytes: number;
    usedPercent: number;
}): boolean {
    return (
        capacity.freeBytes <= capacity.totalBytes &&
        capacity.usedBytes === capacity.totalBytes - capacity.freeBytes &&
        capacity.usedPercent ===
            roundedCapacityPercent(capacity.usedBytes, capacity.totalBytes)
    );
}

/** Capacity projection with explicit byte and percentage units. */
export const systemMetricCapacitySchema = v.pipe(
    v.strictObject({
        freeBytes: systemMetricByteCountSchema,
        totalBytes: systemMetricByteCountSchema,
        usedBytes: systemMetricByteCountSchema,
        usedPercent: systemMetricPercentSchema,
    }),
    v.check(
        systemMetricCapacityIsConsistent,
        "System metric capacity fields are inconsistent"
    )
);

/** Fixed operational procedures with dedicated HTTP metric buckets. */
export const systemHttpMetricProcedureNames = [
    "auth.status",
    "cache.getHeartbeat",
    "database.overview",
    "docker.overview",
    "events.stream",
    "jobs.listRuns",
    "logs.maintenanceStatus",
    "notifications.list",
    "reports.list",
    "schedules.list",
    "system.healthDiagnostics",
    "system.metrics",
] as const;

/** Final bounded bucket for all procedures outside the reviewed fixed set. */
export const systemHttpMetricOverflowProcedure = "overflow" as const;
const systemHttpMetricProcedureSchema = v.picklist([
    ...systemHttpMetricProcedureNames,
    systemHttpMetricOverflowProcedure,
]);
const systemMetricCountSchema = nonnegativeSafeIntegerSchema(
    "Application metric count is invalid"
);
const systemMetricDurationSchema = nonnegativeSafeIntegerSchema(
    "Application metric duration is invalid"
);
const systemMetricTimestampSchema = timestampMillisecondsSchema(
    "Application metric timestamp is invalid"
);
const systemMetricUnavailableSchema = v.strictObject({
    state: v.literal("unavailable"),
});

/** Maximum durable run sample used for aggregate external-operation metrics. */
export const systemOperationMetricSampleMaximum = 100;
/** Maximum registered cache rows rendered as payload-free snapshot diagnostics. */
export const systemCacheSnapshotMetricMaximum = 32;

const systemHttpMetricRowObjectSchema = v.strictObject({
    errorCount: systemMetricCountSchema,
    maximumDurationMs: systemMetricDurationSchema,
    procedure: systemHttpMetricProcedureSchema,
    requestCount: systemMetricCountSchema,
    totalDurationMs: systemMetricDurationSchema,
});
type SystemHttpMetricRow = v.InferOutput<typeof systemHttpMetricRowObjectSchema>;

/** @returns Whether one HTTP bucket's counts and duration aggregates agree. */
export function systemHttpMetricRowIsConsistent(row: SystemHttpMetricRow): boolean {
    return (
        row.errorCount <= row.requestCount &&
        (row.requestCount === 0
            ? row.maximumDurationMs === 0 && row.totalDurationMs === 0
            : row.maximumDurationMs <= row.totalDurationMs)
    );
}

const systemHttpMetricRowSchema = v.pipe(
    systemHttpMetricRowObjectSchema,
    v.check(systemHttpMetricRowIsConsistent, "HTTP metric row is inconsistent")
);
const systemHttpMetricExpectedProcedures = [
    ...systemHttpMetricProcedureNames,
    systemHttpMetricOverflowProcedure,
] as const;

/**
 * @param rows Fixed HTTP metric buckets.
 * @returns Whether fixed HTTP buckets appear once in canonical order.
 */
export function systemHttpMetricRowsAreCanonical(rows: SystemHttpMetricRow[]): boolean {
    return rows.every(
        (row, index) => row.procedure === systemHttpMetricExpectedProcedures[index]
    );
}

const systemHttpMetricRowsSchema = v.pipe(
    v.array(systemHttpMetricRowSchema, "HTTP metric rows are invalid"),
    v.length(
        systemHttpMetricExpectedProcedures.length,
        "HTTP metric bucket inventory is incomplete"
    ),
    v.check(systemHttpMetricRowsAreCanonical, "HTTP metric buckets are not canonical")
);

const systemWebMetricsSchema = v.variant("state", [
    systemMetricUnavailableSchema,
    v.strictObject({
        eventLoopDelayMs: systemMetricDurationSchema,
        externalBytes: systemMetricByteCountSchema,
        heapTotalBytes: systemMetricByteCountSchema,
        heapUsedBytes: systemMetricByteCountSchema,
        rssBytes: systemMetricByteCountSchema,
        state: v.literal("observed"),
        uptimeSeconds: systemMetricCountSchema,
    }),
]);

const systemOperationMetricsObjectSchema = v.strictObject({
    activeRuns: systemMetricCountSchema,
    averageDurationMs: systemMetricDurationSchema,
    failedRuns: systemMetricCountSchema,
    maximumDurationMs: systemMetricDurationSchema,
    sampledRuns: v.pipe(
        systemMetricCountSchema,
        v.maxValue(
            systemOperationMetricSampleMaximum,
            "Application operation sample is outside its budget"
        )
    ),
    state: v.literal("observed"),
    succeededRuns: systemMetricCountSchema,
});
type SystemOperationMetrics = v.InferOutput<typeof systemOperationMetricsObjectSchema>;

/** @returns Whether sampled durable operation states and durations agree. */
export function systemOperationMetricsAreConsistent(
    metrics: SystemOperationMetrics
): boolean {
    return (
        metrics.activeRuns + metrics.failedRuns + metrics.succeededRuns ===
            metrics.sampledRuns &&
        (metrics.failedRuns + metrics.succeededRuns === 0
            ? metrics.averageDurationMs === 0 && metrics.maximumDurationMs === 0
            : metrics.averageDurationMs <= metrics.maximumDurationMs)
    );
}

const systemOperationMetricsSchema = v.variant("state", [
    systemMetricUnavailableSchema,
    v.pipe(
        systemOperationMetricsObjectSchema,
        v.check(
            systemOperationMetricsAreConsistent,
            "Application operation metrics are inconsistent"
        )
    ),
]);

const systemChatMetricsObjectSchema = v.strictObject({
    activeRuns: systemMetricCountSchema,
    failedOrUnknownRuns: systemMetricCountSchema,
    retainedEventBytes: systemMetricByteCountSchema,
    retainedEvents: systemMetricCountSchema,
    retainedRuns: systemMetricCountSchema,
    retainedSnapshotBytes: systemMetricByteCountSchema,
    retainedSnapshots: systemMetricCountSchema,
    state: v.literal("observed"),
});
type SystemChatMetrics = v.InferOutput<typeof systemChatMetricsObjectSchema>;

/** @returns Whether durable chat subsets fit within their retained run inventory. */
export function systemChatMetricsAreConsistent(metrics: SystemChatMetrics): boolean {
    return (
        metrics.activeRuns <= metrics.retainedRuns &&
        metrics.failedOrUnknownRuns <= metrics.retainedRuns &&
        metrics.retainedSnapshots <= metrics.retainedRuns
    );
}

const systemChatMetricsSchema = v.variant("state", [
    systemMetricUnavailableSchema,
    v.pipe(
        systemChatMetricsObjectSchema,
        v.check(
            systemChatMetricsAreConsistent,
            "Application chat metrics are inconsistent"
        )
    ),
]);

const systemJobsMetricsSchema = v.variant("state", [
    systemMetricUnavailableSchema,
    v.strictObject({
        claimingPaused: v.boolean(),
        queuedRuns: systemMetricCountSchema,
        runningRuns: systemMetricCountSchema,
        scheduleLagMs: systemMetricDurationSchema,
        state: v.literal("observed"),
        workers: v.strictObject({
            capacity: systemMetricCountSchema,
            draining: systemMetricCountSchema,
            online: systemMetricCountSchema,
        }),
    }),
]);

const systemSqliteMetricsSchema = v.variant("state", [
    systemMetricUnavailableSchema,
    v.strictObject({
        freeBytes: systemMetricByteCountSchema,
        freePages: systemMetricCountSchema,
        freePercent: systemMetricPercentSchema,
        pageCount: systemMetricCountSchema,
        readLatencyMs: systemMetricDurationSchema,
        state: v.literal("observed"),
        storageBytes: systemMetricByteCountSchema,
    }),
]);

const systemGatewayMetricsSchema = v.variant("state", [
    systemMetricUnavailableSchema,
    v.strictObject({
        checkedAtMs: systemMetricTimestampSchema,
        freshness: gatewayConnectionFreshnessSchema,
        lastActivityAtMs: v.optional(systemMetricTimestampSchema),
        phase: gatewayConnectionPhaseSchema,
        reconnectAttempt: systemMetricCountSchema,
        state: v.literal("observed"),
    }),
]);

const systemRealtimeMetricsSchema = v.variant("state", [
    systemMetricUnavailableSchema,
    v.strictObject({
        activeSubscribers: systemMetricCountSchema,
        droppedSlowSubscribers: systemMetricCountSchema,
        forcedResyncs: systemMetricCountSchema,
        pollFailures: systemMetricCountSchema,
        polls: systemMetricCountSchema,
        retainedEvents: v.optional(systemMetricCountSchema),
        state: v.literal("observed"),
        subscriberCapacityRejections: systemMetricCountSchema,
        subscriptionReadFailures: systemMetricCountSchema,
        wakeups: systemMetricCountSchema,
    }),
]);

const systemCacheSnapshotMetricSchema = v.strictObject({
    attemptCount: systemMetricCountSchema,
    consecutiveFailures: systemMetricCountSchema,
    freshness: v.picklist(["fresh", "missing", "stale"]),
    key: v.pipe(
        v.string("Application cache key is invalid"),
        v.minLength(1, "Application cache key is invalid"),
        v.maxLength(128, "Application cache key is invalid"),
        v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Application cache key is invalid")
    ),
    lastAttemptDurationMs: systemMetricDurationSchema,
    lastAttemptStatus: v.picklist(["failed", "succeeded"]),
});
type SystemCacheSnapshotMetric = v.InferOutput<typeof systemCacheSnapshotMetricSchema>;

/**
 * @param snapshots Payload-free registered cache snapshot rows.
 * @returns Whether registered cache snapshot rows use strict canonical key order.
 */
export function systemCacheSnapshotsAreCanonical(
    snapshots: SystemCacheSnapshotMetric[]
): boolean {
    return snapshots.every(
        (snapshot, index) =>
            index === 0 || snapshots[index - 1]!.key.localeCompare(snapshot.key) < 0
    );
}

const systemCacheMetricsSchema = v.variant("state", [
    systemMetricUnavailableSchema,
    v.strictObject({
        entryCount: systemMetricCountSchema,
        failedEntryCount: systemMetricCountSchema,
        latestAttemptAtMs: v.optional(systemMetricTimestampSchema),
        maximumAttemptDurationMs: systemMetricDurationSchema,
        missingEntryCount: systemMetricCountSchema,
        refreshAttemptCount: systemMetricCountSchema,
        snapshots: v.pipe(
            v.array(systemCacheSnapshotMetricSchema),
            v.maxLength(
                systemCacheSnapshotMetricMaximum,
                "Application cache snapshot inventory is outside its budget"
            ),
            v.check(
                systemCacheSnapshotsAreCanonical,
                "Application cache snapshots are not canonically ordered"
            )
        ),
        staleEntryCount: systemMetricCountSchema,
        state: v.literal("observed"),
    }),
]);

const systemHttpMetricsSchema = v.strictObject({
    procedures: systemHttpMetricRowsSchema,
    state: v.literal("observed"),
});

/** Independent application components; one failed reader never hides another. */
export const systemApplicationMetricsSchema = v.strictObject({
    cache: systemCacheMetricsSchema,
    chat: systemChatMetricsSchema,
    gateway: systemGatewayMetricsSchema,
    http: systemHttpMetricsSchema,
    jobs: systemJobsMetricsSchema,
    operations: systemOperationMetricsSchema,
    realtime: systemRealtimeMetricsSchema,
    sqlite: systemSqliteMetricsSchema,
    web: systemWebMetricsSchema,
});

export type SystemApplicationMetrics = v.InferOutput<
    typeof systemApplicationMetricsSchema
>;

/** Existing bounded host gauges, kept separate from optional application readers. */
export const systemHostMetricsSchema = v.strictObject({
    cpu: v.strictObject({
        loadAverage: v.tuple([
            systemMetricLoadSchema,
            systemMetricLoadSchema,
            systemMetricLoadSchema,
        ]),
        loadPercent: v.pipe(systemMetricLoadSchema, v.maxValue(10_000)),
        logicalCoreCount: v.pipe(
            v.number(),
            v.safeInteger(),
            v.minValue(1),
            v.maxValue(8192)
        ),
    }),
    disk: systemMetricCapacitySchema,
    freshness: v.picklist(["fresh", "stale"]),
    memory: systemMetricCapacitySchema,
    network: v.strictObject({
        downloadBitsPerSecond: systemMetricByteCountSchema,
        state: v.picklist(["ready", "warming"]),
        uploadBitsPerSecond: systemMetricByteCountSchema,
    }),
    sampledAtMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    uptimeSeconds: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type SystemHostMetrics = v.InferOutput<typeof systemHostMetricsSchema>;

/** @returns Whether component timestamps and count partitions are causal. */
export function systemApplicationMetricsAreConsistent(
    application: SystemApplicationMetrics,
    sampledAtMs: number
): boolean {
    const cache = application.cache;
    const chat = application.chat;
    const gateway = application.gateway;
    const jobs = application.jobs;
    const sqlite = application.sqlite;
    const web = application.web;
    return (
        (cache.state === "unavailable" ||
            (cache.failedEntryCount <= cache.entryCount &&
                cache.missingEntryCount <= cache.entryCount &&
                cache.staleEntryCount <= cache.entryCount &&
                cache.snapshots.length <= cache.entryCount &&
                (cache.latestAttemptAtMs === undefined ||
                    cache.latestAttemptAtMs <= sampledAtMs))) &&
        (chat.state === "unavailable" ||
            (chat.activeRuns <= chat.retainedRuns &&
                chat.failedOrUnknownRuns <= chat.retainedRuns &&
                chat.retainedSnapshots <= chat.retainedRuns)) &&
        (gateway.state === "unavailable" ||
            (gateway.checkedAtMs <= sampledAtMs &&
                (gateway.lastActivityAtMs === undefined ||
                    gateway.lastActivityAtMs <= gateway.checkedAtMs) &&
                (gateway.freshness === "fresh") === (gateway.phase === "connected"))) &&
        (jobs.state === "unavailable" ||
            jobs.workers.online + jobs.workers.draining <= jobs.workers.capacity) &&
        (sqlite.state === "unavailable" ||
            (sqlite.freePages <= sqlite.pageCount &&
                sqlite.freeBytes <= sqlite.storageBytes)) &&
        (web.state === "unavailable" || web.heapUsedBytes <= web.heapTotalBytes)
    );
}

const systemMetricsObjectSchema = v.strictObject({
    ...systemHostMetricsSchema.entries,
    application: systemApplicationMetricsSchema,
});

/** @returns Whether one complete metrics response has causal application fields. */
export function systemMetricsApplicationIsConsistent(
    metrics: v.InferOutput<typeof systemMetricsObjectSchema>
): boolean {
    return systemApplicationMetricsAreConsistent(
        metrics.application,
        metrics.sampledAtMs
    );
}

/** Bounded session-only host and independently available application metrics. */
export const systemMetricsSchema = v.pipe(
    systemMetricsObjectSchema,
    v.check(systemMetricsApplicationIsConsistent, "Application metrics are inconsistent")
);

export type SystemMetrics = v.InferOutput<typeof systemMetricsSchema>;

const systemHealthDiagnosticsTimestampSchema = timestampMillisecondsSchema(
    "System health diagnostics timestamp is invalid"
);
const systemHealthDiagnosticsCountSchema = nonnegativeSafeIntegerSchema(
    "System health diagnostics count is invalid"
);

/** Sanitized process-owned Gateway state, with provider failures made explicit. */
const systemHealthDiagnosticsGatewayVariantSchema = v.variant("status", [
    v.strictObject({
        freshness: gatewayConnectionFreshnessSchema,
        phase: gatewayConnectionPhaseSchema,
        status: v.literal("observed"),
    }),
    v.strictObject({ status: v.literal("unavailable") }),
]);

/** @returns Whether connected phase and fresh state agree. */
export function systemHealthDiagnosticsGatewayIsConsistent(
    gateway: v.InferOutput<typeof systemHealthDiagnosticsGatewayVariantSchema>
): boolean {
    return (
        gateway.status === "unavailable" ||
        (gateway.freshness === "fresh") === (gateway.phase === "connected")
    );
}

export const systemHealthDiagnosticsGatewaySchema = v.pipe(
    systemHealthDiagnosticsGatewayVariantSchema,
    v.check(
        systemHealthDiagnosticsGatewayIsConsistent,
        "System health Gateway projection is inconsistent"
    )
);

/** Identity-free cached Gateway-session count with explicit source freshness. */
const systemHealthDiagnosticsSessionsVariantSchema = v.variant("state", [
    v.strictObject({ state: v.literal("unavailable") }),
    v.strictObject({
        count: v.pipe(
            systemHealthDiagnosticsCountSchema,
            v.maxValue(
                gatewaySessionProjectionMaximum,
                "System health session count is outside its budget"
            )
        ),
        observedAtMs: systemHealthDiagnosticsTimestampSchema,
        state: v.literal("fresh"),
        truncated: v.boolean(),
    }),
    v.strictObject({
        count: v.pipe(
            systemHealthDiagnosticsCountSchema,
            v.maxValue(
                gatewaySessionProjectionMaximum,
                "System health session count is outside its budget"
            )
        ),
        observedAtMs: systemHealthDiagnosticsTimestampSchema,
        staleSinceMs: systemHealthDiagnosticsTimestampSchema,
        state: v.literal("last-known-good"),
        truncated: v.boolean(),
    }),
]);

/** @returns Whether last-known-good session timestamps remain ordered. */
export function systemHealthDiagnosticsSessionsAreConsistent(
    sessions: v.InferOutput<typeof systemHealthDiagnosticsSessionsVariantSchema>
): boolean {
    return (
        sessions.state !== "last-known-good" ||
        sessions.staleSinceMs >= sessions.observedAtMs
    );
}

export const systemHealthDiagnosticsSessionsSchema = v.pipe(
    systemHealthDiagnosticsSessionsVariantSchema,
    v.check(
        systemHealthDiagnosticsSessionsAreConsistent,
        "System health session projection is inconsistent"
    )
);

const systemHealthDiagnosticsWorkerCountSchema = v.pipe(
    systemHealthDiagnosticsCountSchema,
    v.maxValue(
        jobWorkerSummaryMaximum,
        "System health worker count is outside its budget"
    )
);
const systemHealthDiagnosticsWorkerCapacitySchema = v.pipe(
    systemHealthDiagnosticsCountSchema,
    v.maxValue(
        jobWorkerSummaryMaximum * jobWorkerCapacityMaximum,
        "System health worker capacity is outside its budget"
    )
);

const systemHealthDiagnosticsWorkersObjectSchema = v.strictObject({
    capacity: systemHealthDiagnosticsWorkerCapacitySchema,
    drainingCount: systemHealthDiagnosticsWorkerCountSchema,
    freshCount: systemHealthDiagnosticsWorkerCountSchema,
    onlineCount: systemHealthDiagnosticsWorkerCountSchema,
});

/** @returns Whether the fresh worker count matches its lifecycle partitions. */
export function systemHealthDiagnosticsWorkersAreConsistent(
    workers: v.InferOutput<typeof systemHealthDiagnosticsWorkersObjectSchema>
): boolean {
    const maximumCapacity = workers.freshCount * jobWorkerCapacityMaximum;
    return (
        workers.freshCount === workers.drainingCount + workers.onlineCount &&
        workers.capacity >= workers.freshCount &&
        workers.capacity <= maximumCapacity
    );
}

const systemHealthDiagnosticsWorkersSchema = v.pipe(
    systemHealthDiagnosticsWorkersObjectSchema,
    v.check(
        systemHealthDiagnosticsWorkersAreConsistent,
        "System health worker projection is inconsistent"
    )
);

/** Bounded content-free queue state, or an explicit unavailable component. */
const systemHealthDiagnosticsQueueVariantSchema = v.variant("status", [
    v.strictObject({
        claimingPaused: v.boolean(),
        oldestQueuedAtMs: v.optional(systemHealthDiagnosticsTimestampSchema),
        runs: v.strictObject({
            queued: systemHealthDiagnosticsCountSchema,
            running: systemHealthDiagnosticsCountSchema,
        }),
        status: v.literal("observed"),
        workers: systemHealthDiagnosticsWorkersSchema,
    }),
    v.strictObject({ status: v.literal("unavailable") }),
]);

/** @returns Whether queue count and oldest-row presence agree. */
export function systemHealthDiagnosticsQueueIsConsistent(
    queue: v.InferOutput<typeof systemHealthDiagnosticsQueueVariantSchema>
): boolean {
    return (
        queue.status === "unavailable" ||
        queue.runs.queued > 0 === (queue.oldestQueuedAtMs !== undefined)
    );
}

export const systemHealthDiagnosticsQueueSchema = v.pipe(
    systemHealthDiagnosticsQueueVariantSchema,
    v.check(
        systemHealthDiagnosticsQueueIsConsistent,
        "System health queue projection is inconsistent"
    )
);

const systemHealthDiagnosticsChecksSchema = v.strictObject({
    application: v.strictObject({
        status: v.picklist(["not-ready", "ready"]),
    }),
    database: v.strictObject({
        status: v.picklist(["ready", "unavailable"]),
    }),
    frontend: v.strictObject({
        status: v.picklist(["ready", "unavailable"]),
    }),
    release: v.strictObject({
        status: v.picklist(["unavailable", "verified"]),
    }),
    worker: v.strictObject({
        status: v.picklist(["not-ready", "ready", "unavailable"]),
    }),
});

type SystemHealthDiagnosticsValue = {
    readonly checkedAtMs: number;
    readonly checks: v.InferOutput<typeof systemHealthDiagnosticsChecksSchema>;
    readonly dependencies: {
        readonly gateway: v.InferOutput<typeof systemHealthDiagnosticsGatewaySchema>;
        readonly sessions: v.InferOutput<typeof systemHealthDiagnosticsSessionsSchema>;
    };
    readonly queue: v.InferOutput<typeof systemHealthDiagnosticsQueueSchema>;
    readonly status: "not-ready" | "ready";
};

/** @returns Whether the aggregate state exactly reflects every gating check. */
export function systemHealthDiagnosticsIsConsistent(
    diagnostics: SystemHealthDiagnosticsValue
): boolean {
    const checks = diagnostics.checks;
    const ready =
        checks.application.status === "ready" &&
        checks.database.status === "ready" &&
        checks.frontend.status === "ready" &&
        checks.release.status === "verified" &&
        checks.worker.status === "ready";
    const queueTimeIsConsistent =
        diagnostics.queue.status === "unavailable" ||
        diagnostics.queue.oldestQueuedAtMs === undefined ||
        diagnostics.queue.oldestQueuedAtMs <= diagnostics.checkedAtMs;
    const sessions = diagnostics.dependencies.sessions;
    const gateway = diagnostics.dependencies.gateway;
    const sessionTimeIsConsistent =
        sessions.state === "unavailable" ||
        (sessions.observedAtMs <= diagnostics.checkedAtMs &&
            (sessions.state !== "last-known-good" ||
                sessions.staleSinceMs <= diagnostics.checkedAtMs));
    const dependencyFreshnessIsConsistent =
        sessions.state !== "fresh" ||
        (gateway.status === "observed" && gateway.freshness === "fresh");
    const queueChecksAreConsistent =
        diagnostics.queue.status === "observed"
            ? checks.database.status === "ready" &&
              (checks.release.status === "verified") ===
                  (checks.worker.status !== "unavailable") &&
              (checks.worker.status !== "ready" ||
                  diagnostics.queue.workers.onlineCount > 0)
            : checks.database.status === "unavailable" &&
              checks.worker.status === "unavailable";
    return (
        queueTimeIsConsistent &&
        sessionTimeIsConsistent &&
        dependencyFreshnessIsConsistent &&
        queueChecksAreConsistent &&
        (diagnostics.status === "ready") === ready
    );
}

/** Session-only readiness, dependency, and queue diagnostics without identities. */
export const systemHealthDiagnosticsSchema = v.pipe(
    v.strictObject({
        checkedAtMs: systemHealthDiagnosticsTimestampSchema,
        checks: systemHealthDiagnosticsChecksSchema,
        dependencies: v.strictObject({
            gateway: systemHealthDiagnosticsGatewaySchema,
            sessions: systemHealthDiagnosticsSessionsSchema,
        }),
        queue: systemHealthDiagnosticsQueueSchema,
        status: v.picklist(["not-ready", "ready"]),
    }),
    v.check(
        systemHealthDiagnosticsIsConsistent,
        "System health diagnostics aggregate is inconsistent"
    )
);

export type SystemHealthDiagnostics = v.InferOutput<typeof systemHealthDiagnosticsSchema>;

/** Public runtime identity returned by the system procedure. */
export const runtimeIdentitySchema = v.strictObject({
    revision: v.pipe(v.string(), v.description("Full Bun Git revision.")),
    version: v.pipe(v.string(), v.description("Bun semantic version.")),
    versionWithRevision: v.pipe(
        v.string(),
        v.description("Human-readable Bun version and short diagnostic revision.")
    ),
});

/** Liveness response returned while the Bun process can answer requests. */
export const livenessStatusSchema = v.strictObject({
    status: v.literal("live"),
});

/** Readiness response returned before and after critical initialization. */
export const readinessStatusSchema = v.strictObject({
    status: v.picklist(["not-ready", "ready"]),
});

/** Runtime identity contract shared by tRPC wiring and generated documentation. */
export const runtimeIdentityContract = {
    access: { kind: "public" },
    domain: "system",
    errors: [],
    input: emptyInputSchema,
    inputSchemaId: "system.runtimeIdentity.input",
    kind: "query",
    name: "system.runtimeIdentity",
    output: runtimeIdentitySchema,
    outputSchemaId: "system.runtimeIdentity.output",
    summary: "Returns the Bun runtime identity of the serving process.",
    transport: {
        batching: "adapter-default",
        handler: "default",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

/** Session-only immutable documentation reference contract. */
export const documentationReferenceContract = {
    access: {
        capabilities: [],
        capabilityPolicy: "all",
        kind: "authenticated",
        principalKinds: ["session"],
    },
    domain: "system",
    errors: ["FORBIDDEN", "UNAUTHORIZED"],
    input: emptyInputSchema,
    inputSchemaId: "system.documentationReference.input",
    kind: "query",
    name: "system.documentationReference",
    output: documentationReferenceSchema,
    outputSchemaId: "system.documentationReference.output",
    summary:
        "Returns the immutable generated release reference to an authenticated browser session.",
    transport: {
        batching: "adapter-default",
        handler: "default",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

/** Session-only metrics contract without automation authority or host identity. */
export const systemMetricsContract = {
    access: {
        capabilities: [],
        capabilityPolicy: "all",
        kind: "authenticated",
        principalKinds: ["session"],
    },
    domain: "system",
    errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    input: emptyInputSchema,
    inputSchemaId: "system.metrics.input",
    kind: "query",
    name: "system.metrics",
    output: systemMetricsSchema,
    outputSchemaId: "system.metrics.output",
    summary:
        "Returns bounded host and independently available application observability without identity or control authority.",
    transport: {
        batching: "adapter-default",
        handler: "default",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

/** Session-only detailed health contract without automation or control authority. */
export const systemHealthDiagnosticsContract = {
    access: {
        capabilities: [],
        capabilityPolicy: "all",
        kind: "authenticated",
        principalKinds: ["session"],
    },
    domain: "system",
    errors: ["FORBIDDEN", "UNAUTHORIZED"],
    input: emptyInputSchema,
    inputSchemaId: "system.healthDiagnostics.input",
    kind: "query",
    name: "system.healthDiagnostics",
    output: systemHealthDiagnosticsSchema,
    outputSchemaId: "system.healthDiagnostics.output",
    summary:
        "Returns bounded readiness, dependency, and queue diagnostics without operational identities.",
    transport: {
        batching: "adapter-default",
        handler: "default",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

/** Implemented system tRPC contracts. */
export const systemProcedureContracts = [
    documentationReferenceContract,
    systemHealthDiagnosticsContract,
    systemMetricsContract,
    runtimeIdentityContract,
] as const;

/** Implemented raw health-route contracts. */
export const systemRawHttpContracts = [
    {
        access: { kind: "public" },
        method: "GET",
        path: healthLivenessPath,
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: {
            contentTypes: ["application/json"],
            kind: "schema",
            schema: livenessStatusSchema,
            schemaId: "health.liveness.response",
        },
        statusCodes: [200],
        summary: "Confirms that the Bun web process can answer requests.",
    },
    {
        access: { kind: "public" },
        method: "HEAD",
        path: healthLivenessPath,
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: { kind: "none" },
        statusCodes: [200],
        summary: "Checks Bun web-process liveness without a response body.",
    },
    {
        access: { kind: "public" },
        method: "GET",
        path: healthReadinessPath,
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: {
            contentTypes: ["application/json"],
            kind: "schema",
            schema: readinessStatusSchema,
            schemaId: "health.readiness.response",
        },
        responseBodyStatusCodes: [200, 503],
        statusCodes: [200, 503],
        summary: "Reports whether critical application initialization is complete.",
    },
    {
        access: { kind: "public" },
        method: "HEAD",
        path: healthReadinessPath,
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: { kind: "none" },
        statusCodes: [200, 503],
        summary: "Checks application readiness without a response body.",
    },
] as const satisfies readonly RawHttpContract[];
