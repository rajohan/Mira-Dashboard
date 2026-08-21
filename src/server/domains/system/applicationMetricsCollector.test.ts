import { describe, expect, test } from "bun:test";

import type { DatabaseRuntimeObservation } from "../../database/runtime/databaseService.ts";
import type { RealtimeEventPumpMetrics } from "../../platform/realtime/eventPump.ts";
import {
    createSystemApplicationMetricsReader,
    type SystemApplicationMetricsReaderDependencies,
} from "./applicationMetricsCollector.ts";

const realtimeMetrics = {
    activeSubscribers: 2,
    deliveryPreparationFailures: 0,
    droppedSlowSubscribers: 1,
    forcedResyncs: 3,
    latestIssuedId: 20,
    maximumCatchUpBatchSize: 4,
    maximumObservedQueueDepth: 2,
    maximumObservedQueuedDeliveryBytes: 200,
    newestRetainedId: 20,
    oldestRequiredCursor: 10,
    oldestRetainedId: 8,
    pollFailures: 5,
    polls: 40,
    retainedEventsSample: { count: 12, sampledAtMs: 9000 },
    retryablePollRetries: 2,
    retryableSubscriptionReadRetries: 1,
    subscriptionReadFailures: 4,
    subscriberCapacityRejections: 6,
    topicFilteredDeliveries: 7,
    wakeups: 8,
} as const satisfies RealtimeEventPumpMetrics;

function dependencies(): SystemApplicationMetricsReaderDependencies {
    return {
        cacheRepository: {
            readStatus: () => ({
                entries: [
                    {
                        consecutiveFailures: 1,
                        expiresAt: new Date(9000),
                        key: "system.host",
                        lastAttemptAt: new Date(8000),
                        lastAttemptDurationMs: 25,
                        lastAttemptNumber: 3,
                        lastAttemptStatus: "failed",
                    },
                    {
                        consecutiveFailures: 0,
                        expiresAt: null,
                        key: "weather.spydeberg",
                        lastAttemptAt: new Date(7000),
                        lastAttemptDurationMs: 10,
                        lastAttemptNumber: 2,
                        lastAttemptStatus: "succeeded",
                    },
                ].toReversed() as never,
                totalCount: 2,
            }),
        },
        chatReader: {
            readMetrics: () => ({
                activeRuns: 1,
                failedOrUnknownRuns: 2,
                retainedEventBytes: 500,
                retainedEvents: 5,
                retainedRuns: 4,
                retainedSnapshotBytes: 200,
                retainedSnapshots: 3,
            }),
        },
        databaseDiagnostics: () =>
            Promise.resolve({
                sqlite: {
                    freeBytes: 200,
                    freePages: 2,
                    freePercent: 20,
                    pageCount: 10,
                    storageBytes: 1000,
                },
            } as DatabaseRuntimeObservation),
        gatewayConnectionService: {
            get: () => ({
                checkedAtMs: 10_000,
                connectionGeneration: 1,
                freshness: "fresh",
                lastActivityAtMs: 9900,
                phase: "connected",
                reconnectAttempt: 0,
            }),
        },
        jobReader: {
            listDueSchedules: () => [{ nextRunAt: new Date(9500) }] as never,
            listRuns: () =>
                [
                    {
                        finishedAt: new Date(9900),
                        firstStartedAt: new Date(9000),
                        queuedAt: new Date(8900),
                        state: "succeeded",
                    },
                    {
                        finishedAt: new Date(9800),
                        firstStartedAt: new Date(8800),
                        queuedAt: new Date(8700),
                        state: "failed",
                    },
                    {
                        finishedAt: null,
                        firstStartedAt: new Date(9700),
                        queuedAt: new Date(9600),
                        state: "running",
                    },
                ] as never,
            readHealthState: () =>
                ({
                    control: { claimingPaused: false },
                    queuedRunCount: 2,
                    runningRunCount: 1,
                    workers: {
                        capacity: 4,
                        drainingCount: 1,
                        exactReleaseOnline: true,
                        freshCount: 2,
                        onlineCount: 1,
                    },
                }) as never,
        },
        nowMs: () => 10_000,
        realtimeMetrics: () => Promise.resolve(realtimeMetrics),
    };
}

