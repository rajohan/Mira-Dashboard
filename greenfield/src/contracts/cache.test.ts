import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    cacheEntrySchema,
    cacheHeartbeatResultSchema,
    cacheStatusMaximumEntries,
    cacheStatusResultSchema,
    refreshCacheEntryInputSchema,
    systemHostCachePayloadSchema,
} from "./cache.ts";

const runId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b4";

const successfulEntry = Object.freeze({
    consecutiveFailures: 0,
    expiresAtMs: 61_000,
    freshness: "fresh" as const,
    key: "system.host",
    lastAttemptAtMs: 1000,
    lastAttemptDurationMs: 25,
    lastAttemptNumber: 1,
    lastAttemptRunId: runId,
    lastAttemptStatus: "succeeded" as const,
    lastSuccessAtMs: 1000,
    manualRunAvailable: true,
    metadata: { provider: "node" },
    payload: { hostname: "dashboard" },
    schemaId: "system.host.v1",
    source: "system.host",
    updatedAtMs: 1000,
});

describe("cache contracts", () => {
    test("keeps freshness separate from the latest refresh outcome", () => {
        expect(v.parse(cacheEntrySchema, successfulEntry)).toEqual(successfulEntry);

        const staleAfterFailure = {
            ...successfulEntry,
            consecutiveFailures: 1,
            failureCode: "system.host/unavailable",
            failureMessage: "Host projection is temporarily unavailable.",
            freshness: "stale",
            lastAttemptAtMs: 62_000,
            lastAttemptRunId: "019fc968-1a9b-7766-9f1b-d5b863b0e7b4",
            lastAttemptStatus: "failed",
            updatedAtMs: 62_000,
        } as const;
        expect(v.parse(cacheEntrySchema, staleAfterFailure)).toEqual(staleAfterFailure);

        const missingAfterFailure = {
            consecutiveFailures: 1,
            failureCode: "system.host/unavailable",
            failureMessage: "Host projection is temporarily unavailable.",
            freshness: "missing",
            key: "system.host",
            lastAttemptAtMs: 1000,
            lastAttemptDurationMs: 25,
            lastAttemptNumber: 1,
            lastAttemptRunId: runId,
            lastAttemptStatus: "failed",
            manualRunAvailable: true,
            updatedAtMs: 1000,
        } as const;
        expect(v.parse(cacheEntrySchema, missingAfterFailure)).toEqual(
            missingAfterFailure
        );
    });

    test("rejects partial last-known-good state and inconsistent attempt fields", () => {
        for (const entry of [
            { ...successfulEntry, metadata: undefined },
            { ...successfulEntry, consecutiveFailures: 1 },
            { ...successfulEntry, freshness: "missing" },
            {
                ...successfulEntry,
                failureCode: "system.host/failed",
                failureMessage: "Failed.",
            },
            { ...successfulEntry, expiresAtMs: 1000 },
        ]) {
            expect(v.safeParse(cacheEntrySchema, entry).success).toBeFalse();
        }
    });

    test("caps status at 128 rows with an explicit total and truncation marker", () => {
        const entry = (({ payload: _payload, ...status }) => status)(successfulEntry);
        expect(
            v.parse(cacheStatusResultSchema, {
                entries: [entry],
                generatedAtMs: 1000,
                totalCount: 2,
                truncated: true,
            })
        ).toBeDefined();

        expect(
            v.safeParse(cacheStatusResultSchema, {
                entries: [entry],
                generatedAtMs: 1000,
                totalCount: 1,
                truncated: true,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(cacheStatusResultSchema, {
                entries: [entry],
                generatedAtMs: 61_000,
                totalCount: 1,
                truncated: false,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(cacheStatusResultSchema, {
                entries: [{ ...entry, freshness: "stale" }],
                generatedAtMs: 1000,
                totalCount: 1,
                truncated: false,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(cacheStatusResultSchema, {
                entries: Array.from(
                    { length: cacheStatusMaximumEntries + 1 },
                    () => entry
                ),
                generatedAtMs: 1000,
                totalCount: cacheStatusMaximumEntries + 1,
                truncated: false,
            }).success
        ).toBeFalse();
    });

    test("keeps heartbeat projections compact and freshness-consistent", () => {
        const heartbeat = {
            cache: {
                entries: [],
                generatedAtMs: 2000,
                totalCount: 0,
                truncated: false,
            },
            dashboardJobs: {
                items: [
                    {
                        defaultEnabled: true,
                        disableIntent: { expiresAtMs: 1800, valid: false },
                        enabled: false,
                        id: "cache.system-host",
                        latestRun: {
                            finishedAtMs: 1800,
                            firstStartedAtMs: 1600,
                            queuedAtMs: 1500,
                            state: "failed",
                            terminalCode: "provider-unavailable",
                            triggerType: "schedule",
                            updatedAtMs: 1800,
                        },
                        nextRunAtMs: null,
                        state: "present",
                    },
                    {
                        defaultEnabled: false,
                        id: "system.worker-smoke",
                        state: "missing",
                    },
                ],
                state: "available",
            },
            gateway: {
                connection: {
                    checkedAtMs: 2000,
                    freshness: "stale",
                    phase: "degraded",
                },
                sessions: {
                    count: 2,
                    observedAtMs: 1000,
                    staleSinceMs: 1500,
                    state: "last-known-good",
                    truncated: true,
                },
            },
            generatedAtMs: 2000,
            openClawCron: {
                count: 5,
                observedAtMs: 900,
                pendingSync: "unknown",
                staleSinceMs: 1500,
                state: "last-known-good",
            },
            schemaVersion: 2,
            tasks: {
                items: [
                    {
                        automation: { recurring: true },
                        id: "019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
                        priority: "high",
                        relevance: ["automation-linked", "agent-priority"],
                        status: "blocked",
                    },
                ],
                state: "available",
                totalCount: 1,
                truncated: false,
            },
        } as const;
        expect(v.parse(cacheHeartbeatResultSchema, heartbeat)).toEqual(heartbeat);

        for (const invalid of [
            {
                ...heartbeat,
                gateway: {
                    ...heartbeat.gateway,
                    sessions: {
                        count: 2,
                        observedAtMs: 1000,
                        state: "fresh",
                        truncated: false,
                    },
                },
            },
            {
                ...heartbeat,
                openClawCron: {
                    ...heartbeat.openClawCron,
                    staleSinceMs: 800,
                },
            },
            { ...heartbeat, generatedAtMs: 1999 },
            {
                ...heartbeat,
                openClawCron: { pendingSync: "none", state: "unavailable" },
            },
            {
                ...heartbeat,
                dashboardJobs: {
                    ...heartbeat.dashboardJobs,
                    items: [
                        {
                            ...heartbeat.dashboardJobs.items[0],
                            disableIntent: { expiresAtMs: 1800, valid: true },
                        },
                        heartbeat.dashboardJobs.items[1],
                    ],
                },
            },
            {
                ...heartbeat,
                tasks: { ...heartbeat.tasks, totalCount: 2, truncated: true },
            },
            {
                ...heartbeat,
                tasks: {
                    ...heartbeat.tasks,
                    items: [
                        {
                            ...heartbeat.tasks.items[0],
                            relevance: ["agent-priority", "automation-linked"],
                        },
                    ],
                },
            },
            {
                ...heartbeat,
                tasks: {
                    ...heartbeat.tasks,
                    items: [
                        {
                            ...heartbeat.tasks.items[0],
                            priority: "low",
                            relevance: ["automation-linked", "agent-priority"],
                        },
                    ],
                },
            },
            {
                ...heartbeat,
                tasks: {
                    ...heartbeat.tasks,
                    items: [
                        {
                            ...heartbeat.tasks.items[0],
                            relevance: ["automation-linked", "owner-blocked"],
                            status: "todo",
                        },
                    ],
                },
            },
            {
                ...heartbeat,
                dashboardJobs: {
                    items: [
                        {
                            defaultEnabled: true,
                            enabled: true,
                            id: "cache.system-host",
                            latestRun: heartbeat.dashboardJobs.items[0].latestRun,
                            nextRunAtMs: null,
                            state: "present",
                        },
                        heartbeat.dashboardJobs.items[1],
                    ],
                    state: "available",
                },
            },
            {
                ...heartbeat,
                dashboardJobs: {
                    items: [
                        {
                            activeRun: {
                                queuedAtMs: 1500,
                                state: "queued",
                                updatedAtMs: 1700,
                            },
                            defaultEnabled: true,
                            enabled: false,
                            id: "cache.system-host",
                            latestRun: heartbeat.dashboardJobs.items[0].latestRun,
                            nextRunAtMs: null,
                            state: "present",
                        },
                        heartbeat.dashboardJobs.items[1],
                    ],
                    state: "available",
                },
            },
            {
                ...heartbeat,
                dashboardJobs: {
                    items: [
                        {
                            defaultEnabled: true,
                            enabled: false,
                            id: "cache.system-host",
                            latestRun: {
                                queuedAtMs: 1500,
                                state: "queued",
                                triggerType: "schedule",
                                updatedAtMs: 1700,
                            },
                            nextRunAtMs: null,
                            state: "present",
                        },
                        heartbeat.dashboardJobs.items[1],
                    ],
                    state: "available",
                },
            },
            {
                ...heartbeat,
                dashboardJobs: {
                    items: [
                        {
                            defaultEnabled: true,
                            enabled: false,
                            id: "cache.system-host",
                            latestRun: heartbeat.dashboardJobs.items[0].latestRun,
                            nextRunAtMs: 2500,
                            state: "present",
                        },
                        heartbeat.dashboardJobs.items[1],
                    ],
                    state: "available",
                },
            },
            {
                ...heartbeat,
                dashboardJobs: {
                    items: [
                        {
                            defaultEnabled: true,
                            disableIntent: { expiresAtMs: 1800, valid: false },
                            enabled: true,
                            id: "cache.system-host",
                            latestRun: heartbeat.dashboardJobs.items[0].latestRun,
                            nextRunAtMs: 2500,
                            state: "present",
                        },
                        heartbeat.dashboardJobs.items[1],
                    ],
                    state: "available",
                },
            },
            {
                ...heartbeat,
                dashboardJobs: {
                    items: [
                        {
                            activeRun: {
                                queuedAtMs: 1500,
                                state: "running",
                                updatedAtMs: 1800,
                            },
                            defaultEnabled: true,
                            enabled: false,
                            id: "cache.system-host",
                            latestRun: {
                                queuedAtMs: 1500,
                                state: "running",
                                triggerType: "schedule",
                                updatedAtMs: 1800,
                            },
                            nextRunAtMs: null,
                            state: "present",
                        },
                        heartbeat.dashboardJobs.items[1],
                    ],
                    state: "available",
                },
            },
            {
                ...heartbeat,
                dashboardJobs: {
                    items: [
                        {
                            activeRun: {
                                queuedAtMs: 1500,
                                state: "queued",
                                updatedAtMs: 1700,
                            },
                            defaultEnabled: true,
                            enabled: false,
                            id: "cache.system-host",
                            latestRun: {
                                firstStartedAtMs: 1600,
                                queuedAtMs: 1500,
                                state: "running",
                                triggerType: "schedule",
                                updatedAtMs: 1800,
                            },
                            nextRunAtMs: null,
                            state: "present",
                        },
                        heartbeat.dashboardJobs.items[1],
                    ],
                    state: "available",
                },
            },
        ]) {
            expect(v.safeParse(cacheHeartbeatResultSchema, invalid).success).toBeFalse();
        }
    });

    test("accepts only canonical lost-response-safe refresh requests", () => {
        expect(
            v.parse(refreshCacheEntryInputSchema, {
                idempotencyKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                key: "system.host",
            })
        ).toBeDefined();
        for (const key of ["System.Host", "system/host", " system.host"] as const) {
            expect(
                v.safeParse(refreshCacheEntryInputSchema, {
                    idempotencyKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                    key,
                }).success
            ).toBeFalse();
        }
    });

    test("locks the worker-only system.host projection to safe public scalars", () => {
        const payload = {
            architecture: "x64",
            disk: { freeBytes: 500, path: "/", totalBytes: 1000 },
            hostname: "dashboard",
            memory: { freeBytes: 1000, totalBytes: 2000 },
            platform: "linux",
            release: "6.8.0",
            uptimeSeconds: 60,
        };
        expect(v.parse(systemHostCachePayloadSchema, payload)).toEqual(payload);
        for (const invalid of [
            { ...payload, uptimeSeconds: 0.5 },
            { ...payload, memory: { freeBytes: 2001, totalBytes: 2000 } },
            { ...payload, disk: { freeBytes: 500, path: "/tmp", totalBytes: 1000 } },
            { ...payload, hostname: "host\nforged" },
        ]) {
            expect(
                v.safeParse(systemHostCachePayloadSchema, invalid).success
            ).toBeFalse();
        }
    });
});
