import { describe, expect, test } from "bun:test";

import { asc, eq } from "drizzle-orm";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { cacheEntries } from "../../database/schema/cacheEntries.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createJobRepository, type JobMutationSideEffects } from "../jobs/repository.ts";
import { createCacheRepository } from "./repository.ts";

const noSideEffects: JobMutationSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});

function uuid(index: number): string {
    return `019fdf30-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function successOutcome(durationMs = 10) {
    return {
        durationMs,
        entries: [
            {
                key: "system.host",
                metadata: { kind: "host" },
                payload: {
                    architecture: "x64",
                    disk: { freeBytes: 500, path: "/", totalBytes: 1000 },
                    hostname: "dashboard-host",
                    memory: { freeBytes: 400, totalBytes: 1000 },
                    platform: "linux",
                    release: "6.8.0",
                    uptimeSeconds: 12,
                },
                schemaId: "system.host.v1",
                source: "system.host",
                ttlMs: 86_400_000,
            },
        ],
        kind: "succeeded" as const,
    };
}

async function runningClaim(
    options: {
        readonly actionKey?: string;
        readonly payloadJson?: string;
    } = {}
) {
    const database = await openFreshMigratedDatabase();
    const jobs = createJobRepository(database.orm, testImmediateDatabaseWriteAdmission);
    const cache = createCacheRepository(
        database.orm,
        testImmediateDatabaseWriteAdmission,
        () => 3000
    );
    const workerId = uuid(1);
    const runId = uuid(2);
    const leaseToken = uuid(3);
    await jobs.registerWorker({
        ...noSideEffects,
        worker: {
            actionKeysJson: "[]",
            capacity: 1,
            drainingAt: null,
            heartbeatAt: new Date(1000),
            id: workerId,
            pid: 123,
            releaseId: "a".repeat(40),
            startedAt: new Date(1000),
            state: "online",
            stoppedAt: null,
        },
    });
    const queuedAt = new Date(1000);
    await jobs.enqueueManualRun({
        ...noSideEffects,
        queuedEvent: {
            attempt: 0,
            jobRunId: runId,
            kind: "queued",
            message: null,
            occurredAt: queuedAt,
            progressJson: null,
            sequence: 1,
            workerInstanceId: null,
        },
        run: {
            actionKey: options.actionKey ?? "cache.refresh.system-host",
            attemptLimit: 3,
            availableAt: queuedAt,
            cancellationPolicy: "cooperative",
            cancelRequestedAt: null,
            cancelRequestedById: null,
            cancelRequestedByKind: null,
            displayName: "System host cache",
            enqueueSha256: "a".repeat(64),
            finishedAt: null,
            firstStartedAt: null,
            heartbeatAt: null,
            id: runId,
            idempotencyKey: "a".repeat(32),
            lastAttemptStartedAt: null,
            leaseExpiresAt: null,
            leaseOwnerId: null,
            leaseToken: null,
            payloadJson: options.payloadJson ?? '{"key":"system.host"}',
            priority: 0,
            queuedAt,
            requestedById: "system.cache-test",
            requestedByKind: "system",
            resourceClass: "light",
            resourceKeysJson: '["cache.system.host"]',
            resultJson: null,
            retrySafe: true,
            scheduledForAt: null,
            scheduledJobId: null,
            scheduledJobVersion: null,
            state: "queued",
            terminalCode: null,
            terminalMessage: null,
            timeoutMs: 30_000,
            triggerType: "system",
            updatedAt: queuedAt,
        },
    });
    const claim = await jobs.claimNextRun({
        at: new Date(2000),
        leaseExpiresAt: new Date(20_000),
        leaseToken,
        minimumHeartbeatAt: new Date(0),
        sideEffectsForClaim: () => noSideEffects,
        workerId,
    });
    if (claim.kind !== "claimed") throw new Error("Expected running cache claim");
    return { cache, database, jobs, leaseToken, run: claim.run, workerId };
}

describe("cache repository", () => {
    test("commits a claim-fenced success and matching realtime row atomically", async () => {
        const fixture = await runningClaim();
        try {
            expect(
                await fixture.cache.commitAttempt({
                    at: new Date(3000),
                    attempt: fixture.run.attemptCount,
                    leaseToken: fixture.leaseToken,
                    outcome: successOutcome(),
                    runId: fixture.run.id,
                    workerId: fixture.workerId,
                })
            ).toBe("committed");
            expect(fixture.cache.findEntry("system.host")).toMatchObject({
                consecutiveFailures: 0,
                key: "system.host",
                lastAttemptAt: new Date(3000),
                lastAttemptStatus: "succeeded",
                lastSuccessAt: new Date(3000),
            });
            const event = fixture.database.orm
                .select()
                .from(realtimeEvents)
                .where(eq(realtimeEvents.topic, "cache.entries"))
                .get();
            expect(event).toMatchObject({
                entityId: "system.host",
                entityType: "cache-entry",
                operation: "created",
                payloadJson: '{"key":"system.host"}',
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("rejects stale attempt, owner, token, and expired-lease authorities", async () => {
        for (const mutation of [
            { attempt: 2 },
            { workerId: uuid(9) },
            { leaseToken: uuid(9) },
            { at: new Date(20_000) },
        ]) {
            const fixture = await runningClaim();
            try {
                expect(
                    await fixture.cache.commitAttempt({
                        at: new Date(3000),
                        attempt: fixture.run.attemptCount,
                        leaseToken: fixture.leaseToken,
                        outcome: successOutcome(),
                        runId: fixture.run.id,
                        workerId: fixture.workerId,
                        ...mutation,
                    })
                ).toBe("lost-claim");
                expect(fixture.cache.findEntry("system.host")).toBeUndefined();
                expect(
                    fixture.database.orm
                        .select()
                        .from(realtimeEvents)
                        .where(eq(realtimeEvents.topic, "cache.entries"))
                        .all()
                ).toEqual([]);
            } finally {
                fixture.database.sqlite.close(true);
            }
        }
    });

    test("checks lease expiry against a fresh post-admission clock", async () => {
        const fixture = await runningClaim();
        let admittedAtMs = 3000;
        const delayedAdmission: ImmediateDatabaseWriteAdmission = {
            run(operation) {
                admittedAtMs = 20_000;
                return testImmediateDatabaseWriteAdmission.run(operation);
            },
        };
        const delayedCache = createCacheRepository(
            fixture.database.orm,
            delayedAdmission,
            () => admittedAtMs
        );
        try {
            expect(
                await delayedCache.commitAttempt({
                    at: new Date(3000),
                    attempt: fixture.run.attemptCount,
                    leaseToken: fixture.leaseToken,
                    outcome: successOutcome(),
                    runId: fixture.run.id,
                    workerId: fixture.workerId,
                })
            ).toBe("lost-claim");
            expect(delayedCache.findEntry("system.host")).toBeUndefined();
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("binds cache writes to the claimed provider action and payload", async () => {
        for (const options of [
            { actionKey: "system.worker-smoke", payloadJson: "{}" },
            {
                actionKey: "cache.refresh.system-host",
                payloadJson: '{"key":"different"}',
            },
        ]) {
            const fixture = await runningClaim(options);
            try {
                expect(
                    await fixture.cache.commitAttempt({
                        at: new Date(3000),
                        attempt: fixture.run.attemptCount,
                        leaseToken: fixture.leaseToken,
                        outcome: successOutcome(),
                        runId: fixture.run.id,
                        workerId: fixture.workerId,
                    })
                ).toBe("lost-claim");
                expect(fixture.cache.findEntry("system.host")).toBeUndefined();
                expect(
                    fixture.database.orm
                        .select()
                        .from(realtimeEvents)
                        .where(eq(realtimeEvents.topic, "cache.entries"))
                        .all()
                ).toEqual([]);
            } finally {
                fixture.database.sqlite.close(true);
            }
        }
    });

    test("preserves last-known-good data when a later claimed attempt fails", async () => {
        const fixture = await runningClaim();
        try {
            await fixture.cache.commitAttempt({
                at: new Date(3000),
                attempt: fixture.run.attemptCount,
                leaseToken: fixture.leaseToken,
                outcome: successOutcome(),
                runId: fixture.run.id,
                workerId: fixture.workerId,
            });
            const settlement = await fixture.jobs.settleClaim({
                at: new Date(4000),
                leaseToken: fixture.leaseToken,
                outcome: {
                    kind: "failed",
                    retryAt: new Date(5000),
                    terminalCode: "provider-unavailable",
                    terminalMessage: "Provider failed",
                },
                runId: fixture.run.id,
                sideEffectsForRun: () => noSideEffects,
                workerId: fixture.workerId,
            });
            expect(settlement.kind).toBe("retry-scheduled");
            await fixture.jobs.heartbeatWorker({
                at: new Date(5000),
                workerId: fixture.workerId,
            });
            const nextLeaseToken = uuid(4);
            const next = await fixture.jobs.claimNextRun({
                at: new Date(5000),
                leaseExpiresAt: new Date(30_000),
                leaseToken: nextLeaseToken,
                minimumHeartbeatAt: new Date(0),
                sideEffectsForClaim: () => noSideEffects,
                workerId: fixture.workerId,
            });
            if (next.kind !== "claimed") throw new Error("Expected retry claim");
            expect(
                await fixture.cache.commitAttempt({
                    at: new Date(6000),
                    attempt: next.run.attemptCount,
                    leaseToken: nextLeaseToken,
                    outcome: {
                        durationMs: 7,
                        failureCode: "provider/system-host-unavailable",
                        failureMessage: "System host projection could not be collected.",
                        key: "system.host",
                        kind: "failed",
                    },
                    runId: next.run.id,
                    workerId: fixture.workerId,
                })
            ).toBe("committed");
            expect(fixture.cache.findEntry("system.host")).toMatchObject({
                consecutiveFailures: 1,
                failureCode: "provider/system-host-unavailable",
                lastAttemptAt: new Date(6000),
                lastAttemptNumber: 2,
                lastAttemptStatus: "failed",
                lastSuccessAt: new Date(3000),
                payloadJson: JSON.stringify(successOutcome().entries[0]?.payload),
            });
            expect(
                await fixture.cache.commitAttempt({
                    at: new Date(7000),
                    attempt: fixture.run.attemptCount,
                    leaseToken: fixture.leaseToken,
                    outcome: successOutcome(),
                    runId: fixture.run.id,
                    workerId: fixture.workerId,
                })
            ).toBe("lost-claim");
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("rejects a provider group before any cache or outbox row is written", async () => {
        const fixture = await runningClaim();
        try {
            const outcome = successOutcome();
            const rejected = fixture.cache.commitAttempt({
                at: new Date(3000),
                attempt: fixture.run.attemptCount,
                leaseToken: fixture.leaseToken,
                outcome: {
                    ...outcome,
                    entries: [outcome.entries[0]!, outcome.entries[0]!],
                },
                runId: fixture.run.id,
                workerId: fixture.workerId,
            });
            expect(rejected).rejects.toThrow(
                "Cache provider entry group contains duplicate keys"
            );
            expect(fixture.cache.findEntry("system.host")).toBeUndefined();
            expect(
                fixture.database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "cache.entries"))
                    .all()
            ).toEqual([]);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("returns a canonical bounded status snapshot with an exact total", async () => {
        const fixture = await runningClaim();
        try {
            const base = {
                consecutiveFailures: 1,
                expiresAt: null,
                failureCode: "provider/unavailable",
                failureMessage: "Provider unavailable.",
                lastAttemptAt: new Date(3000),
                lastAttemptDurationMs: 1,
                lastAttemptNumber: fixture.run.attemptCount,
                lastAttemptRunId: fixture.run.id,
                lastAttemptStatus: "failed" as const,
                lastSuccessAt: null,
                metadataJson: null,
                payloadJson: null,
                schemaId: null,
                source: null,
                updatedAt: new Date(3000),
            };
            fixture.database.orm
                .insert(cacheEntries)
                .values(
                    Array.from({ length: 129 }, (_, index) => ({
                        ...base,
                        key: `orphan.${String(index).padStart(3, "0")}`,
                    }))
                )
                .run();
            const snapshot = fixture.cache.readStatus();
            expect(snapshot.entries).toHaveLength(128);
            expect(snapshot.totalCount).toBe(129);
            expect(snapshot.entries[0]?.key).toBe("orphan.000");
            expect(snapshot.entries.at(-1)?.key).toBe("orphan.127");
            expect(
                fixture.database.orm
                    .select({ key: cacheEntries.key })
                    .from(cacheEntries)
                    .orderBy(asc(cacheEntries.key))
                    .all()
            ).toHaveLength(129);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
