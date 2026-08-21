import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { databaseObservabilityCacheSchemaId } from "../../../contracts/database.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createJobRepository } from "../jobs/repository.ts";
import { reconcileJobSchedules } from "../jobs/service.ts";
import { CacheConflictError, CacheNotFoundError } from "./errors.ts";
import type { CacheEntryRecord, CacheRepository } from "./repository.ts";
import { createCacheRepository } from "./repository.ts";
import { createCacheService } from "./service.ts";

function uuid(index: number): string {
    return `019fdf40-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function principal(index: number): AuthenticatedPrincipal {
    return {
        authenticatorId: "a".repeat(32),
        authorizationVersion: 1,
        capabilities: ["cache:read", "cache:write"],
        id: uuid(index),
        kind: "session",
    };
}

const record: CacheEntryRecord = {
    consecutiveFailures: 1,
    expiresAt: new Date(5000),
    failureCode: "provider/system-host-unavailable",
    failureMessage: "System host projection could not be collected.",
    key: "system.host",
    lastAttemptAt: new Date(4000),
    lastAttemptDurationMs: 7,
    lastAttemptNumber: 2,
    lastAttemptRunId: uuid(20),
    lastAttemptStatus: "failed",
    lastSuccessAt: new Date(3000),
    metadataJson: '{"kind":"host"}',
    payloadJson:
        '{"architecture":"x64","disk":{"freeBytes":500,"path":"/","totalBytes":1000},"hostname":"dashboard-host","memory":{"freeBytes":400,"totalBytes":1000},"platform":"linux","release":"6.8.0","uptimeSeconds":12}',
    schemaId: "system.host.v1",
    source: "system.host",
    updatedAt: new Date(4000),
};

function readOnlyCacheRepository(entry: CacheEntryRecord): CacheRepository {
    return {
        commitAttempt: () => Promise.reject(new Error("Unexpected cache write")),
        findEntry: (key) => (key === entry.key ? entry : undefined),
        readStatus: () => ({ entries: [entry], totalCount: 129 }),
    };
}

describe("cache service", () => {
    test("does not expose a domain-only database payload through generic cache reads", async () => {
        const databaseRecord: CacheEntryRecord = {
            ...record,
            key: "database.observability",
            schemaId: databaseObservabilityCacheSchemaId,
            source: "postgresql.pgbouncer",
        };
        const cacheRepository = readOnlyCacheRepository(databaseRecord);
        const service = createCacheService({
            cacheRepository: {
                ...cacheRepository,
                findEntry: () => {
                    throw new Error("Domain-only payload repository was read");
                },
            },
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 4500,
        });

        expect(
            Effect.runPromise(service.getEntry({ key: "database.observability" }))
        ).rejects.toBeInstanceOf(CacheNotFoundError);
        expect(
            Effect.runPromise(service.getEntry({ key: "retired.provider" }))
        ).rejects.toBeInstanceOf(CacheNotFoundError);
        expect(await Effect.runPromise(service.getStatus())).toMatchObject({
            entries: [
                {
                    key: "database.observability",
                    manualRunAvailable: false,
                },
            ],
        });
    });

    test("derives freshness independently from a failed latest attempt", async () => {
        let currentTime = 4500;
        const service = createCacheService({
            cacheRepository: readOnlyCacheRepository(record),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => currentTime,
        });
        const fresh = await Effect.runPromise(service.getEntry({ key: "system.host" }));
        expect(fresh).toMatchObject({
            freshness: "fresh",
            lastAttemptStatus: "failed",
            manualRunAvailable: true,
        });
        currentTime = 5000;
        expect(
            await Effect.runPromise(service.getEntry({ key: "system.host" }))
        ).toMatchObject({ freshness: "stale", lastAttemptStatus: "failed" });
        expect(await Effect.runPromise(service.getStatus())).toMatchObject({
            entries: [{ freshness: "stale", key: "system.host" }],
            generatedAtMs: 5000,
            totalCount: 129,
            truncated: true,
        });
        currentTime = 3500;
        expect(await Effect.runPromise(service.getStatus())).toMatchObject({
            entries: [{ freshness: "fresh", key: "system.host" }],
            generatedAtMs: 4000,
        });
        const missingFailure = {
            ...record,
            expiresAt: null,
            lastSuccessAt: null,
            metadataJson: null,
            payloadJson: null,
            schemaId: null,
            source: null,
        };
        const missingService = createCacheService({
            cacheRepository: readOnlyCacheRepository(missingFailure),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 6000,
        });
        const missing = await Effect.runPromise(
            missingService.getEntry({ key: "system.host" })
        );
        expect(missing).toMatchObject({
            freshness: "missing",
            lastAttemptStatus: "failed",
        });
        expect("payload" in missing).toBe(false);
        const regressedClockService = createCacheService({
            cacheRepository: readOnlyCacheRepository({
                ...record,
                expiresAt: new Date(3800),
            }),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 3500,
        });
        expect(
            await Effect.runPromise(
                regressedClockService.getEntry({ key: "system.host" })
            )
        ).toMatchObject({ freshness: "stale", updatedAtMs: 4000 });
        expect(
            Effect.runPromise(service.getEntry({ key: "missing" }))
        ).rejects.toBeInstanceOf(CacheNotFoundError);
    });

    test("composes compact cached Gateway projections without upstream row reads", async () => {
        const calls: string[] = [];
        const service = createCacheService({
            cacheRepository: readOnlyCacheRepository(record),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 5000,
            readGatewayConnection: () => {
                calls.push("connection");
                return {
                    checkedAtMs: 5000,
                    freshness: "fresh",
                    phase: "connected",
                };
            },
            readGatewaySessionsProjection: () => {
                calls.push("sessions");
                return {
                    count: 3,
                    observedAtMs: 4500,
                    state: "fresh",
                    truncated: true,
                };
            },
            readHeartbeatDashboardJobs: (generatedAtMs) => {
                calls.push("dashboard-jobs");
                return {
                    dashboardJobs: { items: [], state: "available" },
                    generatedAtMs,
                };
            },
            readHeartbeatTasks: () => {
                calls.push("tasks");
                return {
                    items: [
                        {
                            automation: {
                                cron: {
                                    enabled: true,
                                    lastRunAtMs: 5100,
                                    nextRunAtMs: 9000,
                                    runningAtMs: 5200,
                                    state: "present" as const,
                                    synchronization: "confirmed" as const,
                                },
                                recurring: true,
                            },
                            id: uuid(40),
                            priority: "high" as const,
                            relevance: [
                                "automation-linked" as const,
                                "agent-priority" as const,
                            ],
                            status: "in-progress" as const,
                        },
                    ],
                    state: "available",
                    totalCount: 1,
                    truncated: false,
                };
            },
            readOpenClawCronProjection: () => {
                calls.push("cron");
                return {
                    count: 7,
                    health: {
                        disabledCount: 0,
                        enabledCount: 7,
                        inspectedCount: 7,
                        intendedDisabledCount: 0,
                        lastRunErrorCount: 0,
                        runningCount: 0,
                        staleRunningCount: 0,
                        synchronizationConflictCount: 1,
                        synchronizationPendingCount: 0,
                        truncated: false,
                        unexpectedDisabledCount: 0,
                    },
                    observedAtMs: 4600,
                    pendingSync: "present",
                    state: "fresh",
                };
            },
        });

        const heartbeat = await Effect.runPromise(service.getHeartbeat());
        expect(calls).toEqual([
            "connection",
            "sessions",
            "tasks",
            "cron",
            "dashboard-jobs",
        ]);
        expect(heartbeat).toMatchObject({
            cache: {
                entries: [{ freshness: "stale", key: "system.host" }],
                generatedAtMs: 5000,
                totalCount: 129,
                truncated: true,
            },
            dashboardJobs: { items: [], state: "available" },
            gateway: {
                connection: {
                    checkedAtMs: 5000,
                    freshness: "fresh",
                    phase: "connected",
                },
                sessions: {
                    count: 3,
                    observedAtMs: 4500,
                    state: "fresh",
                    truncated: true,
                },
            },
            generatedAtMs: 5200,
            openClawCron: {
                count: 7,
                observedAtMs: 4600,
                pendingSync: "present",
                state: "fresh",
            },
            schemaVersion: 5,
            tasks: {
                items: [
                    {
                        automation: {
                            cron: {
                                lastRunAtMs: 5100,
                                nextRunAtMs: 9000,
                                runningAtMs: 5200,
                            },
                        },
                    },
                ],
                state: "available",
                totalCount: 1,
                truncated: false,
            },
        });
        expect(JSON.stringify(heartbeat)).not.toContain("session-key");
    });

    test("demotes cached projections with connection loss and contains reader failures", async () => {
        const disconnected = createCacheService({
            cacheRepository: readOnlyCacheRepository(record),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 6000,
            readGatewayConnection: () => ({
                checkedAtMs: 6000,
                freshness: "stale",
                phase: "degraded",
            }),
            readGatewaySessionsProjection: () => ({
                count: 2,
                observedAtMs: 4000,
                state: "fresh",
                truncated: false,
            }),
            readHeartbeatTasks: () => ({
                items: [
                    {
                        automation: {
                            cron: {
                                enabled: true,
                                state: "present",
                                synchronization: "confirmed",
                            },
                            recurring: true,
                        },
                        id: "019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
                        priority: "high",
                        relevance: ["automation-linked", "agent-priority"],
                        status: "in-progress",
                    },
                ],
                state: "available",
                totalCount: 1,
                truncated: false,
            }),
            readOpenClawCronProjection: () => ({
                count: 4,
                health: {
                    disabledCount: 0,
                    enabledCount: 4,
                    inspectedCount: 4,
                    intendedDisabledCount: 0,
                    lastRunErrorCount: 0,
                    runningCount: 0,
                    staleRunningCount: 0,
                    synchronizationConflictCount: 0,
                    synchronizationPendingCount: 0,
                    truncated: false,
                    unexpectedDisabledCount: 0,
                },
                observedAtMs: 4500,
                pendingSync: "none",
                state: "fresh",
            }),
        });
        expect(await Effect.runPromise(disconnected.getHeartbeat())).toMatchObject({
            gateway: {
                sessions: {
                    staleSinceMs: 6000,
                    state: "last-known-good",
                },
            },
            openClawCron: {
                staleSinceMs: 6000,
                state: "last-known-good",
            },
            tasks: {
                items: [
                    {
                        automation: {
                            cron: { state: "unavailable" },
                        },
                    },
                ],
            },
        });

        const unavailable = createCacheService({
            cacheRepository: readOnlyCacheRepository(record),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 7000,
            readGatewayConnection: () => {
                throw new Error("private endpoint and token detail");
            },
            readGatewaySessionsProjection: () => {
                throw new Error("private session identity");
            },
            readOpenClawCronProjection: () => {
                throw new Error("private cron payload");
            },
            readHeartbeatDashboardJobs: () => ({
                dashboardJobs: {
                    items: [
                        {
                            defaultEnabled: true,
                            id: "cache.system-host",
                            state: "missing",
                        },
                        {
                            defaultEnabled: true,
                            id: "cache.system-host",
                            state: "missing",
                        },
                    ],
                    state: "available",
                },
                generatedAtMs: 7000,
            }),
            readHeartbeatTasks: () =>
                ({
                    items: [],
                    state: "available",
                    totalCount: 0,
                    truncated: true,
                }) as never,
        });
        expect(await Effect.runPromise(unavailable.getHeartbeat())).toMatchObject({
            gateway: {
                connection: { freshness: "unavailable", phase: "stopped" },
                sessions: { state: "unavailable" },
            },
            dashboardJobs: { state: "unavailable" },
            openClawCron: { pendingSync: "unknown", state: "unavailable" },
            tasks: { state: "unavailable" },
        });
    });

    test("contains malformed local heartbeat projections independently", async () => {
        const validTasks = {
            items: [],
            state: "available" as const,
            totalCount: 0,
            truncated: false,
        };
        const malformedTaskProjections = [
            {
                items: [],
                state: "available",
                totalCount: 0,
                truncated: true,
            },
            {
                items: [
                    {
                        id: uuid(30),
                        priority: "low",
                        relevance: ["agent-priority"],
                        status: "todo",
                    },
                ],
                state: "available",
                totalCount: 1,
                truncated: false,
            },
            {
                items: [
                    {
                        id: uuid(31),
                        priority: "low",
                        relevance: ["owner-blocked"],
                        status: "todo",
                    },
                ],
                state: "available",
                totalCount: 1,
                truncated: false,
            },
        ] as const;
        for (const [index, tasks] of malformedTaskProjections.entries()) {
            const service = createCacheService({
                cacheRepository: readOnlyCacheRepository(record),
                jobRepository: Object.freeze({}) as never,
                nowMs: () => 7000,
                readHeartbeatDashboardJobs: (generatedAtMs) => ({
                    dashboardJobs: { items: [], state: "available" },
                    generatedAtMs,
                }),
                readHeartbeatTasks: () => tasks as never,
            });
            expect(
                await Effect.runPromise(service.getHeartbeat()),
                `malformed task projection ${index}`
            ).toMatchObject({
                dashboardJobs: { items: [], state: "available" },
                tasks: { state: "unavailable" },
            });
        }

        const malformedDashboardJobProjections = [
            {
                items: [
                    {
                        defaultEnabled: true,
                        id: "cache.system-host",
                        state: "missing",
                    },
                    {
                        defaultEnabled: true,
                        id: "cache.system-host",
                        state: "missing",
                    },
                ],
                state: "available",
            },
            {
                items: [
                    {
                        defaultEnabled: true,
                        enabled: true,
                        id: "cache.system-host",
                        nextRunAtMs: null,
                        state: "present",
                    },
                ],
                state: "available",
            },
            {
                items: [
                    {
                        defaultEnabled: true,
                        enabled: false,
                        id: "cache.system-host",
                        nextRunAtMs: 8000,
                        state: "present",
                    },
                ],
                state: "available",
            },
            {
                items: [
                    {
                        defaultEnabled: true,
                        disableIntent: { expiresAtMs: 8000, valid: true },
                        enabled: true,
                        id: "cache.system-host",
                        nextRunAtMs: 8000,
                        state: "present",
                    },
                ],
                state: "available",
            },
            {
                items: [
                    {
                        activeRun: {
                            queuedAtMs: 6000,
                            state: "queued",
                            updatedAtMs: 6200,
                        },
                        defaultEnabled: true,
                        enabled: false,
                        id: "cache.system-host",
                        latestRun: {
                            finishedAtMs: 6500,
                            firstStartedAtMs: 6100,
                            queuedAtMs: 6000,
                            state: "failed",
                            terminalCode: "provider-unavailable",
                            triggerType: "schedule",
                            updatedAtMs: 6500,
                        },
                        nextRunAtMs: null,
                        state: "present",
                    },
                ],
                state: "available",
            },
            {
                items: [
                    {
                        defaultEnabled: true,
                        enabled: false,
                        id: "cache.system-host",
                        latestRun: {
                            queuedAtMs: 6000,
                            state: "queued",
                            triggerType: "schedule",
                            updatedAtMs: 6200,
                        },
                        nextRunAtMs: null,
                        state: "present",
                    },
                ],
                state: "available",
            },
            {
                items: [
                    {
                        activeRun: {
                            queuedAtMs: 6000,
                            state: "running",
                            updatedAtMs: 6500,
                        },
                        defaultEnabled: true,
                        enabled: false,
                        id: "cache.system-host",
                        latestRun: {
                            queuedAtMs: 6000,
                            state: "running",
                            triggerType: "schedule",
                            updatedAtMs: 6500,
                        },
                        nextRunAtMs: null,
                        state: "present",
                    },
                ],
                state: "available",
            },
            {
                items: [
                    {
                        activeRun: {
                            queuedAtMs: 6000,
                            state: "queued",
                            updatedAtMs: 6200,
                        },
                        defaultEnabled: true,
                        enabled: false,
                        id: "cache.system-host",
                        latestRun: {
                            firstStartedAtMs: 6100,
                            queuedAtMs: 6000,
                            state: "running",
                            triggerType: "schedule",
                            updatedAtMs: 6500,
                        },
                        nextRunAtMs: null,
                        state: "present",
                    },
                ],
                state: "available",
            },
        ] as const;
        for (const [index, dashboardJobs] of malformedDashboardJobProjections.entries()) {
            const service = createCacheService({
                cacheRepository: readOnlyCacheRepository(record),
                jobRepository: Object.freeze({}) as never,
                nowMs: () => 7000,
                readHeartbeatDashboardJobs: () =>
                    ({
                        dashboardJobs,
                        generatedAtMs: 7000,
                    }) as never,
                readHeartbeatTasks: () => validTasks,
            });
            expect(
                await Effect.runPromise(service.getHeartbeat()),
                `malformed dashboard-job projection ${index}`
            ).toMatchObject({
                dashboardJobs: { state: "unavailable" },
                tasks: { items: [], state: "available" },
            });
        }
    });

    test("demotes only the malformed operational-signal leaf", async () => {
        const service = createCacheService({
            cacheRepository: readOnlyCacheRepository(record),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 7000,
            readOperationalSignals: () =>
                ({
                    backups: {
                        kopia: { state: "unavailable" },
                        walg: { state: "unavailable" },
                    },
                    database: {
                        postgresqlMaintenance: { state: "unavailable" },
                        sqliteMaintenance: { state: "unavailable" },
                    },
                    docker: {
                        health: { state: "unavailable" },
                        updates: { state: "unavailable" },
                    },
                    git: { state: "unavailable" },
                    hostCapacity: { state: "unavailable" },
                    logs: { state: "unavailable" },
                    quota: {
                        condition: "provider-secret-state",
                        observedAtMs: 6500,
                        state: "fresh",
                    },
                    weather: {
                        condition: "available",
                        observedAtMs: 6500,
                        state: "fresh",
                    },
                }) as never,
        });

        const result = await Effect.runPromise(service.getHeartbeat());
        expect(result.operationalSignals.quota).toEqual({ state: "unavailable" });
        expect(result.operationalSignals.weather).toEqual({
            condition: "available",
            observedAtMs: 6500,
            state: "fresh",
        });
        expect(JSON.stringify(result)).not.toContain("provider-secret-state");
    });

    test("replays before mutable provider and schedule lookups with caller isolation", async () => {
        const database = await openFreshMigratedDatabase();
        const jobRepository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        let nextId = 100;
        const generateId = () => uuid(nextId++);
        try {
            await reconcileJobSchedules({
                generateId,
                nowMs: () => 1000,
                repository: jobRepository,
            });
            const service = createCacheService({
                cacheRepository: createCacheRepository(
                    database.orm,
                    testImmediateDatabaseWriteAdmission
                ),
                generateId,
                jobRepository,
                nowMs: () => 2000,
            });
            const input = {
                idempotencyKey: "b".repeat(32),
                key: "system.host",
            };
            const first = await Effect.runPromise(
                service.refreshEntry(principal(1), input)
            );
            expect(first).toMatchObject({
                actionKey: "cache.refresh.system-host",
                state: "queued",
            });

            const throwingLookupRepository = {
                ...jobRepository,
                findSchedule() {
                    throw new Error("Replay performed a mutable schedule lookup");
                },
            };
            const replayService = createCacheService({
                cacheRepository: createCacheRepository(
                    database.orm,
                    testImmediateDatabaseWriteAdmission
                ),
                generateId,
                jobRepository: throwingLookupRepository,
                nowMs: () => 3000,
            });
            expect(
                await Effect.runPromise(replayService.refreshEntry(principal(1), input))
            ).toEqual(first);
            expect(
                Effect.runPromise(
                    replayService.refreshEntry(principal(1), {
                        idempotencyKey: input.idempotencyKey,
                        key: "unknown.provider",
                    })
                )
            ).rejects.toBeInstanceOf(CacheConflictError);
            expect(
                Effect.runPromise(
                    service.refreshEntry(principal(2), {
                        idempotencyKey: input.idempotencyKey,
                        key: "unknown.provider",
                    })
                )
            ).rejects.toBeInstanceOf(CacheNotFoundError);
        } finally {
            database.sqlite.close(true);
        }
    });
});
