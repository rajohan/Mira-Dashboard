import {
    type SystemMetrics,
    systemHttpMetricOverflowProcedure,
    systemHttpMetricProcedureNames,
} from "../../contracts/system.ts";

type HttpMetricProcedure =
    SystemMetrics["application"]["http"]["procedures"][number]["procedure"];

function observedHttpMetric(procedure: HttpMetricProcedure) {
    if (procedure === "system.metrics") {
        return {
            errorCount: 0,
            maximumDurationMs: 48,
            procedure,
            requestCount: 25,
            totalDurationMs: 300,
        };
    }
    if (procedure === "overflow") {
        return {
            errorCount: 1,
            maximumDurationMs: 12,
            procedure,
            requestCount: 4,
            totalDurationMs: 24,
        };
    }
    return {
        errorCount: 0,
        maximumDurationMs: 0,
        procedure,
        requestCount: 0,
        totalDurationMs: 0,
    };
}

/** Canonical zero-state application projection for Storybook host-metric fixtures. */
export const unavailableStorySystemApplicationMetrics = {
    cache: { state: "unavailable" },
    chat: { state: "unavailable" },
    gateway: { state: "unavailable" },
    http: {
        procedures: [
            ...systemHttpMetricProcedureNames,
            systemHttpMetricOverflowProcedure,
        ].map((procedure) => ({
            errorCount: 0,
            maximumDurationMs: 0,
            procedure,
            requestCount: 0,
            totalDurationMs: 0,
        })),
        state: "observed",
    },
    jobs: { state: "unavailable" },
    operations: { state: "unavailable" },
    realtime: { state: "unavailable" },
    sqlite: { state: "unavailable" },
    web: { state: "unavailable" },
} satisfies SystemMetrics["application"];

/**
 * @param sampledAtMs Shared causal sample timestamp.
 * @returns Fully observed application metrics for material Storybook states.
 */
export function observedStorySystemApplicationMetrics(
    sampledAtMs: number
): SystemMetrics["application"] {
    return {
        cache: {
            entryCount: 14,
            failedEntryCount: 1,
            latestAttemptAtMs: sampledAtMs - 1000,
            maximumAttemptDurationMs: 240,
            missingEntryCount: 1,
            refreshAttemptCount: 58,
            snapshots: [
                {
                    attemptCount: 8,
                    consecutiveFailures: 0,
                    freshness: "fresh",
                    key: "system.host",
                    lastAttemptDurationMs: 24,
                    lastAttemptStatus: "succeeded",
                },
                {
                    attemptCount: 5,
                    consecutiveFailures: 1,
                    freshness: "stale",
                    key: "weather.spydeberg",
                    lastAttemptDurationMs: 240,
                    lastAttemptStatus: "failed",
                },
            ],
            staleEntryCount: 2,
            state: "observed",
        },
        chat: {
            activeRuns: 1,
            failedOrUnknownRuns: 2,
            retainedEventBytes: 48 * 1024,
            retainedEvents: 42,
            retainedRuns: 7,
            retainedSnapshotBytes: 12 * 1024,
            retainedSnapshots: 4,
            state: "observed",
        },
        gateway: {
            checkedAtMs: sampledAtMs,
            freshness: "fresh",
            lastActivityAtMs: sampledAtMs - 500,
            phase: "connected",
            reconnectAttempt: 0,
            state: "observed",
        },
        http: {
            procedures: [
                ...systemHttpMetricProcedureNames,
                systemHttpMetricOverflowProcedure,
            ].map((procedure) => observedHttpMetric(procedure)),
            state: "observed",
        },
        jobs: {
            claimingPaused: false,
            queuedRuns: 3,
            runningRuns: 2,
            scheduleLagMs: 1200,
            state: "observed",
            workers: { capacity: 4, draining: 1, online: 2 },
        },
        operations: {
            activeRuns: 2,
            averageDurationMs: 1200,
            failedRuns: 1,
            maximumDurationMs: 4500,
            sampledRuns: 12,
            state: "observed",
            succeededRuns: 9,
        },
        realtime: {
            activeSubscribers: 3,
            droppedSlowSubscribers: 1,
            forcedResyncs: 2,
            pollFailures: 1,
            polls: 120,
            retainedEvents: 42,
            state: "observed",
            subscriberCapacityRejections: 0,
            subscriptionReadFailures: 1,
            wakeups: 44,
        },
        sqlite: {
            freeBytes: 8 * 1024 ** 2,
            freePages: 2048,
            freePercent: 12.5,
            pageCount: 16_384,
            readLatencyMs: 3,
            state: "observed",
            storageBytes: 64 * 1024 ** 2,
        },
        web: {
            eventLoopDelayMs: 4,
            externalBytes: 16 * 1024 ** 2,
            heapTotalBytes: 96 * 1024 ** 2,
            heapUsedBytes: 48 * 1024 ** 2,
            rssBytes: 192 * 1024 ** 2,
            state: "observed",
            uptimeSeconds: 183_600,
        },
    };
}
