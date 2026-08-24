import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    type SystemHealthDiagnostics,
    type SystemMetrics,
    systemHttpMetricOverflowProcedure,
    systemHttpMetricProcedureNames,
    systemHealthDiagnosticsContract,
    systemHealthDiagnosticsSchema,
    systemMetricsContract,
    systemMetricsSchema,
} from "./system.ts";

const metrics = Object.freeze({
    application: {
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
    },
    cpu: {
        loadAverage: [2, 1, 0.5],
        loadPercent: 50,
        logicalCoreCount: 4,
    },
    disk: {
        freeBytes: 400,
        totalBytes: 1000,
        usedBytes: 600,
        usedPercent: 60,
    },
    freshness: "fresh",
    memory: {
        freeBytes: 250,
        totalBytes: 1000,
        usedBytes: 750,
        usedPercent: 75,
    },
    network: {
        downloadBitsPerSecond: 800,
        state: "ready",
        uploadBitsPerSecond: 400,
    },
    sampledAtMs: 1_800_000_000_000,
    uptimeSeconds: 12,
} as const satisfies SystemMetrics);

const healthDiagnostics = Object.freeze({
    checkedAtMs: 1_800_000_000_000,
    checks: {
        application: { status: "ready" },
        database: { status: "ready" },
        frontend: { status: "ready" },
        release: { status: "verified" },
        worker: { status: "ready" },
    },
    dependencies: {
        gateway: {
            freshness: "fresh",
            phase: "connected",
            status: "observed",
        },
        sessions: {
            count: 2,
            observedAtMs: 1_800_000_000_000,
            state: "fresh",
            truncated: false,
        },
    },
    queue: {
        claimingPaused: false,
        oldestQueuedAtMs: 1_799_999_999_000,
        runs: { queued: 1, running: 1 },
        status: "observed",
        workers: {
            capacity: 2,
            drainingCount: 0,
            freshCount: 1,
            onlineCount: 1,
        },
    },
    status: "ready",
} as const satisfies SystemHealthDiagnostics);

describe("system health diagnostics contract", () => {
    test("accepts one bounded identity-free readiness and queue projection", () => {
        expect(v.parse(systemHealthDiagnosticsSchema, healthDiagnostics)).toEqual(
            healthDiagnostics
        );
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                hostname: "private-host",
            })
        ).toThrow();
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: {
                    ...healthDiagnostics.queue,
                    workers: {
                        ...healthDiagnostics.queue.workers,
                        workerId: "private-worker",
                    },
                },
            })
        ).toThrow();
    });

    test("rejects inconsistent aggregate and worker states", () => {
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                status: "not-ready",
            })
        ).toThrow("aggregate is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: { status: "unavailable" },
            })
        ).toThrow("aggregate is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: {
                    ...healthDiagnostics.queue,
                    workers: {
                        capacity: 0,
                        drainingCount: 0,
                        freshCount: 0,
                        onlineCount: 0,
                    },
                },
            })
        ).toThrow("aggregate is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: {
                    ...healthDiagnostics.queue,
                    workers: {
                        ...healthDiagnostics.queue.workers,
                        freshCount: 2,
                    },
                },
            })
        ).toThrow("worker projection is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: {
                    ...healthDiagnostics.queue,
                    workers: {
                        capacity: 33,
                        drainingCount: 0,
                        freshCount: 33,
                        onlineCount: 33,
                    },
                },
            })
        ).toThrow("worker count is outside its budget");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: {
                    ...healthDiagnostics.queue,
                    workers: {
                        ...healthDiagnostics.queue.workers,
                        capacity: 0,
                    },
                },
            })
        ).toThrow("worker projection is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: {
                    ...healthDiagnostics.queue,
                    workers: {
                        ...healthDiagnostics.queue.workers,
                        capacity: 17,
                    },
                },
            })
        ).toThrow("worker projection is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                checks: {
                    ...healthDiagnostics.checks,
                    release: { status: "unavailable" },
                },
                status: "not-ready",
            })
        ).toThrow("aggregate is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                checks: {
                    ...healthDiagnostics.checks,
                    worker: { status: "unavailable" },
                },
                status: "not-ready",
            })
        ).toThrow("aggregate is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                dependencies: {
                    ...healthDiagnostics.dependencies,
                    gateway: {
                        freshness: "stale",
                        phase: "connected",
                        status: "observed",
                    },
                },
            })
        ).toThrow("Gateway projection is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                dependencies: {
                    ...healthDiagnostics.dependencies,
                    gateway: {
                        freshness: "stale",
                        phase: "degraded",
                        status: "observed",
                    },
                },
            })
        ).toThrow("aggregate is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                dependencies: {
                    ...healthDiagnostics.dependencies,
                    sessions: {
                        ...healthDiagnostics.dependencies.sessions,
                        observedAtMs: healthDiagnostics.checkedAtMs + 1,
                    },
                },
            })
        ).toThrow("aggregate is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: {
                    ...healthDiagnostics.queue,
                    runs: { ...healthDiagnostics.queue.runs, queued: 0 },
                },
            })
        ).toThrow("queue projection is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                queue: {
                    ...healthDiagnostics.queue,
                    oldestQueuedAtMs: healthDiagnostics.checkedAtMs + 1,
                },
            })
        ).toThrow("aggregate is inconsistent");
    });

    test("rejects inconsistent last-known-good session timestamps", () => {
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                dependencies: {
                    ...healthDiagnostics.dependencies,
                    sessions: {
                        count: 2,
                        observedAtMs: healthDiagnostics.checkedAtMs,
                        staleSinceMs: healthDiagnostics.checkedAtMs - 1,
                        state: "last-known-good",
                        truncated: false,
                    },
                },
            })
        ).toThrow("session projection is inconsistent");
        expect(() =>
            v.parse(systemHealthDiagnosticsSchema, {
                ...healthDiagnostics,
                dependencies: {
                    ...healthDiagnostics.dependencies,
                    sessions: {
                        count: 2,
                        observedAtMs: healthDiagnostics.checkedAtMs,
                        staleSinceMs: healthDiagnostics.checkedAtMs + 1,
                        state: "last-known-good",
                        truncated: false,
                    },
                },
            })
        ).toThrow("aggregate is inconsistent");
    });

    test("is browser-session-only without automation or control authority", () => {
        expect(systemHealthDiagnosticsContract.access).toEqual({
            capabilities: [],
            capabilityPolicy: "all",
            kind: "authenticated",
            principalKinds: ["session"],
        });
        expect(systemHealthDiagnosticsContract.errors).toEqual([
            "FORBIDDEN",
            "UNAUTHORIZED",
        ]);
    });
});

