import * as v from "valibot";

import { jobExecutionSummarySchema } from "./jobs";
import { finiteNumberSchema, parseContract } from "./runtime";

const numberRecordSchema = v.record(v.string(), finiteNumberSchema);

export const childProcessMetricsSchema = v.strictObject({
    active: finiteNumberSchema,
    averageDurationMs: finiteNumberSchema,
    failed: finiteNumberSchema,
    lastDurationMs: finiteNumberSchema,
    maxDurationMs: finiteNumberSchema,
    started: finiteNumberSchema,
    succeeded: finiteNumberSchema,
    totalDurationMs: finiteNumberSchema,
});

export const coalescedSnapshotMetricsSchema = v.strictObject({
    activeLoads: finiteNumberSchema,
    averageLoadMs: finiteNumberSchema,
    coalescedHits: finiteNumberSchema,
    failures: finiteNumberSchema,
    freshHits: finiteNumberSchema,
    lastLoadMs: finiteNumberSchema,
    loads: finiteNumberSchema,
    name: v.string(),
    requests: finiteNumberSchema,
    staleHits: finiteNumberSchema,
});

export const httpRouteMetricsSchema = v.strictObject({
    averageDurationMs: finiteNumberSchema,
    errors: finiteNumberSchema,
    maxDurationMs: finiteNumberSchema,
    method: v.string(),
    requests: finiteNumberSchema,
    route: v.string(),
    statusCodes: numberRecordSchema,
});

export const httpRequestMetricsSchema = v.strictObject({
    averageDurationMs: finiteNumberSchema,
    errors: finiteNumberSchema,
    maxDurationMs: finiteNumberSchema,
    requests: finiteNumberSchema,
    routes: v.array(httpRouteMetricsSchema),
});

export const runtimeMetricsSchema = v.strictObject({
    eventLoopDelayMs: finiteNumberSchema,
    externalBytes: finiteNumberSchema,
    heapTotalBytes: finiteNumberSchema,
    heapUsedBytes: finiteNumberSchema,
    rssBytes: finiteNumberSchema,
    uptimeSeconds: finiteNumberSchema,
});

export const cacheRefreshMetricsSchema = v.strictObject({
    active: finiteNumberSchema,
    averageDurationMs: finiteNumberSchema,
    coalesced: finiteNumberSchema,
    failures: finiteNumberSchema,
    lastDurationMs: finiteNumberSchema,
    maxDurationMs: finiteNumberSchema,
    refreshes: finiteNumberSchema,
    requests: finiteNumberSchema,
    totalDurationMs: finiteNumberSchema,
});

export const databaseMetricsSchema = v.strictObject({
    available: v.boolean(),
    averageDurationMs: finiteNumberSchema,
    fileBytes: finiteNumberSchema,
    freelistBytes: finiteNumberSchema,
    freelistPages: finiteNumberSchema,
    freelistPercent: finiteNumberSchema,
    latencyMs: finiteNumberSchema,
    lockErrors: finiteNumberSchema,
    maxDurationMs: finiteNumberSchema,
    operations: finiteNumberSchema,
    shmBytes: finiteNumberSchema,
    walBytes: finiteNumberSchema,
});

export const gatewayMetricsSchema = v.strictObject({
    connectFailures: finiteNumberSchema,
    connected: v.boolean(),
    connections: finiteNumberSchema,
    disconnects: finiteNumberSchema,
    lastConnectedAt: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    lastDisconnectedAt: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    pendingRequests: finiteNumberSchema,
    reconnects: finiteNumberSchema,
});

export const schedulerMetricsSchema = v.strictObject({
    ...jobExecutionSummarySchema.entries,
    dueJobs: finiteNumberSchema,
    executorActive: v.boolean(),
    executorTickRunning: v.boolean(),
    lastTickAt: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    lastTickDurationMs: finiteNumberSchema,
    oldestDueAt: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    queueFailures: finiteNumberSchema,
    scheduleLagMs: finiteNumberSchema,
    schedulerActive: v.boolean(),
    schedulerTickRunning: v.boolean(),
    tickFailures: finiteNumberSchema,
    ticks: finiteNumberSchema,
});