describe("application metrics collector", () => {
    test("collects bounded process, jobs, SQLite, Gateway, realtime, and cache signals", async () => {
        const result = await createSystemApplicationMetricsReader(dependencies())();

        expect(result.cache).toEqual({
            entryCount: 2,
            failedEntryCount: 1,
            latestAttemptAtMs: 8000,
            maximumAttemptDurationMs: 25,
            missingEntryCount: 1,
            refreshAttemptCount: 5,
            snapshots: [
                {
                    attemptCount: 3,
                    consecutiveFailures: 1,
                    freshness: "stale",
                    key: "system.host",
                    lastAttemptDurationMs: 25,
                    lastAttemptStatus: "failed",
                },
                {
                    attemptCount: 2,
                    consecutiveFailures: 0,
                    freshness: "missing",
                    key: "weather.spydeberg",
                    lastAttemptDurationMs: 10,
                    lastAttemptStatus: "succeeded",
                },
            ],
            staleEntryCount: 1,
            state: "observed",
        });
        expect(result.chat).toEqual({
            activeRuns: 1,
            failedOrUnknownRuns: 2,
            retainedEventBytes: 500,
            retainedEvents: 5,
            retainedRuns: 4,
            retainedSnapshotBytes: 200,
            retainedSnapshots: 3,
            state: "observed",
        });
        expect(result.operations).toEqual({
            activeRuns: 1,
            averageDurationMs: 950,
            failedRuns: 1,
            maximumDurationMs: 1000,
            sampledRuns: 3,
            state: "observed",
            succeededRuns: 1,
        });
        expect(result.jobs).toMatchObject({
            queuedRuns: 2,
            runningRuns: 1,
            scheduleLagMs: 500,
            state: "observed",
            workers: { capacity: 4, draining: 1, online: 1 },
        });
        expect(result.sqlite).toMatchObject({
            freeBytes: 200,
            freePages: 2,
            pageCount: 10,
            state: "observed",
            storageBytes: 1000,
        });
        expect(result.gateway).toMatchObject({
            phase: "connected",
            reconnectAttempt: 0,
            state: "observed",
        });
        expect(result.realtime).toMatchObject({
            activeSubscribers: 2,
            pollFailures: 5,
            polls: 40,
            retainedEvents: 12,
            state: "observed",
        });
        expect(result.web).toMatchObject({ state: "observed" });
    });

    test("contains every component failure independently", async () => {
        const source = dependencies();
        const result = await createSystemApplicationMetricsReader({
            ...source,
            cacheRepository: {
                readStatus: () => {
                    throw new Error("cache row payload");
                },
            },
            chatReader: {
                readMetrics: () => {
                    throw new Error("private chat row");
                },
            },
            databaseDiagnostics: () => Promise.reject(new Error("private path")),
            jobReader: {
                ...source.jobReader,
                listRuns: () => {
                    throw new Error("private operation row");
                },
            },
            realtimeMetrics: () => Promise.reject(new Error("retained rows")),
        })();

        expect(result.cache).toEqual({ state: "unavailable" });
        expect(result.chat).toEqual({ state: "unavailable" });
        expect(result.operations).toEqual({ state: "unavailable" });
        expect(result.sqlite).toEqual({ state: "unavailable" });
        expect(result.realtime).toEqual({ state: "unavailable" });
        expect(result.gateway.state).toBe("observed");
        expect(result.jobs.state).toBe("observed");
        expect(result.web.state).toBe("observed");
        expect(JSON.stringify(result)).not.toContain("private path");
    });
});
