import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { Effect } from "effect";

import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import { CacheConflictError, CacheNotFoundError } from "./errors.ts";
import { createTestCacheService } from "./testSupport/service.ts";

const runId = "018f6f50-6a9e-7b88-8000-000000000001";
const systemHostKey = "system.host";
const databaseObservabilityKey = "database.observability";
const queuedRun = Object.freeze({
    actionKey: systemHostKey,
    attemptCount: 0,
    attemptLimit: 3,
    availableAtMs: 1000,
    cancellationPolicy: "cooperative" as const,
    displayName: "Refresh system host cache",
    eventCount: 1,
    id: runId,
    priority: 0,
    queuedAtMs: 1000,
    resourceClass: "light" as const,
    resourceKeys: ["cache.system.host"],
    retrySafe: true,
    scheduledJobId: systemHostKey,
    scheduledJobVersion: 1,
    state: "queued" as const,
    stateVersion: 1,
    timeoutMs: 30_000,
    triggerType: "manual" as const,
    updatedAtMs: 1000,
});

async function expectTrpcCode(
    operation: () => Promise<unknown>,
    code: TRPCError["code"]
): Promise<void> {
    const failure = await captureFailure(operation);
    expect(failure).toBeInstanceOf(TRPCError);
    expect((failure as TRPCError).code).toBe(code);
}

describe("cache procedures", () => {
    test("enforces exact read and write capabilities", async () => {
        const anonymous = appRouter.createCaller(await createTestRequestContext()).cache;
        await expectTrpcCode(() => anonymous.getStatus({}), "UNAUTHORIZED");
        await expectTrpcCode(() => anonymous.getHeartbeat({}), "UNAUTHORIZED");

        const readOnly = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["cache:read"])
            )
        ).cache;
        await expectTrpcCode(
            () =>
                readOnly.refreshEntry({
                    idempotencyKey: "A".repeat(32),
                    key: systemHostKey,
                }),
            "FORBIDDEN"
        );

        const writeOnly = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["cache:write"])
            )
        ).cache;
        await expectTrpcCode(
            () => writeOnly.getEntry({ key: systemHostKey }),
            "FORBIDDEN"
        );
        await expectTrpcCode(() => writeOnly.getHeartbeat({}), "FORBIDDEN");
    });

    test("requires the owning domain capability for generic saved payload reads", async () => {
        const cacheService = createTestCacheService({
            getEntry: () =>
                Effect.fail(new CacheNotFoundError({ key: databaseObservabilityKey })),
        });
        const cacheOnly = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["cache:read"]),
                createTestApplicationRuntime(),
                { cacheService }
            )
        ).cache;
        const databaseReader = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["cache:read", "database:read"]),
                createTestApplicationRuntime(),
                { cacheService }
            )
        ).cache;

        await expectTrpcCode(
            () => cacheOnly.getEntry({ key: databaseObservabilityKey }),
            "FORBIDDEN"
        );
        await expectTrpcCode(
            () => databaseReader.getEntry({ key: databaseObservabilityKey }),
            "NOT_FOUND"
        );
    });

    test("serves bounded status and durable refresh results", async () => {
        const cacheService = createTestCacheService({
            getHeartbeat: () =>
                Effect.succeed({
                    cache: {
                        entries: [],
                        generatedAtMs: 1000,
                        totalCount: 0,
                        truncated: false,
                    },
                    dashboardJobs: { items: [], state: "available" },
                    gateway: {
                        connection: {
                            checkedAtMs: 1000,
                            freshness: "unavailable",
                            phase: "stopped",
                        },
                        sessions: { state: "unavailable" },
                    },
                    generatedAtMs: 1000,
                    openClawCron: {
                        pendingSync: "unknown",
                        state: "unavailable",
                    },
                    operationalSignals: {
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
                        quota: { state: "unavailable" },
                        weather: { state: "unavailable" },
                    },
                    schemaVersion: 5,
                    tasks: {
                        items: [],
                        state: "available",
                        totalCount: 0,
                        truncated: false,
                    },
                }),
            getStatus: () =>
                Effect.succeed({
                    entries: [],
                    generatedAtMs: 1000,
                    totalCount: 0,
                    truncated: false,
                }),
            refreshEntry: () => Effect.succeed(queuedRun),
        });
        const caller = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["cache:read", "cache:write"]),
                createTestApplicationRuntime(),
                { cacheService }
            )
        ).cache;
        const cacheOnlyAutomation = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["cache:read"]),
                createTestApplicationRuntime(),
                { cacheService }
            )
        ).cache;

        expect(await caller.getStatus({})).toEqual({
            entries: [],
            generatedAtMs: 1000,
            totalCount: 0,
            truncated: false,
        });
        const heartbeat = {
            cache: {
                entries: [],
                generatedAtMs: 1000,
                totalCount: 0,
                truncated: false,
            },
            dashboardJobs: { items: [], state: "available" },
            gateway: {
                connection: {
                    checkedAtMs: 1000,
                    freshness: "unavailable",
                    phase: "stopped",
                },
                sessions: { state: "unavailable" },
            },
            generatedAtMs: 1000,
            openClawCron: { pendingSync: "unknown", state: "unavailable" },
            operationalSignals: {
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
                quota: { state: "unavailable" },
                weather: { state: "unavailable" },
            },
            schemaVersion: 5,
            tasks: {
                items: [],
                state: "available",
                totalCount: 0,
                truncated: false,
            },
        } as const;
        expect(await cacheOnlyAutomation.getHeartbeat({})).toEqual(heartbeat);
        expect(await caller.getHeartbeat({})).toEqual(heartbeat);
        expect(
            await caller.refreshEntry({
                idempotencyKey: "A".repeat(32),
                key: systemHostKey,
            })
        ).toEqual(queuedRun);
    });

    test("maps missing entries and refresh conflicts to stable tRPC errors", async () => {
        const cacheService = createTestCacheService({
            getEntry: () => Effect.fail(new CacheNotFoundError({ key: systemHostKey })),
            refreshEntry: () =>
                Effect.fail(
                    new CacheConflictError({
                        key: systemHostKey,
                        reason: "run-already-active",
                    })
                ),
        });
        const caller = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["cache:read", "cache:write"]),
                createTestApplicationRuntime(),
                { cacheService }
            )
        ).cache;

        await expectTrpcCode(() => caller.getEntry({ key: systemHostKey }), "NOT_FOUND");
        await expectTrpcCode(
            () =>
                caller.refreshEntry({
                    idempotencyKey: "B".repeat(32),
                    key: systemHostKey,
                }),
            "CONFLICT"
        );
    });
});
