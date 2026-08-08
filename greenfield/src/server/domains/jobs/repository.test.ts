import { describe, expect, test } from "bun:test";

import { count, eq } from "drizzle-orm";

import { jobRunEvents } from "../../database/schema/jobRunEvents.ts";
import { jobRuns } from "../../database/schema/jobRuns.ts";
import { resourceLeases } from "../../database/schema/resourceLeases.ts";
import { scheduledJobs } from "../../database/schema/scheduledJobs.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import {
    createJobRepository,
    type JobMutationSideEffects,
    type JobRunEventInsert,
    type JobRunInsert,
    type ScheduledJobInsert,
    type WorkerInstanceInsert,
} from "./repository.ts";

const userId = "019fdf10-0000-7000-8000-000000000001";
const workerOneId = "019fdf10-0000-7000-8000-000000000002";
const workerTwoId = "019fdf10-0000-7000-8000-000000000003";
const noSideEffects: JobMutationSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});

function uuid(index: number): string {
    return `019fdf10-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function idempotencyKey(index: number): string {
    return index.toString(16).padStart(32, "0");
}

function schedule(overrides: Partial<ScheduledJobInsert> = {}): ScheduledJobInsert {
    return {
        actionKey: "system.worker-smoke",
        actionPayloadJson: "{}",
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAt: new Date(1000),
        cronExpression: null,
        description: "Safe worker smoke check",
        enabled: true,
        id: "system.worker-smoke",
        intervalMs: 60_000,
        name: "Worker smoke",
        nextRunAt: new Date(61_000),
        priority: 0,
        resourceClass: "light",
        resourceKeysJson: '["database"]',
        retrySafe: true,
        scheduleKind: "interval",
        timeOfDay: null,
        timeZone: null,
        timeoutMs: 10_000,
        updatedAt: new Date(1000),
        version: 1,
        ...overrides,
    };
}

function queuedRun(index: number, overrides: Partial<JobRunInsert> = {}): JobRunInsert {
    const queuedAt = new Date(1000 + index);
    return {
        actionKey: "system.worker-smoke",
        attemptLimit: 3,
        availableAt: queuedAt,
        cancellationPolicy: "cooperative",
        cancelRequestedAt: null,
        cancelRequestedById: null,
        cancelRequestedByKind: null,
        displayName: "Worker smoke",
        enqueueSha256: index.toString(16).padStart(64, "0"),
        finishedAt: null,
        firstStartedAt: null,
        heartbeatAt: null,
        id: uuid(index),
        idempotencyKey: idempotencyKey(index),
        lastAttemptStartedAt: null,
        leaseExpiresAt: null,
        leaseOwnerId: null,
        leaseToken: null,
        payloadJson: "{}",
        priority: 0,
        queuedAt,
        requestedById: userId,
        requestedByKind: "user",
        resourceClass: "light",
        resourceKeysJson: '["database"]',
        resultJson: null,
        retrySafe: true,
        scheduledForAt: null,
        scheduledJobId: "system.worker-smoke",
        scheduledJobVersion: 1,
        state: "queued",
        terminalCode: null,
        terminalMessage: null,
        timeoutMs: 10_000,
        triggerType: "manual",
        updatedAt: queuedAt,
        ...overrides,
    };
}

function queuedEvent(run: JobRunInsert): JobRunEventInsert {
    return {
        attempt: 0,
        jobRunId: run.id,
        kind: "queued",
        message: null,
        occurredAt: run.queuedAt,
        progressJson: null,
        sequence: 1,
        workerInstanceId: null,
    };
}

function worker(id: string, capacity = 1): WorkerInstanceInsert {
    return {
        capacity,
        drainingAt: null,
        heartbeatAt: new Date(2000),
        id,
        pid: 1234,
        releaseId: "a".repeat(40),
        startedAt: new Date(2000),
        state: "online",
        stoppedAt: null,
    };
}

describe("durable jobs repository", () => {
    test("reconciles code metadata and enforces caller-scoped manual idempotency", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            const [created] = await repository.reconcileSchedules({
                ...noSideEffects,
                schedules: [schedule()],
            });
            expect(created).toMatchObject({
                enabled: true,
                id: "system.worker-smoke",
                version: 1,
            });

            const [reconciled] = await repository.reconcileSchedules({
                ...noSideEffects,
                schedules: [
                    schedule({
                        description: "Updated code-owned description",
                        enabled: false,
                        nextRunAt: null,
                        updatedAt: new Date(2000),
                    }),
                ],
            });
            expect(reconciled).toMatchObject({
                description: "Updated code-owned description",
                enabled: true,
                nextRunAt: new Date(61_000),
                version: 2,
            });

            const rejectedRun = queuedRun(9, { scheduledJobVersion: 2 });
            const rejected = repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: {
                    ...queuedEvent(rejectedRun),
                    jobRunId: uuid(99),
                },
                run: rejectedRun,
            });
            expect(rejected).rejects.toThrow(
                "Queued event does not belong to the inserted manual run"
            );
            await rejected.catch(() => {});
            expect(repository.findRun(rejectedRun.id)).toBeUndefined();

            const run = queuedRun(10, { scheduledJobVersion: 2 });
            const inserted = await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent(run),
                run,
            });
            expect(inserted).toMatchObject({ kind: "inserted", run: { eventCount: 1 } });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(run),
                    run,
                })
            ).toMatchObject({ kind: "replayed", run: { id: run.id } });

            const mismatch = await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent({ ...run, enqueueSha256: "f".repeat(64) }),
                run: { ...run, enqueueSha256: "f".repeat(64) },
            });
            expect(mismatch.kind).toBe("idempotency-mismatch");
            const active = await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent(queuedRun(11, { scheduledJobVersion: 2 })),
                run: queuedRun(11, { scheduledJobVersion: 2 }),
            });
            expect(active).toMatchObject({ kind: "active", run: { id: run.id } });

            const cancelled = await repository.cancelRun({
                ...noSideEffects,
                actor: { id: userId, kind: "user" },
                at: new Date(3000),
                id: run.id,
                terminalCode: "job/cancelled",
                terminalMessage: "Cancelled by the operator.",
            });
            expect(cancelled).toMatchObject({
                kind: "cancelled",
                run: { eventCount: 3, state: "cancelled" },
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enqueues one due schedule occurrence without changing operator version", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            await repository.reconcileSchedules({
                ...noSideEffects,
                schedules: [schedule()],
            });
            const run = queuedRun(20, {
                availableAt: new Date(100_000),
                queuedAt: new Date(100_000),
                requestedById: "job-scheduler",
                requestedByKind: "system",
                scheduledForAt: new Date(61_000),
                triggerType: "schedule",
                updatedAt: new Date(100_000),
            });
            const result = await repository.enqueueNextDueSchedule({
                ...noSideEffects,
                at: new Date(100_000),
                nextRunAt: new Date(121_000),
                observedNextRunAt: new Date(61_000),
                run,
                scheduleId: "system.worker-smoke",
            });
            expect(result).toMatchObject({ kind: "inserted", run: { eventCount: 1 } });
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({
                nextRunAt: new Date(121_000),
                updatedAt: new Date(1000),
                version: 1,
            });

            const active = await repository.enqueueNextDueSchedule({
                ...noSideEffects,
                at: new Date(200_000),
                nextRunAt: new Date(241_000),
                observedNextRunAt: new Date(121_000),
                run: queuedRun(21, {
                    availableAt: new Date(200_000),
                    queuedAt: new Date(200_000),
                    requestedById: "job-scheduler",
                    requestedByKind: "system",
                    scheduledForAt: new Date(121_000),
                    triggerType: "schedule",
                    updatedAt: new Date(200_000),
                }),
                scheduleId: "system.worker-smoke",
            });
            expect(active).toMatchObject({ kind: "active", run: { id: run.id } });
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(121_000));

            const disabled = await repository.updateSchedule({
                ...noSideEffects,
                at: new Date(210_000),
                expectedVersion: 1,
                id: "system.worker-smoke",
                insertDisableIntent: {
                    createdAt: new Date(210_000),
                    createdById: userId,
                    createdByKind: "user",
                    endedAt: null,
                    endedById: null,
                    endedByKind: null,
                    endedReason: null,
                    expiresAt: null,
                    externalJobId: null,
                    externalProvider: null,
                    id: uuid(22),
                    reason: "Operator disabled the recurring smoke check",
                    scheduledJobId: "system.worker-smoke",
                    targetKind: "dashboard-schedule",
                },
                patch: { enabled: false },
                queuedCancellation: {
                    at: new Date(210_000),
                    terminalCode: "schedule/disabled",
                    terminalMessage: "The schedule was disabled before execution.",
                },
                queuedCancellationSideEffects: () => noSideEffects,
            });
            expect(disabled).toMatchObject({
                kind: "updated",
                schedule: {
                    enabled: false,
                    nextRunAt: new Date(121_000),
                    version: 2,
                },
            });
            expect(repository.findRun(run.id)).toMatchObject({
                eventCount: 3,
                state: "cancelled",
                terminalCode: "schedule/disabled",
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("expires disable intents atomically and resumes cadence without touching an active run", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            await repository.reconcileSchedules({
                ...noSideEffects,
                schedules: [schedule(), schedule({ id: "system.worker-smoke-rollback" })],
            });
            const disableIntent = {
                createdAt: new Date(2000),
                createdById: userId,
                createdByKind: "user" as const,
                endedAt: null,
                endedById: null,
                endedByKind: null,
                endedReason: null,
                expiresAt: new Date(3000),
                externalJobId: null,
                externalProvider: null,
                id: uuid(70),
                reason: "Pause while maintenance is active",
                scheduledJobId: "system.worker-smoke",
                targetKind: "dashboard-schedule" as const,
            };
            expect(
                await repository.updateSchedule({
                    ...noSideEffects,
                    at: new Date(20_000),
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    insertDisableIntent: disableIntent,
                    patch: { enabled: false },
                })
            ).toMatchObject({
                kind: "updated",
                schedule: { enabled: false, version: 2 },
            });

            const activeRun = queuedRun(71, { scheduledJobVersion: 2 });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(activeRun),
                    run: activeRun,
                })
            ).toMatchObject({ kind: "inserted" });
            let expirySideEffectAt: Date | undefined;
            const [expired] = await repository.expireDisableIntents({
                at: new Date(4000),
                nextRunAt: (disabledSchedule) => {
                    expect(disabledSchedule.nextRunAt).toEqual(new Date(61_000));
                    return new Date(64_000);
                },
                sideEffectsForSchedule: (resumed) => {
                    expirySideEffectAt = resumed.updatedAt;
                    return noSideEffects;
                },
                systemActorId: "job-scheduler",
            });
            expect(expired).toMatchObject({
                intent: { endedByKind: "system", endedReason: "expired" },
                kind: "re-enabled",
                schedule: { enabled: true, nextRunAt: new Date(64_000), version: 3 },
            });
            expect(expirySideEffectAt).toEqual(new Date(20_000));
            expect(repository.findActiveRunForSchedule("system.worker-smoke")?.id).toBe(
                activeRun.id
            );

            const rollbackIntent = {
                ...disableIntent,
                id: uuid(72),
                scheduledJobId: "system.worker-smoke-rollback",
            };
            await repository.updateSchedule({
                ...noSideEffects,
                at: new Date(2000),
                expectedVersion: 1,
                id: "system.worker-smoke-rollback",
                insertDisableIntent: rollbackIntent,
                patch: { enabled: false },
            });
            expect(
                repository.expireDisableIntents({
                    at: new Date(4000),
                    nextRunAt: () => new Date(64_000),
                    sideEffectsForSchedule: (resumed) => ({
                        auditEvents: [],
                        realtimeEvents: [
                            {
                                entityId: resumed.id,
                                entityType: "schedule",
                                expiresAt: new Date(4000),
                                occurredAt: new Date(4000),
                                operation: "updated",
                                payloadJson: JSON.stringify({ id: resumed.id }),
                                topic: "schedules.records",
                            },
                        ],
                    }),
                    systemActorId: "job-scheduler",
                })
            ).rejects.toThrow();
            expect(
                repository.findSchedule("system.worker-smoke-rollback")?.schedule
            ).toMatchObject({ enabled: false, version: 2 });
            expect(
                repository.findActiveDisableIntent("system.worker-smoke-rollback")
            ).toMatchObject({ endedAt: null, id: rollbackIntent.id });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects disabling before mutating when a queued schedule run is never cancellable", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            await repository.reconcileSchedules({
                ...noSideEffects,
                schedules: [schedule({ cancellationPolicy: "never" })],
            });
            const run = queuedRun(73, {
                availableAt: new Date(100_000),
                cancellationPolicy: "never",
                queuedAt: new Date(100_000),
                requestedById: "job-scheduler",
                requestedByKind: "system",
                scheduledForAt: new Date(61_000),
                triggerType: "schedule",
                updatedAt: new Date(100_000),
            });
            expect(
                await repository.enqueueNextDueSchedule({
                    ...noSideEffects,
                    at: new Date(100_000),
                    nextRunAt: new Date(121_000),
                    observedNextRunAt: new Date(61_000),
                    run,
                    scheduleId: "system.worker-smoke",
                })
            ).toMatchObject({ kind: "inserted" });

            const result = await repository.updateSchedule({
                ...noSideEffects,
                at: new Date(110_000),
                expectedVersion: 1,
                id: "system.worker-smoke",
                insertDisableIntent: {
                    createdAt: new Date(110_000),
                    createdById: userId,
                    createdByKind: "user",
                    endedAt: null,
                    endedById: null,
                    endedByKind: null,
                    endedReason: null,
                    expiresAt: null,
                    externalJobId: null,
                    externalProvider: null,
                    id: uuid(74),
                    reason: "Maintenance must wait for the queued run",
                    scheduledJobId: "system.worker-smoke",
                    targetKind: "dashboard-schedule",
                },
                patch: { enabled: false },
                queuedCancellation: {
                    at: new Date(110_000),
                    terminalCode: "schedule/disabled",
                    terminalMessage: "The schedule was disabled before execution.",
                },
                queuedCancellationSideEffects: () => noSideEffects,
            });

            expect(result).toMatchObject({
                kind: "cancellation-not-supported",
                run: { id: run.id, state: "queued" },
            });
            const unchangedSchedule = repository.findSchedule("system.worker-smoke");
            expect(unchangedSchedule?.activeDisableIntent).toBeUndefined();
            expect(unchangedSchedule?.schedule).toMatchObject({
                enabled: true,
                nextRunAt: new Date(121_000),
                version: 1,
            });
            expect(repository.findRun(run.id)).toMatchObject({
                cancelRequestedAt: null,
                eventCount: 1,
                state: "queued",
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("claims in total order, skips occupied resources, renews, reports, and settles", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            const runs = [
                queuedRun(30, {
                    requestedById: "job-scheduler",
                    requestedByKind: "system",
                    resourceKeysJson: '["database"]',
                    scheduledJobId: null,
                    scheduledJobVersion: null,
                    triggerType: "system",
                    updatedAt: new Date(20_000),
                }),
                queuedRun(31, {
                    requestedById: "job-scheduler",
                    requestedByKind: "system",
                    resourceKeysJson: '["database"]',
                    scheduledJobId: null,
                    scheduledJobVersion: null,
                    triggerType: "system",
                }),
                queuedRun(32, {
                    requestedById: "job-scheduler",
                    requestedByKind: "system",
                    resourceKeysJson: '["network"]',
                    scheduledJobId: null,
                    scheduledJobVersion: null,
                    triggerType: "system",
                }),
            ];
            for (const run of runs) {
                expect(
                    await repository.enqueueManualRun({
                        ...noSideEffects,
                        queuedEvent: queuedEvent(run),
                        run,
                    })
                ).toMatchObject({ kind: "inserted" });
            }
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerTwoId),
            });

            let claimSideEffectAt: Date | undefined;
            const firstClaim = await repository.claimNextRun({
                sideEffectsForClaim: (claimed) => {
                    claimSideEffectAt = claimed.updatedAt;
                    return noSideEffects;
                },
                at: new Date(3000),
                leaseExpiresAt: new Date(13_000),
                leaseToken: uuid(100),
                minimumHeartbeatAt: new Date(1000),
                workerId: workerOneId,
            });
            expect(firstClaim).toMatchObject({
                kind: "claimed",
                run: {
                    heartbeatAt: new Date(20_000),
                    id: runs[0]?.id,
                    leaseExpiresAt: new Date(30_000),
                },
            });
            expect(claimSideEffectAt).toEqual(new Date(20_000));
            const secondClaim = await repository.claimNextRun({
                sideEffectsForClaim: () => noSideEffects,
                at: new Date(3000),
                leaseExpiresAt: new Date(13_000),
                leaseToken: uuid(101),
                minimumHeartbeatAt: new Date(1000),
                workerId: workerTwoId,
            });
            expect(secondClaim).toMatchObject({
                kind: "claimed",
                run: { id: runs[2]?.id },
            });

            expect(
                await repository.renewClaim({
                    at: new Date(4000),
                    leaseExpiresAt: new Date(20_000),
                    leaseToken: uuid(101),
                    runId: runs[2]?.id ?? "",
                    workerId: workerTwoId,
                })
            ).toMatchObject({ kind: "renewed" });
            expect(
                await repository.appendClaimEvent({
                    at: new Date(5000),
                    kind: "progress",
                    leaseToken: uuid(101),
                    progressJson: '{"percent":50}',
                    runId: runs[2]?.id ?? "",
                    workerId: workerTwoId,
                })
            ).toMatchObject({ kind: "appended" });
            expect(
                await repository.settleClaim({
                    sideEffectsForRun: () => noSideEffects,
                    at: new Date(6000),
                    leaseToken: uuid(101),
                    outcome: { kind: "succeeded", resultJson: '{"status":"ok"}' },
                    runId: runs[2]?.id ?? "",
                    workerId: workerTwoId,
                })
            ).toMatchObject({ kind: "settled", run: { state: "succeeded" } });
            expect(
                database.orm
                    .select({ value: count() })
                    .from(resourceLeases)
                    .where(eq(resourceLeases.jobRunId, runs[2]?.id ?? ""))
                    .get()?.value
            ).toBe(0);

            let settlementSideEffectAt: Date | undefined;
            expect(
                await repository.settleClaim({
                    sideEffectsForRun: (settled) => {
                        settlementSideEffectAt = settled.updatedAt;
                        return noSideEffects;
                    },
                    at: new Date(6500),
                    leaseToken: uuid(100),
                    outcome: { kind: "succeeded", resultJson: '{"status":"ok"}' },
                    runId: runs[0]?.id ?? "",
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "settled", run: { state: "succeeded" } });
            expect(settlementSideEffectAt).toEqual(new Date(20_000));

            const nowUnblocked = await repository.claimNextRun({
                sideEffectsForClaim: () => noSideEffects,
                at: new Date(7000),
                leaseExpiresAt: new Date(17_000),
                leaseToken: uuid(102),
                minimumHeartbeatAt: new Date(1000),
                workerId: workerTwoId,
            });
            expect(nowUnblocked).toMatchObject({
                kind: "claimed",
                run: { id: runs[1]?.id },
            });
            expect(
                await repository.settleClaim({
                    sideEffectsForRun: () => noSideEffects,
                    at: new Date(8000),
                    leaseToken: uuid(102),
                    outcome: {
                        kind: "failed",
                        retryAt: new Date(9000),
                        terminalCode: "job/retryable",
                        terminalMessage: "Transient dependency failure.",
                    },
                    runId: runs[1]?.id ?? "",
                    workerId: workerTwoId,
                })
            ).toMatchObject({
                kind: "retry-scheduled",
                run: { availableAt: new Date(9000), eventCount: 4, state: "queued" },
            });
            expect(
                repository
                    .listRunEvents({ limit: 10, runId: runs[1]?.id ?? "" })
                    .map(({ kind }) => kind)
            ).toEqual(["retry-scheduled", "failed", "claimed", "queued"]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("reserves the terminal event when payload consumes the byte budget", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const run = queuedRun(60, {
            attemptLimit: 10,
            requestedById: "job-scheduler",
            requestedByKind: "system",
            resourceKeysJson: "[]",
            scheduledJobId: null,
            scheduledJobVersion: null,
            triggerType: "system",
        });
        let leaseToken = uuid(160);
        const fullProgressJson = JSON.stringify({ value: "x".repeat(16_372) });
        const remainingProgressJson = JSON.stringify({ value: "x".repeat(8180) });
        const terminalMessage = "😀".repeat(2000);
        expect(fullProgressJson.length).toBe(16_384);
        expect(remainingProgressJson.length).toBe(8192);

        try {
            await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent(run),
                run,
            });
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            expect(
                await repository.claimNextRun({
                    sideEffectsForClaim: () => noSideEffects,
                    at: new Date(3000),
                    leaseExpiresAt: new Date(30_000),
                    leaseToken,
                    minimumHeartbeatAt: new Date(1000),
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "claimed", run: { id: run.id } });

            for (let index = 0; index < 62; index += 1) {
                expect(
                    await repository.appendClaimEvent({
                        at: new Date(4000 + index),
                        kind: "progress",
                        leaseToken,
                        progressJson:
                            index === 61 ? remainingProgressJson : fullProgressJson,
                        runId: run.id,
                        workerId: workerOneId,
                    })
                ).toMatchObject({ kind: "appended" });
            }

            for (let attempt = 1; attempt < 10; attempt += 1) {
                const at = new Date(5000 + attempt * 100);
                const retryAt = new Date(at.getTime() + 1);
                expect(
                    await repository.settleClaim({
                        sideEffectsForRun: () => noSideEffects,
                        at,
                        leaseToken,
                        outcome: {
                            kind: "failed",
                            retryAt,
                            terminalCode: "job/retryable",
                            terminalMessage,
                        },
                        runId: run.id,
                        workerId: workerOneId,
                    })
                ).toMatchObject({ kind: "retry-scheduled" });
                leaseToken = uuid(160 + attempt);
                expect(
                    await repository.claimNextRun({
                        sideEffectsForClaim: () => noSideEffects,
                        at: retryAt,
                        leaseExpiresAt: new Date(retryAt.getTime() + 30_000),
                        leaseToken,
                        minimumHeartbeatAt: new Date(1000),
                        workerId: workerOneId,
                    })
                ).toMatchObject({
                    kind: "claimed",
                    run: { attemptCount: attempt + 1, id: run.id },
                });
            }

            expect(
                await repository.settleClaim({
                    sideEffectsForRun: () => noSideEffects,
                    at: new Date(7000),
                    leaseToken,
                    outcome: {
                        kind: "failed",
                        terminalCode: "job/failed",
                        terminalMessage,
                    },
                    runId: run.id,
                    workerId: workerOneId,
                })
            ).toMatchObject({
                kind: "settled",
                run: {
                    eventBytes: 1_048_576,
                    eventCount: 92,
                    state: "failed",
                    terminalMessage,
                },
            });
            expect(
                repository.listRunEvents({ limit: 1, runId: run.id })[0]
            ).toMatchObject({ kind: "failed", message: "😀".repeat(1024) });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("persists claim pause, recovers expired retry-safe work, and drains the worker", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            const run = queuedRun(80, {
                requestedById: "job-scheduler",
                requestedByKind: "system",
                scheduledJobId: null,
                scheduledJobVersion: null,
                triggerType: "system",
            });
            await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent(run),
                run,
            });
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            expect(
                await repository.setClaimingPaused({
                    ...noSideEffects,
                    actor: { id: userId, kind: "user" },
                    at: new Date(2500),
                    expectedVersion: 1,
                    paused: true,
                })
            ).toMatchObject({ control: { version: 2 }, kind: "updated" });
            expect(
                await repository.claimNextRun({
                    sideEffectsForClaim: () => noSideEffects,
                    at: new Date(3000),
                    leaseExpiresAt: new Date(5000),
                    leaseToken: uuid(81),
                    minimumHeartbeatAt: new Date(1000),
                    workerId: workerOneId,
                })
            ).toEqual({ kind: "paused" });
            await repository.setClaimingPaused({
                ...noSideEffects,
                actor: { id: userId, kind: "user" },
                at: new Date(2600),
                expectedVersion: 2,
                paused: false,
            });
            expect(
                await repository.claimNextRun({
                    sideEffectsForClaim: () => noSideEffects,
                    at: new Date(3000),
                    leaseExpiresAt: new Date(5000),
                    leaseToken: uuid(81),
                    minimumHeartbeatAt: new Date(1000),
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "claimed", run: { attemptCount: 1 } });

            const recovered = await repository.recoverExpiredClaims({
                at: new Date(6000),
                retryAt: () => new Date(7000),
                sideEffectsForRun: () => noSideEffects,
            });
            expect(recovered).toMatchObject([
                { availableAt: new Date(7000), eventCount: 4, state: "queued" },
            ]);
            expect(
                repository
                    .listRunEvents({ limit: 10, runId: run.id })
                    .map(({ kind }) => kind)
            ).toEqual(["retry-scheduled", "lease-expired", "claimed", "queued"]);
            expect(repository.readQueueState()).toMatchObject({
                control: { claimingPaused: false, version: 3 },
                stateCounts: { queued: 1, running: 0 },
                workers: [{ activeRunCount: 0, worker: { id: workerOneId } }],
            });
            await repository.cancelRun({
                ...noSideEffects,
                actor: { id: userId, kind: "user" },
                at: new Date(7100),
                id: run.id,
                terminalCode: "job/cancelled",
                terminalMessage: "Cancelled before the regression fixture.",
            });
            const regressedRun = queuedRun(82, {
                requestedById: "job-scheduler",
                requestedByKind: "system",
                scheduledJobId: null,
                scheduledJobVersion: null,
                triggerType: "system",
            });
            await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent(regressedRun),
                run: regressedRun,
            });
            await repository.claimNextRun({
                at: new Date(8000),
                leaseExpiresAt: new Date(10_000),
                leaseToken: uuid(82),
                minimumHeartbeatAt: new Date(1000),
                sideEffectsForClaim: () => noSideEffects,
                workerId: workerOneId,
            });
            await repository.cancelRun({
                ...noSideEffects,
                actor: { id: userId, kind: "user" },
                at: new Date(20_000),
                id: regressedRun.id,
                terminalCode: "job/cancel-requested",
                terminalMessage: "Cancel the clock-regression fixture.",
            });
            let recoverySideEffectAt: Date | undefined;
            expect(
                await repository.recoverExpiredClaims({
                    at: new Date(11_000),
                    retryAt: () => new Date(12_000),
                    sideEffectsForRun: (recoveredRun) => {
                        recoverySideEffectAt = recoveredRun.updatedAt;
                        return noSideEffects;
                    },
                })
            ).toMatchObject([{ id: regressedRun.id, state: "cancelled" }]);
            expect(recoverySideEffectAt).toEqual(new Date(20_000));
            expect(
                await repository.beginWorkerDrain({
                    ...noSideEffects,
                    at: new Date(7000),
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "updated", worker: { state: "draining" } });
            expect(
                await repository.stopWorker({
                    ...noSideEffects,
                    at: new Date(8000),
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "updated", worker: { state: "stopped" } });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rolls a durable transition back when a required side effect is invalid", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            const run = queuedRun(40, {
                requestedById: "job-scheduler",
                requestedByKind: "system",
                scheduledJobId: null,
                scheduledJobVersion: null,
                triggerType: "system",
            });
            expect(
                repository.enqueueManualRun({
                    auditEvents: [],
                    queuedEvent: queuedEvent(run),
                    realtimeEvents: [
                        {
                            entityId: run.id,
                            entityType: "job-run",
                            expiresAt: new Date(1000),
                            occurredAt: new Date(1000),
                            operation: "created",
                            payloadJson: JSON.stringify({ id: run.id }),
                            topic: "jobs.runs",
                        },
                    ],
                    run,
                })
            ).rejects.toThrow();
            expect(repository.findRun(run.id)).toBeUndefined();
            expect(
                database.orm
                    .select({ value: count() })
                    .from(jobRunEvents)
                    .where(eq(jobRunEvents.jobRunId, run.id))
                    .get()?.value
            ).toBe(0);
            expect(
                database.orm
                    .select({ value: count() })
                    .from(jobRuns)
                    .where(eq(jobRuns.id, run.id))
                    .get()?.value
            ).toBe(0);
            expect(
                database.orm.select({ value: count() }).from(scheduledJobs).get()?.value
            ).toBe(0);
        } finally {
            database.sqlite.close(true);
        }
    });
});