export const appObservabilityMetricsSchema = v.strictObject({
    cacheRefresh: cacheRefreshMetricsSchema,
    database: databaseMetricsSchema,
    gateway: gatewayMetricsSchema,
    processes: childProcessMetricsSchema,
    runtime: runtimeMetricsSchema,
    scheduler: schedulerMetricsSchema,
});

const tokenAgentMetricsSchema = v.strictObject({
    label: v.string(),
    model: v.string(),
    tokens: finiteNumberSchema,
    type: v.string(),
});

export const metricsSchema = v.strictObject({
    ...appObservabilityMetricsSchema.entries,
    cpu: v.strictObject({
        count: finiteNumberSchema,
        loadAvg: v.array(finiteNumberSchema),
        loadPercent: finiteNumberSchema,
        model: v.string(),
    }),
    disk: v.strictObject({
        percent: finiteNumberSchema,
        total: finiteNumberSchema,
        totalGB: finiteNumberSchema,
        used: finiteNumberSchema,
        usedGB: finiteNumberSchema,
    }),
    http: httpRequestMetricsSchema,
    memory: v.strictObject({
        free: finiteNumberSchema,
        percent: finiteNumberSchema,
        total: finiteNumberSchema,
        totalGB: finiteNumberSchema,
        used: finiteNumberSchema,
        usedGB: finiteNumberSchema,
    }),
    network: v.strictObject({
        downloadMbps: finiteNumberSchema,
        uploadMbps: finiteNumberSchema,
    }),
    polling: v.strictObject({
        snapshots: v.array(coalescedSnapshotMetricsSchema),
    }),
    system: v.strictObject({
        hostname: v.string(),
        platform: v.string(),
        uptime: finiteNumberSchema,
    }),
    timestamp: finiteNumberSchema,
    tokens: v.strictObject({
        byAgent: v.array(tokenAgentMetricsSchema),
        byModel: numberRecordSchema,
        sessionsByModel: numberRecordSchema,
        total: finiteNumberSchema,
    }),
});

export type ChildProcessMetrics = v.InferOutput<typeof childProcessMetricsSchema>;
export type CoalescedSnapshotMetrics = v.InferOutput<
    typeof coalescedSnapshotMetricsSchema
>;
export type HttpRouteMetrics = v.InferOutput<typeof httpRouteMetricsSchema>;
export type HttpRequestMetrics = v.InferOutput<typeof httpRequestMetricsSchema>;
export type RuntimeMetrics = v.InferOutput<typeof runtimeMetricsSchema>;
export type CacheRefreshMetrics = v.InferOutput<typeof cacheRefreshMetricsSchema>;
export type DatabaseMetrics = v.InferOutput<typeof databaseMetricsSchema>;
export type GatewayMetrics = v.InferOutput<typeof gatewayMetricsSchema>;
export type SchedulerMetrics = v.InferOutput<typeof schedulerMetricsSchema>;
export type AppObservabilityMetrics = v.InferOutput<typeof appObservabilityMetricsSchema>;
export type Metrics = v.InferOutput<typeof metricsSchema>;

/**
 * Parses the observability subset shared by diagnostics and metrics.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the observability subset shared by diagnostics and metrics.
 */
export function parseAppObservabilityMetrics(
    value: unknown,
    path = "response.observability"
): AppObservabilityMetrics {
    return parseContract(appObservabilityMetricsSchema, value, path);
}

/**
 * Parses the authenticated metrics response before frontend state accepts it.
 * @param value Value to process.
 * @returns Parsed the authenticated metrics response before frontend state accepts it.
 */
export function parseMetricsResponse(value: unknown): Metrics {
    return parseContract(metricsSchema, value, "response");
}
