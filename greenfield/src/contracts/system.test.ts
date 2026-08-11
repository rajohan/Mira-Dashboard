import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    type SystemHealthDiagnostics,
    type SystemMetrics,
    systemHealthDiagnosticsContract,
    systemHealthDiagnosticsSchema,
    systemMetricsContract,
    systemMetricsSchema,
} from "./system.ts";

const metrics = Object.freeze({
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