describe("system metrics contract", () => {
    test("accepts only the bounded identity-free operational projection", () => {
        expect(v.parse(systemMetricsSchema, metrics)).toEqual(metrics);
        expect(() =>
            v.parse(systemMetricsSchema, { ...metrics, hostname: "private-host" })
        ).toThrow();
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                cpu: { ...metrics.cpu, model: "private-model" },
            })
        ).toThrow();
    });

    test("rejects inconsistent capacities and invalid rates", () => {
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                memory: { ...metrics.memory, usedBytes: 749 },
            })
        ).toThrow("capacity fields are inconsistent");
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                network: { ...metrics.network, downloadBitsPerSecond: -1 },
            })
        ).toThrow();
    });

    test("bounds sanitized operation, chat, and registered cache diagnostics", () => {
        const application = {
            ...metrics.application,
            cache: {
                entryCount: 2,
                failedEntryCount: 1,
                maximumAttemptDurationMs: 25,
                missingEntryCount: 0,
                refreshAttemptCount: 3,
                snapshots: [
                    {
                        attemptCount: 2,
                        consecutiveFailures: 0,
                        freshness: "fresh",
                        key: "system.host",
                        lastAttemptDurationMs: 10,
                        lastAttemptStatus: "succeeded",
                    },
                    {
                        attemptCount: 1,
                        consecutiveFailures: 1,
                        freshness: "stale",
                        key: "weather.spydeberg",
                        lastAttemptDurationMs: 25,
                        lastAttemptStatus: "failed",
                    },
                ],
                staleEntryCount: 1,
                state: "observed",
            },
            chat: {
                activeRuns: 1,
                failedOrUnknownRuns: 1,
                retainedEventBytes: 500,
                retainedEvents: 5,
                retainedRuns: 2,
                retainedSnapshotBytes: 200,
                retainedSnapshots: 1,
                state: "observed",
            },
            operations: {
                activeRuns: 1,
                averageDurationMs: 900,
                failedRuns: 1,
                maximumDurationMs: 1000,
                sampledRuns: 3,
                state: "observed",
                succeededRuns: 1,
            },
        } as const;

        expect(v.parse(systemMetricsSchema, { ...metrics, application })).toMatchObject({
            application,
        });
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                application: {
                    ...application,
                    operations: { ...application.operations, sampledRuns: 4 },
                },
            })
        ).toThrow("operation metrics are inconsistent");
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                application: {
                    ...application,
                    cache: {
                        ...application.cache,
                        snapshots: application.cache.snapshots.toReversed(),
                    },
                },
            })
        ).toThrow("not canonically ordered");
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                application: {
                    ...application,
                    chat: { ...application.chat, activeRuns: 3 },
                },
            })
        ).toThrow("chat metrics are inconsistent");
    });

    test("is browser-session-only without an automation capability", () => {
        expect(systemMetricsContract.access).toEqual({
            capabilities: [],
            capabilityPolicy: "all",
            kind: "authenticated",
            principalKinds: ["session"],
        });
        expect(systemMetricsContract.errors).toEqual([
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ]);
    });
});
