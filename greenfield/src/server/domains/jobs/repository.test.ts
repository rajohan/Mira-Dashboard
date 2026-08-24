import { describe, expect, test } from "bun:test";

import { asc, count, eq } from "drizzle-orm";

import { jobWorkerSummaryMaximum } from "../../../contracts/jobModel.ts";
import { jobRunEvents } from "../../database/schema/jobRunEvents.ts";
import { jobRuns } from "../../database/schema/jobRuns.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { resourceLeases } from "../../database/schema/resourceLeases.ts";
import { scheduledJobs } from "../../database/schema/scheduledJobs.ts";
import { workerInstances } from "../../database/schema/workerInstances.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import type { WorkerInstanceRecord } from "./records.ts";
import {
    createJobRepository,
    type JobMutationSideEffects,
    type JobRunEventInsert,
    type JobRunInsert,
    type ScheduledJobInsert,
    type WorkerInstanceInsert,
} from "./repository.ts";
import { createJobRealtimeSideEffects } from "./sideEffects.ts";

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
                at: new Date(1000),
                schedules: [schedule()],
                sideEffectsForSchedule: () => noSideEffects,
            });
            expect(created).toMatchObject({
                enabled: true,
                id: "system.worker-smoke",
                version: 1,
            });

            const [reconciled] = await repository.reconcileSchedules({
                at: new Date(2000),
                schedules: [
                    schedule({
                        description: "Updated code-owned description",
                        enabled: false,
                        nextRunAt: null,
                        updatedAt: new Date(2000),
                    }),
                ],
                sideEffectsForSchedule: () => noSideEffects,
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
                actor: { id: userId, kind: "user" },
                at: new Date(3000),
                id: run.id,
                sideEffectsForRun: () => noSideEffects,
                terminalCode: "job/cancelled",
                terminalMessage: "Cancelled by the operator.",
            });
            expect(cancelled).toMatchObject({
                kind: "cancelled",
                run: { eventCount: 3, state: "cancelled" },
            });

            const [updatedSchedule] = await repository.reconcileSchedules({
                at: new Date(4000),
                schedules: [schedule({ name: "Updated worker smoke" })],
                sideEffectsForSchedule: () => noSideEffects,
            });
            expect(updatedSchedule).toMatchObject({
                name: "Updated worker smoke",
                version: 3,
            });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(run),
                    run,
                })
            ).toMatchObject({ kind: "replayed", run: { id: run.id } });

            const staleRun = queuedRun(12, { scheduledJobVersion: 2 });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(staleRun),
                    run: staleRun,
                })
            ).toEqual({ kind: "action-unavailable" });
            expect(repository.findRun(staleRun.id)).toBeUndefined();

            const malformedCurrentRun = queuedRun(13, {
                displayName: "Stale worker smoke",
                scheduledJobVersion: 3,
            });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(malformedCurrentRun),
                    run: malformedCurrentRun,
                })
            ).toEqual({ kind: "action-unavailable" });
            expect(repository.findRun(malformedCurrentRun.id)).toBeUndefined();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("persists an honest unscheduled manual domain action without fake schedule provenance", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            const run = queuedRun(14, {
                actionKey: "workspace-files.apply-write",
                displayName: "Workspace file write",
                payloadJson: JSON.stringify({ command: "opaque-domain-payload" }),
                resourceClass: "host-heavy",
                resourceKeysJson: '["workspace.files"]',
                scheduledJobId: null,
                scheduledJobVersion: null,
            });

            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(run),
                    run,
                })
            ).toMatchObject({
                kind: "inserted",
                run: {
                    actionKey: "workspace-files.apply-write",
                    scheduledForAt: null,
                    scheduledJobId: null,
                    scheduledJobVersion: null,
                    triggerType: "manual",
                },
            });

            expect(
                repository.listActiveActionPayloads({
                    actionKey: "workspace-files.apply-write",
                    limit: 1,
                })
            ).toEqual({
                payloads: [run.payloadJson],
                truncated: false,
            });

            const invalid = queuedRun(15, {
                scheduledJobId: null,
                scheduledJobVersion: 1,
            });
            expect(
                repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(invalid),
                    run: invalid,
                })
            ).rejects.toThrow();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("pages due schedules by next occurrence and ID", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            await repository.reconcileSchedules({
                at: new Date(1000),
                schedules: [
                    schedule({
                        id: "system.worker-smoke-a",
                        nextRunAt: new Date(60_000),
                    }),
                    schedule({
                        id: "system.worker-smoke-b",
                        nextRunAt: new Date(60_000),
                    }),
                    schedule({
                        id: "system.worker-smoke-c",
                        nextRunAt: new Date(65_000),
                    }),
                    schedule({
                        id: "system.worker-smoke-future",
                        nextRunAt: new Date(70_001),
                    }),
                ],
                sideEffectsForSchedule: () => noSideEffects,
            });

            const firstPage = repository.listDueSchedules({
                at: new Date(70_000),
                limit: 2,
            });
            expect(firstPage.map(({ id }) => id)).toEqual([
                "system.worker-smoke-a",
                "system.worker-smoke-b",
            ]);
            const lastSchedule = firstPage.at(-1);
            if (lastSchedule === undefined || lastSchedule.nextRunAt === null) {
                throw new Error("Expected a due schedule cursor");
            }
            expect(
                repository
                    .listDueSchedules({
                        at: new Date(70_000),
                        cursor: {
                            id: lastSchedule.id,
                            nextRunAt: lastSchedule.nextRunAt,
                        },
                        limit: 2,
                    })
                    .map(({ id }) => id)
            ).toEqual(["system.worker-smoke-c"]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rolls back cancellation when durable-run side effects fail", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const run = queuedRun(4000);
        let sideEffectRun: ReturnType<typeof repository.findRun>;

        try {
            await repository.reconcileSchedules({
                at: new Date(1000),
                schedules: [schedule()],
                sideEffectsForSchedule: () => noSideEffects,
            });
            await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent(run),
                run,
            });

            const rejected = repository.cancelRun({
                actor: { id: userId, kind: "user" },
                at: new Date(2000),
                id: run.id,
                sideEffectsForRun: (cancelled) => {
                    sideEffectRun = cancelled;
                    throw new Error("reject cancellation side effects");
                },
                terminalCode: "job/cancelled",
                terminalMessage: "Cancelled by the operator.",
            });

            expect(rejected).rejects.toThrow("reject cancellation side effects");
            await rejected.catch(() => {});
            expect(sideEffectRun).toMatchObject({
                eventCount: 3,
                finishedAt: new Date(5000),
                state: "cancelled",
                updatedAt: new Date(5000),
            });
            expect(repository.findRun(run.id)).toMatchObject({
                eventCount: 1,
                finishedAt: null,
                state: "queued",
                updatedAt: new Date(5000),
            });
            expect(
                repository
                    .listRunEvents({ limit: 10, runId: run.id })
                    .map(({ kind }) => kind)
            ).toEqual(["queued"]);
            let successfulSideEffectCount = 0;
            expect(
                await repository.cancelRun({
                    actor: { id: userId, kind: "user" },
                    at: new Date(2000),
                    id: run.id,
                    sideEffectsForRun: (cancelled) => {
                        successfulSideEffectCount += 1;
                        expect(cancelled).toMatchObject({
                            state: "cancelled",
                            updatedAt: new Date(5000),
                        });
                        return noSideEffects;
                    },
                    terminalCode: "job/cancelled",
                    terminalMessage: "Cancelled by the operator.",
                })
            ).toMatchObject({ kind: "cancelled" });
            expect(
                await repository.cancelRun({
                    actor: { id: userId, kind: "user" },
                    at: new Date(6000),
                    id: run.id,
                    sideEffectsForRun: () => {
                        throw new Error("terminal cancellation emitted side effects");
                    },
                    terminalCode: "job/cancelled",
                    terminalMessage: "Cancelled by the operator.",
                })
            ).toMatchObject({ kind: "terminal" });

            const [neverCancellableSchedule] = await repository.reconcileSchedules({
                at: new Date(6000),
                schedules: [
                    schedule({
                        cancellationPolicy: "never",
                        updatedAt: new Date(6000),
                    }),
                ],
                sideEffectsForSchedule: () => noSideEffects,
            });
            if (neverCancellableSchedule === undefined) {
                throw new Error("Missing never-cancellable schedule fixture");
            }
            const unsupportedRun = queuedRun(4001, {
                cancellationPolicy: "never",
                scheduledJobVersion: neverCancellableSchedule.version,
            });
            await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent(unsupportedRun),
                run: unsupportedRun,
            });
            expect(
                await repository.cancelRun({
                    actor: { id: userId, kind: "user" },
                    at: new Date(6000),
                    id: unsupportedRun.id,
                    sideEffectsForRun: () => {
                        throw new Error("unsupported cancellation emitted side effects");
                    },
                    terminalCode: "job/cancelled",
                    terminalMessage: "Cancelled by the operator.",
                })
            ).toMatchObject({ kind: "unsupported" });
            expect(successfulSideEffectCount).toBe(1);
            expect(database.orm.select().from(realtimeEvents).all()).toEqual([]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("retires schedules removed from the code-owned action registry", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const replacement = schedule({
            actionKey: "system.worker-smoke-v2",
            createdAt: new Date(2000),
            id: "system.worker-smoke-v2",
            nextRunAt: new Date(62_000),
            updatedAt: new Date(2000),
        });
        const original = schedule({
            createdAt: new Date(10_000),
            nextRunAt: new Date(70_000),
            updatedAt: new Date(10_000),
        });
        try {
            await repository.reconcileSchedules({
                at: new Date(10_000),
                schedules: [original],
                sideEffectsForSchedule: () => noSideEffects,
            });
            const rejectedRetirement = repository.reconcileSchedules({
                at: new Date(9000),
                schedules: [],
                sideEffectsForSchedule: (retired) => ({
                    auditEvents: [],
                    realtimeEvents: [
                        {
                            entityId: retired.id,
                            entityType: "schedule",
                            expiresAt: retired.updatedAt,
                            occurredAt: retired.updatedAt,
                            operation: "updated",
                            payloadJson: JSON.stringify({ id: retired.id }),
                            topic: "schedules.records",
                        },
                    ],
                }),
            });
            expect(rejectedRetirement).rejects.toThrow();
            await rejectedRetirement.catch(() => {});
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({
                enabled: true,
                updatedAt: new Date(10_000),
                version: 1,
            });
            const queuedScheduleRun = queuedRun(42, {
                availableAt: new Date(100_000),
                queuedAt: new Date(100_000),
                requestedById: "job-scheduler",
                requestedByKind: "system",
                scheduledForAt: new Date(70_000),
                triggerType: "schedule",
                updatedAt: new Date(100_000),
            });
            expect(
                await repository.enqueueNextDueSchedule({
                    ...noSideEffects,
                    at: new Date(100_000),
                    nextRunAt: new Date(130_000),
                    observedNextRunAt: new Date(70_000),
                    run: queuedScheduleRun,
                    scheduleId: "system.worker-smoke",
                })
            ).toMatchObject({ kind: "inserted" });
            let rolledBackCancellation: ReturnType<typeof repository.findRun>;
            const rejectedQueuedRetirement = repository.reconcileSchedules({
                at: new Date(9000),
                retiredRunCancellation: {
                    actor: { id: "job-scheduler", kind: "system" },
                    sideEffectsForRun: (cancelled) => {
                        rolledBackCancellation = cancelled;
                        throw new Error("reject retirement cancellation side effects");
                    },
                    terminalCode: "cancelled/schedule-retired",
                    terminalMessage: "Cancelled because the schedule was retired",
                },
                schedules: [replacement],
                sideEffectsForSchedule: () => noSideEffects,
            });
            expect(rejectedQueuedRetirement).rejects.toThrow(
                "reject retirement cancellation side effects"
            );
            await rejectedQueuedRetirement.catch(() => {});
            expect(rolledBackCancellation).toMatchObject({
                eventCount: 3,
                state: "cancelled",
                updatedAt: new Date(100_000),
            });
            expect(repository.findRun(queuedScheduleRun.id)).toMatchObject({
                eventCount: 1,
                state: "queued",
                updatedAt: new Date(100_000),
            });
            expect(repository.findSchedule(replacement.id)).toBeUndefined();
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({
                enabled: true,
                nextRunAt: new Date(130_000),
                updatedAt: new Date(10_000),
                version: 1,
            });
            const reconciledRows: Array<{
                readonly id: string;
                readonly updatedAt: Date;
            }> = [];
            let cancellationSideEffectAt: Date | undefined;
            const [registered] = await repository.reconcileSchedules({
                at: new Date(9000),
                retiredRunCancellation: {
                    actor: { id: "job-scheduler", kind: "system" },
                    sideEffectsForRun: (cancelled) => {
                        cancellationSideEffectAt = cancelled.updatedAt;
                        return noSideEffects;
                    },
                    terminalCode: "cancelled/schedule-retired",
                    terminalMessage: "Cancelled because the schedule was retired",
                },
                schedules: [replacement],
                sideEffectsForSchedule: (changedSchedule) => {
                    reconciledRows.push({
                        id: changedSchedule.id,
                        updatedAt: changedSchedule.updatedAt,
                    });
                    return noSideEffects;
                },
            });

            expect(registered).toMatchObject({
                enabled: true,
                id: "system.worker-smoke-v2",
                version: 1,
            });
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({
                enabled: false,
                nextRunAt: new Date(70_000),
                updatedAt: new Date(10_000),
                version: 2,
            });
            expect(reconciledRows).toEqual([
                { id: "system.worker-smoke-v2", updatedAt: new Date(2000) },
                { id: "system.worker-smoke", updatedAt: new Date(10_000) },
            ]);
            expect(cancellationSideEffectAt).toEqual(new Date(100_000));
            expect(repository.findRun(queuedScheduleRun.id)).toMatchObject({
                state: "cancelled",
                terminalCode: "cancelled/schedule-retired",
                updatedAt: new Date(100_000),
            });
            expect(
                repository.listDueSchedules({ at: new Date(70_000) }).map(({ id }) => id)
            ).toEqual(["system.worker-smoke-v2"]);

            await repository.reconcileSchedules({
                at: new Date(3000),
                schedules: [replacement],
                sideEffectsForSchedule: () => noSideEffects,
            });
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({
                enabled: false,
                updatedAt: new Date(10_000),
                version: 2,
            });

            const [reintroduced] = await repository.reconcileSchedules({
                at: new Date(11_000),
                schedules: [original, replacement],
                sideEffectsForSchedule: () => noSideEffects,
            });
            expect(reintroduced).toMatchObject({
                enabled: false,
                id: "system.worker-smoke",
                nextRunAt: new Date(70_000),
                version: 2,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("expires a removed schedule intent without re-enabling its schedule", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const disableIntentId = uuid(23);
        try {
            await repository.reconcileSchedules({
                at: new Date(1000),
                schedules: [schedule()],
                sideEffectsForSchedule: () => noSideEffects,
            });
            await repository.updateSchedule({
                ...noSideEffects,
                at: new Date(2000),
                expectedActiveDisableIntentId: null,
                expectedVersion: 1,
                id: "system.worker-smoke",
                insertDisableIntent: {
                    createdAt: new Date(2000),
                    createdById: userId,
                    createdByKind: "user",
                    endedAt: null,
                    endedById: null,
                    endedByKind: null,
                    endedReason: null,
                    expiresAt: new Date(3000),
                    externalJobId: null,
                    externalProvider: null,
                    id: disableIntentId,
                    reason: "Pause until after the action is retired",
                    scheduledJobId: "system.worker-smoke",
                    targetKind: "dashboard-schedule",
                },
                patch: { enabled: false },
            });
            await repository.reconcileSchedules({
                at: new Date(2500),
                schedules: [],
                sideEffectsForSchedule: () => noSideEffects,
            });

            let nextRunCalls = 0;
            let sideEffectAt: Date | undefined;
            const [expired] = await repository.expireDisableIntents({
                at: new Date(4000),
                canReenableSchedule: () => false,
                nextRunAt: () => {
                    nextRunCalls += 1;
                    return new Date(64_000);
                },
                sideEffectsForSchedule: (disabledSchedule, closedIntent) => {
                    expect(disabledSchedule.enabled).toBe(false);
                    sideEffectAt = closedIntent.endedAt ?? undefined;
                    return noSideEffects;
                },
                systemActorId: "job-scheduler",
            });

            expect(expired).toMatchObject({
                intent: {
                    endedAt: new Date(4000),
                    endedByKind: "system",
                    endedReason: "expired",
                    id: disableIntentId,
                },
                kind: "left-disabled",
                schedule: {
                    enabled: false,
                    nextRunAt: new Date(61_000),
                    version: 2,
                },
            });
            expect(nextRunCalls).toBe(0);
            expect(sideEffectAt).toEqual(new Date(4000));
            expect(
                repository.findActiveDisableIntent("system.worker-smoke")
            ).toBeUndefined();
            expect(
                await repository.updateSchedule({
                    ...noSideEffects,
                    at: new Date(5000),
                    expectedActiveDisableIntentId: disableIntentId,
                    expectedVersion: 2,
                    id: "system.worker-smoke",
                    patch: { enabled: true, nextRunAt: new Date(65_000) },
                })
            ).toMatchObject({ kind: "version-changed" });
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
                at: new Date(1000),
                schedules: [schedule()],
                sideEffectsForSchedule: () => noSideEffects,
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

            const disableAt = new Date(50_000);
            const disableIntent = {
                createdAt: disableAt,
                createdById: userId,
                createdByKind: "user" as const,
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
                targetKind: "dashboard-schedule" as const,
            };
            let rolledBackCancellation: ReturnType<typeof repository.findRun>;
            const rejectedDisable = repository.updateSchedule({
                ...noSideEffects,
                at: disableAt,
                expectedActiveDisableIntentId: null,
                expectedVersion: 1,
                id: "system.worker-smoke",
                insertDisableIntent: disableIntent,
                patch: { enabled: false },
                queuedCancellation: {
                    at: disableAt,
                    terminalCode: "schedule/disabled",
                    terminalMessage: "The schedule was disabled before execution.",
                },
                queuedCancellationSideEffects: (cancelled) => {
                    rolledBackCancellation = cancelled;
                    throw new Error("reject schedule cancellation side effects");
                },
            });
            expect(rejectedDisable).rejects.toThrow(
                "reject schedule cancellation side effects"
            );
            await rejectedDisable.catch(() => {});
            expect(rolledBackCancellation).toMatchObject({
                eventCount: 3,
                state: "cancelled",
                updatedAt: new Date(100_000),
            });
            expect(repository.findRun(run.id)).toMatchObject({
                eventCount: 1,
                state: "queued",
                updatedAt: new Date(100_000),
            });
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({ enabled: true, updatedAt: new Date(1000), version: 1 });
            expect(
                repository.findActiveDisableIntent("system.worker-smoke")
            ).toBeUndefined();

            let cancellationSideEffectAt: Date | undefined;
            const disabled = await repository.updateSchedule({
                ...noSideEffects,
                at: disableAt,
                expectedActiveDisableIntentId: null,
                expectedVersion: 1,
                id: "system.worker-smoke",
                insertDisableIntent: disableIntent,
                patch: { enabled: false },
                queuedCancellation: {
                    at: disableAt,
                    terminalCode: "schedule/disabled",
                    terminalMessage: "The schedule was disabled before execution.",
                },
                queuedCancellationSideEffects: (cancelled) => {
                    cancellationSideEffectAt = cancelled.updatedAt;
                    return noSideEffects;
                },
            });
            expect(disabled).toMatchObject({
                kind: "updated",
                schedule: {
                    enabled: false,
                    nextRunAt: new Date(121_000),
                    updatedAt: disableAt,
                    version: 2,
                },
            });
            expect(cancellationSideEffectAt).toEqual(new Date(100_000));
            expect(repository.findRun(run.id)).toMatchObject({
                eventCount: 3,
                state: "cancelled",
                terminalCode: "schedule/disabled",
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("blocks a singleton due action while a manual run for that action is active", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            await repository.reconcileSchedules({
                at: new Date(1000),
                schedules: [schedule()],
                sideEffectsForSchedule: () => noSideEffects,
            });
            const manualRun = queuedRun(30, {
                scheduledJobId: null,
                scheduledJobVersion: null,
                triggerType: "system",
            });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(manualRun),
                    run: manualRun,
                })
            ).toMatchObject({ kind: "inserted" });

            const scheduledRun = queuedRun(31, {
                availableAt: new Date(100_000),
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
                    rejectWhenActionActive: true,
                    run: scheduledRun,
                    scheduleId: "system.worker-smoke",
                })
            ).toMatchObject({ kind: "active", run: { id: manualRun.id } });
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(61_000));
            expect(repository.findRun(scheduledRun.id)).toBeUndefined();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects a stale due execution snapshot before enqueueing", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            await repository.reconcileSchedules({
                at: new Date(1000),
                schedules: [schedule()],
                sideEffectsForSchedule: () => noSideEffects,
            });
            const staleRun = queuedRun(23, {
                availableAt: new Date(100_000),
                queuedAt: new Date(100_000),
                requestedById: "job-scheduler",
                requestedByKind: "system",
                scheduledForAt: new Date(61_000),
                triggerType: "schedule",
                updatedAt: new Date(100_000),
            });
            const [updatedSchedule] = await repository.reconcileSchedules({
                at: new Date(2000),
                schedules: [
                    schedule({
                        actionKey: "system.worker-smoke-v2",
                        name: "Updated worker smoke",
                        updatedAt: new Date(2000),
                    }),
                ],
                sideEffectsForSchedule: () => noSideEffects,
            });
            expect(updatedSchedule).toMatchObject({
                actionKey: "system.worker-smoke-v2",
                nextRunAt: new Date(61_000),
                version: 2,
            });

            expect(
                await repository.enqueueNextDueSchedule({
                    ...noSideEffects,
                    at: new Date(100_000),
                    nextRunAt: new Date(121_000),
                    observedNextRunAt: new Date(61_000),
                    run: staleRun,
                    scheduleId: "system.worker-smoke",
                })
            ).toMatchObject({ kind: "state-changed", schedule: { version: 2 } });
            expect(repository.findRun(staleRun.id)).toBeUndefined();
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(61_000));

            const currentRun = {
                ...staleRun,
                actionKey: "system.worker-smoke-v2",
                displayName: "Updated worker smoke",
                id: uuid(24),
                idempotencyKey: idempotencyKey(24),
                scheduledJobVersion: 2,
            };
            const currentInput = {
                ...noSideEffects,
                at: new Date(100_000),
                nextRunAt: new Date(121_000),
                observedNextRunAt: new Date(61_000),
                run: currentRun,
                scheduleId: "system.worker-smoke",
            };
            expect(await repository.enqueueNextDueSchedule(currentInput)).toMatchObject({
                kind: "inserted",
                run: { id: currentRun.id },
            });
            expect(await repository.enqueueNextDueSchedule(currentInput)).toMatchObject({
                kind: "inserted",
                run: { id: currentRun.id },
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
                at: new Date(1000),
                schedules: [schedule(), schedule({ id: "system.worker-smoke-rollback" })],
                sideEffectsForSchedule: () => noSideEffects,
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
                    expectedActiveDisableIntentId: null,
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
                canReenableSchedule: () => true,
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
                expectedActiveDisableIntentId: null,
                expectedVersion: 1,
                id: "system.worker-smoke-rollback",
                insertDisableIntent: rollbackIntent,
                patch: { enabled: false },
            });
            const rejectedExpiry = repository.expireDisableIntents({
                at: new Date(4000),
                canReenableSchedule: () => true,
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
            });
            expect(rejectedExpiry).rejects.toThrow();
            await rejectedExpiry.catch(() => {});
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

    test("rejects operator disabling but retires around a queued never-cancellable run", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        try {
            await repository.reconcileSchedules({
                at: new Date(1000),
                schedules: [schedule({ cancellationPolicy: "never" })],
                sideEffectsForSchedule: () => noSideEffects,
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
                expectedActiveDisableIntentId: null,
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
            const rejectedRetirement = repository.reconcileSchedules({
                at: new Date(900),
                retiredRunCancellation: {
                    actor: { id: "job-scheduler", kind: "system" },
                    sideEffectsForRun: () => {
                        throw new Error("retirement cancelled never-cancellable work");
                    },
                    terminalCode: "cancelled/schedule-retired",
                    terminalMessage: "Cancelled because the schedule was retired",
                },
                schedules: [],
                sideEffectsForSchedule: () => {
                    throw new Error("reject retirement schedule side effects");
                },
            });
            expect(rejectedRetirement).rejects.toThrow(
                "reject retirement schedule side effects"
            );
            await rejectedRetirement.catch(() => {});
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({
                enabled: true,
                version: 1,
            });
            expect(repository.findRun(run.id)).toMatchObject({
                cancelRequestedAt: null,
                eventCount: 1,
                state: "queued",
            });

            const retiredSchedules: Array<{
                readonly id: string;
                readonly updatedAt: Date;
                readonly version: number;
            }> = [];
            await repository.reconcileSchedules({
                at: new Date(900),
                retiredRunCancellation: {
                    actor: { id: "job-scheduler", kind: "system" },
                    sideEffectsForRun: () => {
                        throw new Error("retirement cancelled never-cancellable work");
                    },
                    terminalCode: "cancelled/schedule-retired",
                    terminalMessage: "Cancelled because the schedule was retired",
                },
                schedules: [],
                sideEffectsForSchedule: (retired) => {
                    retiredSchedules.push({
                        id: retired.id,
                        updatedAt: retired.updatedAt,
                        version: retired.version,
                    });
                    return noSideEffects;
                },
            });

            expect(retiredSchedules).toEqual([
                {
                    id: "system.worker-smoke",
                    updatedAt: new Date(1000),
                    version: 2,
                },
            ]);
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({
                enabled: false,
                updatedAt: new Date(1000),
                version: 2,
            });
            expect(repository.findRun(run.id)).toMatchObject({
                cancelRequestedAt: null,
                eventCount: 1,
                state: "queued",
                updatedAt: new Date(100_000),
            });

            await repository.reconcileSchedules({
                at: new Date(130_000),
                retiredRunCancellation: {
                    actor: { id: "job-scheduler", kind: "system" },
                    sideEffectsForRun: () => {
                        throw new Error("idempotent retirement touched the run");
                    },
                    terminalCode: "cancelled/schedule-retired",
                    terminalMessage: "Cancelled because the schedule was retired",
                },
                schedules: [],
                sideEffectsForSchedule: () => {
                    throw new Error("idempotent retirement emitted schedule effects");
                },
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("retires schedules without cancelling running or manual work", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const runningScheduleId = "system.worker-smoke-running";
        const manualScheduleId = "system.worker-smoke-manual";
        const runningRun = queuedRun(75, {
            availableAt: new Date(100_000),
            queuedAt: new Date(100_000),
            requestedById: "job-scheduler",
            requestedByKind: "system",
            scheduledForAt: new Date(61_000),
            scheduledJobId: runningScheduleId,
            triggerType: "schedule",
            updatedAt: new Date(100_000),
        });
        const manualRun = queuedRun(76, { scheduledJobId: manualScheduleId });
        const leaseToken = uuid(176);

        try {
            await repository.reconcileSchedules({
                at: new Date(1000),
                schedules: [
                    schedule({ id: runningScheduleId }),
                    schedule({ id: manualScheduleId }),
                ],
                sideEffectsForSchedule: () => noSideEffects,
            });
            await repository.enqueueNextDueSchedule({
                ...noSideEffects,
                at: new Date(100_000),
                nextRunAt: new Date(121_000),
                observedNextRunAt: new Date(61_000),
                run: runningRun,
                scheduleId: runningScheduleId,
            });
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            expect(
                await repository.claimNextRun({
                    at: new Date(101_000),
                    leaseExpiresAt: new Date(130_000),
                    leaseToken,
                    minimumHeartbeatAt: new Date(1000),
                    sideEffectsForClaim: () => noSideEffects,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "claimed", run: { id: runningRun.id } });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(manualRun),
                    run: manualRun,
                })
            ).toMatchObject({ kind: "inserted" });

            await repository.reconcileSchedules({
                at: new Date(50_000),
                retiredRunCancellation: {
                    actor: { id: "job-scheduler", kind: "system" },
                    sideEffectsForRun: () => {
                        throw new Error("retirement touched preserved work");
                    },
                    terminalCode: "cancelled/schedule-retired",
                    terminalMessage: "Cancelled because the schedule was retired",
                },
                schedules: [],
                sideEffectsForSchedule: () => noSideEffects,
            });

            expect(repository.findRun(runningRun.id)).toMatchObject({
                cancelRequestedAt: null,
                leaseToken,
                state: "running",
                updatedAt: new Date(101_000),
            });
            expect(repository.findRun(manualRun.id)).toMatchObject({
                cancelRequestedAt: null,
                eventCount: 1,
                state: "queued",
            });
            expect(repository.findSchedule(runningScheduleId)?.schedule).toMatchObject({
                enabled: false,
                updatedAt: new Date(50_000),
                version: 2,
            });
            expect(repository.findSchedule(manualScheduleId)?.schedule).toMatchObject({
                enabled: false,
                updatedAt: new Date(50_000),
                version: 2,
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
            expect(
                await repository.appendClaimEvent({
                    at: new Date(25_000),
                    kind: "progress",
                    leaseToken: uuid(100),
                    progressJson: '{"percent":25}',
                    runId: runs[0]?.id ?? "",
                    sideEffectsForRun: () => noSideEffects,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "appended" });
            expect(
                await repository.renewClaim({
                    at: new Date(20_000),
                    leaseExpiresAt: new Date(30_000),
                    leaseToken: uuid(100),
                    runId: runs[0]?.id ?? "",
                    workerId: workerOneId,
                })
            ).toMatchObject({
                kind: "renewed",
                run: {
                    heartbeatAt: new Date(25_000),
                    leaseExpiresAt: new Date(35_000),
                    updatedAt: new Date(25_000),
                },
            });
            expect(
                database.orm
                    .select()
                    .from(resourceLeases)
                    .where(eq(resourceLeases.jobRunId, runs[0]?.id ?? ""))
                    .get()
            ).toMatchObject({
                expiresAt: new Date(35_000),
                renewedAt: new Date(25_000),
            });
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
            let eventSideEffectAt: Date | undefined;
            expect(
                await repository.appendClaimEvent({
                    at: new Date(5000),
                    kind: "progress",
                    leaseToken: uuid(101),
                    progressJson: '{"percent":50}',
                    runId: runs[2]?.id ?? "",
                    sideEffectsForRun: (updated) => {
                        eventSideEffectAt = updated.updatedAt;
                        return createJobRealtimeSideEffects({
                            occurredAt: updated.updatedAt,
                            realtime: {
                                id: updated.id,
                                kind: "run",
                                operation: "updated",
                            },
                        });
                    },
                    workerId: workerTwoId,
                })
            ).toMatchObject({ kind: "appended" });
            expect(eventSideEffectAt).toEqual(new Date(5000));
            expect(database.orm.select().from(realtimeEvents).all()).toEqual([
                expect.objectContaining({
                    entityId: runs[2]?.id,
                    entityType: "job-run",
                    occurredAt: new Date(5000),
                    operation: "updated",
                    payloadJson: JSON.stringify({ id: runs[2]?.id }),
                    topic: "jobs.runs",
                }),
            ]);
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
            expect(settlementSideEffectAt).toEqual(new Date(25_000));

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

    test("settles a durable cancellation that races worker shutdown as cancelled", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const run = queuedRun(34, {
            requestedById: "job-scheduler",
            requestedByKind: "system",
            resourceKeysJson: '["database"]',
            scheduledJobId: null,
            scheduledJobVersion: null,
            triggerType: "system",
        });
        const leaseToken = uuid(134);
        const shutdownOutcome = {
            kind: "failed" as const,
            retryAt: new Date(21_000),
            terminalCode: "worker-shutdown",
            terminalMessage: "The worker stopped before the action completed.",
        };
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
                    at: new Date(3000),
                    leaseExpiresAt: new Date(30_000),
                    leaseToken,
                    minimumHeartbeatAt: new Date(1000),
                    sideEffectsForClaim: () => noSideEffects,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "claimed", run: { id: run.id } });
            let rejectedCancelRun: ReturnType<typeof repository.findRun>;
            const rejectedCancel = repository.cancelRun({
                actor: { id: userId, kind: "user" },
                at: new Date(20_000),
                id: run.id,
                sideEffectsForRun: (requested) => {
                    rejectedCancelRun = requested;
                    throw new Error("reject cancel-request side effects");
                },
                terminalCode: "cancelled/operator-request",
                terminalMessage: "Cancelled by the operator.",
            });
            expect(rejectedCancel).rejects.toThrow("reject cancel-request side effects");
            await rejectedCancel.catch(() => {});
            expect(rejectedCancelRun).toMatchObject({
                cancelRequestedAt: new Date(20_000),
                eventCount: 3,
                state: "running",
                updatedAt: new Date(20_000),
            });
            expect(repository.findRun(run.id)).toMatchObject({
                cancelRequestedAt: null,
                eventCount: 2,
                state: "running",
                updatedAt: new Date(3000),
            });
            expect(
                await repository.cancelRun({
                    actor: { id: userId, kind: "user" },
                    at: new Date(20_000),
                    id: run.id,
                    sideEffectsForRun: () => noSideEffects,
                    terminalCode: "cancelled/operator-request",
                    terminalMessage: "Cancelled by the operator.",
                })
            ).toMatchObject({ kind: "requested" });

            let rolledBackSideEffectRun:
                | NonNullable<ReturnType<typeof repository.findRun>>
                | undefined;
            const rejectedSettlement = repository.settleClaim({
                at: new Date(6000),
                leaseToken,
                outcome: shutdownOutcome,
                runId: run.id,
                sideEffectsForRun: (settled) => {
                    rolledBackSideEffectRun = settled;
                    throw new Error("reject settlement side effects");
                },
                workerId: workerOneId,
            });
            expect(rejectedSettlement).rejects.toThrow("reject settlement side effects");
            await rejectedSettlement.catch(() => {});
            expect(rolledBackSideEffectRun).toMatchObject({
                finishedAt: new Date(20_000),
                state: "cancelled",
                terminalCode: "cancel-requested",
                terminalMessage: "The job action was cancelled.",
                updatedAt: new Date(20_000),
            });
            expect(repository.findRun(run.id)).toMatchObject({
                cancelRequestedAt: new Date(20_000),
                eventCount: 3,
                finishedAt: null,
                leaseToken,
                state: "running",
                updatedAt: new Date(20_000),
            });
            expect(
                database.orm
                    .select({ value: count() })
                    .from(resourceLeases)
                    .where(eq(resourceLeases.jobRunId, run.id))
                    .get()?.value
            ).toBe(1);

            let committedSideEffectRun:
                | NonNullable<ReturnType<typeof repository.findRun>>
                | undefined;
            expect(
                await repository.settleClaim({
                    at: new Date(6000),
                    leaseToken,
                    outcome: shutdownOutcome,
                    runId: run.id,
                    sideEffectsForRun: (settled) => {
                        committedSideEffectRun = settled;
                        return noSideEffects;
                    },
                    workerId: workerOneId,
                })
            ).toMatchObject({
                kind: "settled",
                run: {
                    eventCount: 4,
                    finishedAt: new Date(20_000),
                    state: "cancelled",
                    terminalCode: "cancel-requested",
                    terminalMessage: "The job action was cancelled.",
                    updatedAt: new Date(20_000),
                },
            });
            expect(committedSideEffectRun).toMatchObject({ state: "cancelled" });
            expect(
                repository
                    .listRunEvents({ limit: 10, runId: run.id })
                    .map(({ kind, message, occurredAt }) => ({
                        kind,
                        message,
                        occurredAt,
                    }))
            ).toEqual([
                {
                    kind: "cancelled",
                    message: "The job action was cancelled.",
                    occurredAt: new Date(20_000),
                },
                {
                    kind: "cancel-requested",
                    message: null,
                    occurredAt: new Date(20_000),
                },
                { kind: "claimed", message: null, occurredAt: new Date(3000) },
                {
                    kind: "queued",
                    message: null,
                    occurredAt: run.queuedAt,
                },
            ]);
            expect(
                database.orm
                    .select({ value: count() })
                    .from(resourceLeases)
                    .where(eq(resourceLeases.jobRunId, run.id))
                    .get()?.value
            ).toBe(0);

            let staleSideEffectCalled = false;
            expect(
                await repository.settleClaim({
                    at: new Date(20_001),
                    leaseToken,
                    outcome: shutdownOutcome,
                    runId: run.id,
                    sideEffectsForRun: () => {
                        staleSideEffectCalled = true;
                        return noSideEffects;
                    },
                    workerId: workerOneId,
                })
            ).toEqual({ kind: "lost-claim" });
            expect(staleSideEffectCalled).toBe(false);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("claims runnable work after a full page of resource-conflicted runs", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const systemRun = {
            requestedById: "job-scheduler",
            requestedByKind: "system",
            scheduledJobId: null,
            scheduledJobVersion: null,
            triggerType: "system",
        } satisfies Partial<JobRunInsert>;
        const resourceHolder = queuedRun(40, {
            ...systemRun,
            resourceKeysJson: '["database"]',
        });
        try {
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(resourceHolder),
                    run: resourceHolder,
                })
            ).toMatchObject({ kind: "inserted" });
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerTwoId, 2),
            });
            expect(
                await repository.claimNextRun({
                    at: new Date(10_000),
                    leaseExpiresAt: new Date(30_000),
                    leaseToken: uuid(140),
                    minimumHeartbeatAt: new Date(1000),
                    sideEffectsForClaim: () => noSideEffects,
                    workerId: workerOneId,
                })
            ).toMatchObject({
                kind: "claimed",
                run: { id: resourceHolder.id },
            });

            const conflictedRuns = Array.from({ length: 32 }, (_, index) =>
                queuedRun(100 + index, {
                    ...systemRun,
                    resourceKeysJson: '["database"]',
                })
            );
            const runnableRun = queuedRun(132, {
                ...systemRun,
                resourceKeysJson: '["network"]',
            });
            for (const run of [...conflictedRuns, runnableRun]) {
                expect(
                    await repository.enqueueManualRun({
                        ...noSideEffects,
                        queuedEvent: queuedEvent(run),
                        run,
                    })
                ).toMatchObject({ kind: "inserted" });
            }

            const firstPage = await repository.claimNextRun({
                at: new Date(11_000),
                leaseExpiresAt: new Date(31_000),
                leaseToken: uuid(141),
                minimumHeartbeatAt: new Date(1000),
                sideEffectsForClaim: () => noSideEffects,
                workerId: workerTwoId,
            });
            expect(firstPage).toMatchObject({
                cursor: { id: conflictedRuns.at(-1)?.id },
                kind: "page-exhausted",
            });
            expect(repository.findRun(runnableRun.id)).toMatchObject({
                state: "queued",
            });
            if (firstPage.kind !== "page-exhausted") {
                throw new Error("Expected the bounded claim page to be exhausted");
            }
            expect(firstPage.cursor.availableThrough).toEqual(new Date(11_000));
            const futureTail = queuedRun(10_500, {
                ...systemRun,
                resourceKeysJson: '["network.future"]',
            });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(futureTail),
                    run: futureTail,
                })
            ).toMatchObject({ kind: "inserted" });
            expect(
                await repository.claimNextRun({
                    at: new Date(12_000),
                    cursor: firstPage.cursor,
                    leaseExpiresAt: new Date(32_000),
                    leaseToken: uuid(142),
                    minimumHeartbeatAt: new Date(1000),
                    sideEffectsForClaim: () => noSideEffects,
                    workerId: workerTwoId,
                })
            ).toMatchObject({
                kind: "claimed",
                run: { id: runnableRun.id },
            });
            expect(
                await repository.claimNextRun({
                    at: new Date(12_000),
                    cursor: firstPage.cursor,
                    leaseExpiresAt: new Date(32_000),
                    leaseToken: uuid(143),
                    minimumHeartbeatAt: new Date(1000),
                    sideEffectsForClaim: () => noSideEffects,
                    workerId: workerTwoId,
                })
            ).toEqual({ kind: "empty" });
            expect(repository.findRun(futureTail.id)).toMatchObject({ state: "queued" });
            expect(repository.findRun(conflictedRuns[0]?.id ?? "")).toMatchObject({
                state: "queued",
            });
            expect(repository.findRun(conflictedRuns.at(-1)?.id ?? "")).toMatchObject({
                state: "queued",
            });
            expect(
                database.orm
                    .select({
                        jobRunId: resourceLeases.jobRunId,
                        resourceKey: resourceLeases.resourceKey,
                    })
                    .from(resourceLeases)
                    .all()
            ).toEqual([
                { jobRunId: resourceHolder.id, resourceKey: "database" },
                { jobRunId: runnableRun.id, resourceKey: "network" },
            ]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("concatenates every mixed-order claim cursor range", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const systemRun = {
            requestedById: "job-scheduler",
            requestedByKind: "system",
            scheduledJobId: null,
            scheduledJobVersion: null,
            triggerType: "system",
        } satisfies Partial<JobRunInsert>;
        const runAt = (
            index: number,
            availableAtMs: number,
            priority: number,
            queuedAtMs: number,
            resourceKey: string
        ): JobRunInsert =>
            queuedRun(index, {
                ...systemRun,
                availableAt: new Date(availableAtMs),
                priority,
                queuedAt: new Date(queuedAtMs),
                resourceKeysJson: JSON.stringify([resourceKey]),
                updatedAt: new Date(queuedAtMs),
            });
        const resourceHolder = runAt(350, 1500, 100, 1500, "database");
        const cursor = {
            availableAt: new Date(5000),
            availableThrough: new Date(6000),
            id: uuid(400),
            priority: 10,
            queuedAt: new Date(4000),
        } as const;
        const candidates = [
            runAt(401, 5000, 10, 4000, "database"),
            runAt(402, 5000, 10, 4001, "database"),
            runAt(403, 5000, 9, 3000, "database"),
            runAt(404, 5001, 100, 3000, "network"),
        ];
        try {
            for (const run of [resourceHolder, ...candidates]) {
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
            expect(
                await repository.claimNextRun({
                    at: new Date(3000),
                    leaseExpiresAt: new Date(30_000),
                    leaseToken: uuid(450),
                    minimumHeartbeatAt: new Date(1000),
                    sideEffectsForClaim: () => noSideEffects,
                    workerId: workerOneId,
                })
            ).toMatchObject({
                kind: "claimed",
                run: { id: resourceHolder.id },
            });

            expect(
                await repository.claimNextRun({
                    at: new Date(6000),
                    cursor,
                    leaseExpiresAt: new Date(36_000),
                    leaseToken: uuid(451),
                    minimumHeartbeatAt: new Date(1000),
                    sideEffectsForClaim: () => noSideEffects,
                    workerId: workerTwoId,
                })
            ).toMatchObject({
                kind: "claimed",
                run: { id: candidates[3]?.id },
            });
            expect(
                candidates.slice(0, 3).map((run) => repository.findRun(run.id)?.state)
            ).toEqual(["queued", "queued", "queued"]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("filters stale workers before bounding the queue summary", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const minimumHeartbeatAt = new Date(10_000);
        const boundaryWorkerId = uuid(10_000);
        try {
            for (let index = 0; index < jobWorkerSummaryMaximum + 1; index += 1) {
                await repository.registerWorker({
                    ...noSideEffects,
                    worker: {
                        ...worker(uuid(200 + index)),
                        heartbeatAt: new Date(minimumHeartbeatAt.getTime() - 1),
                    },
                });
            }
            await repository.registerWorker({
                ...noSideEffects,
                worker: {
                    ...worker(boundaryWorkerId),
                    heartbeatAt: minimumHeartbeatAt,
                },
            });

            expect(repository.readQueueState({ minimumHeartbeatAt }).workers).toEqual([
                {
                    activeRunCount: 0,
                    worker: expect.objectContaining({
                        heartbeatAt: minimumHeartbeatAt,
                        id: boundaryWorkerId,
                        state: "online",
                    }),
                },
            ]);
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
                        sideEffectsForRun: () => noSideEffects,
                        workerId: workerOneId,
                    })
                ).toMatchObject({ kind: "appended" });
            }

            let truncatedSideEffects = 0;
            const sideEffectsForTruncation = (
                updated: NonNullable<ReturnType<typeof repository.findRun>>
            ) => {
                truncatedSideEffects += 1;
                return createJobRealtimeSideEffects({
                    occurredAt: updated.updatedAt,
                    realtime: {
                        id: updated.id,
                        kind: "run",
                        operation: "updated",
                    },
                });
            };
            expect(
                await repository.appendClaimEvent({
                    at: new Date(4100),
                    kind: "stdout",
                    leaseToken,
                    message: "budget exhausted",
                    runId: run.id,
                    sideEffectsForRun: sideEffectsForTruncation,
                    workerId: workerOneId,
                })
            ).toMatchObject({
                event: { kind: "output-truncated" },
                kind: "truncated",
            });
            expect(
                await repository.appendClaimEvent({
                    at: new Date(4101),
                    kind: "stdout",
                    leaseToken,
                    message: "still exhausted",
                    runId: run.id,
                    sideEffectsForRun: sideEffectsForTruncation,
                    workerId: workerOneId,
                })
            ).toEqual({ kind: "dropped" });
            expect(truncatedSideEffects).toBe(1);
            expect(database.orm.select().from(realtimeEvents).all()).toHaveLength(1);

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
                    eventCount: 93,
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

    test("derives worker lifecycle side effects from clock-clamped durable state", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const drainAt = new Date(10_000);
        const stopAt = new Date(15_000);
        const callbackWorkers: Array<{
            readonly heartbeatAt: Date;
            readonly state: "draining" | "stopped";
        }> = [];
        try {
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            await repository.heartbeatWorker({ at: drainAt, workerId: workerOneId });

            expect(
                await repository.beginWorkerDrain({
                    at: new Date(7000),
                    sideEffectsForWorker: (durableWorker) => {
                        callbackWorkers.push({
                            heartbeatAt: durableWorker.heartbeatAt,
                            state: "draining",
                        });
                        expect(durableWorker).toMatchObject({
                            drainingAt: drainAt,
                            heartbeatAt: drainAt,
                            state: "draining",
                        });
                        return createJobRealtimeSideEffects({
                            occurredAt: durableWorker.heartbeatAt,
                            realtime: { id: durableWorker.id, kind: "queue" },
                        });
                    },
                    workerId: workerOneId,
                })
            ).toMatchObject({
                kind: "updated",
                worker: {
                    drainingAt: drainAt,
                    heartbeatAt: drainAt,
                    state: "draining",
                },
            });
            await repository.heartbeatWorker({ at: stopAt, workerId: workerOneId });
            expect(
                await repository.stopWorker({
                    at: new Date(8000),
                    sideEffectsForWorker: (durableWorker) => {
                        callbackWorkers.push({
                            heartbeatAt: durableWorker.heartbeatAt,
                            state: "stopped",
                        });
                        expect(durableWorker).toMatchObject({
                            drainingAt: drainAt,
                            heartbeatAt: stopAt,
                            state: "stopped",
                            stoppedAt: stopAt,
                        });
                        return createJobRealtimeSideEffects({
                            occurredAt: durableWorker.heartbeatAt,
                            realtime: { id: durableWorker.id, kind: "queue" },
                        });
                    },
                    workerId: workerOneId,
                })
            ).toMatchObject({
                kind: "updated",
                worker: {
                    drainingAt: drainAt,
                    heartbeatAt: stopAt,
                    state: "stopped",
                    stoppedAt: stopAt,
                },
            });

            expect(callbackWorkers).toEqual([
                { heartbeatAt: drainAt, state: "draining" },
                { heartbeatAt: stopAt, state: "stopped" },
            ]);
            expect(
                database.orm
                    .select({ occurredAt: realtimeEvents.occurredAt })
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.entityId, workerOneId))
                    .orderBy(asc(realtimeEvents.occurredAt))
                    .all()
                    .map(({ occurredAt }) => occurredAt)
            ).toEqual([drainAt, stopAt]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rolls worker lifecycle mutations back when their callback fails", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const readWorker = () =>
            database.orm
                .select()
                .from(workerInstances)
                .where(eq(workerInstances.id, workerOneId))
                .get();
        try {
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            let drainCallbackCalls = 0;
            const rejectedDrain = repository.beginWorkerDrain({
                at: new Date(5000),
                sideEffectsForWorker: (durableWorker) => {
                    drainCallbackCalls += 1;
                    expect(durableWorker).toMatchObject({
                        drainingAt: new Date(5000),
                        heartbeatAt: new Date(5000),
                        state: "draining",
                    });
                    throw new Error("reject drain side effects");
                },
                workerId: workerOneId,
            });
            expect(rejectedDrain).rejects.toThrow("reject drain side effects");
            await rejectedDrain.catch(() => {});
            expect(drainCallbackCalls).toBe(1);
            expect(readWorker()).toMatchObject({
                drainingAt: null,
                heartbeatAt: new Date(2000),
                state: "online",
                stoppedAt: null,
            });

            await repository.beginWorkerDrain({
                at: new Date(5000),
                sideEffectsForWorker: () => noSideEffects,
                workerId: workerOneId,
            });
            let stopCallbackCalls = 0;
            const rejectedStop = repository.stopWorker({
                at: new Date(7000),
                sideEffectsForWorker: (durableWorker) => {
                    stopCallbackCalls += 1;
                    expect(durableWorker).toMatchObject({
                        heartbeatAt: new Date(7000),
                        state: "stopped",
                        stoppedAt: new Date(7000),
                    });
                    throw new Error("reject stop side effects");
                },
                workerId: workerOneId,
            });
            expect(rejectedStop).rejects.toThrow("reject stop side effects");
            await rejectedStop.catch(() => {});
            expect(stopCallbackCalls).toBe(1);
            expect(readWorker()).toMatchObject({
                drainingAt: new Date(5000),
                heartbeatAt: new Date(5000),
                state: "draining",
                stoppedAt: null,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("does not invoke worker lifecycle callbacks without a state mutation", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const callbackStates: Array<"draining" | "stopped"> = [];
        const callback = (durableWorker: WorkerInstanceRecord) => {
            if (durableWorker.state === "online") {
                throw new Error("Lifecycle callback received an unmodified worker");
            }
            callbackStates.push(durableWorker.state);
            return noSideEffects;
        };
        try {
            expect(
                await repository.beginWorkerDrain({
                    at: new Date(3000),
                    sideEffectsForWorker: callback,
                    workerId: workerOneId,
                })
            ).toEqual({ kind: "not-found" });
            expect(
                await repository.stopWorker({
                    at: new Date(3000),
                    sideEffectsForWorker: callback,
                    workerId: workerOneId,
                })
            ).toEqual({ kind: "not-found" });
            expect(callbackStates).toEqual([]);

            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            expect(
                await repository.stopWorker({
                    at: new Date(3000),
                    sideEffectsForWorker: callback,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "state-changed", worker: { state: "online" } });
            expect(callbackStates).toEqual([]);

            expect(
                await repository.beginWorkerDrain({
                    at: new Date(3000),
                    sideEffectsForWorker: callback,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "updated", worker: { state: "draining" } });
            expect(callbackStates).toEqual(["draining"]);
            expect(
                await repository.beginWorkerDrain({
                    at: new Date(4000),
                    sideEffectsForWorker: callback,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "state-changed", worker: { state: "draining" } });
            expect(callbackStates).toEqual(["draining"]);

            expect(
                await repository.stopWorker({
                    at: new Date(5000),
                    sideEffectsForWorker: callback,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "updated", worker: { state: "stopped" } });
            expect(callbackStates).toEqual(["draining", "stopped"]);
            expect(
                await repository.stopWorker({
                    at: new Date(6000),
                    sideEffectsForWorker: callback,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "state-changed", worker: { state: "stopped" } });
            expect(callbackStates).toEqual(["draining", "stopped"]);
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

            const rejectedRecovery = repository.recoverExpiredClaims({
                at: new Date(6000),
                retryAt: () => new Date(7000),
                sideEffectsForRun: () => {
                    throw new Error("reject recovery side effects");
                },
            });
            expect(rejectedRecovery).rejects.toThrow("reject recovery side effects");
            await rejectedRecovery.catch(() => {});
            expect(repository.findRun(run.id)).toMatchObject({
                eventCount: 2,
                leaseToken: uuid(81),
                state: "running",
            });
            expect(
                database.orm
                    .select({ value: count() })
                    .from(resourceLeases)
                    .where(eq(resourceLeases.jobRunId, run.id))
                    .get()?.value
            ).toBe(1);

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
            expect(
                repository.readQueueState({ minimumHeartbeatAt: new Date(1000) })
            ).toMatchObject({
                control: { claimingPaused: false, version: 3 },
                stateCounts: { queued: 1, running: 0 },
                workers: [{ activeRunCount: 0, worker: { id: workerOneId } }],
            });
            await repository.cancelRun({
                actor: { id: userId, kind: "user" },
                at: new Date(7100),
                id: run.id,
                sideEffectsForRun: () => noSideEffects,
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
                actor: { id: userId, kind: "user" },
                at: new Date(20_000),
                id: regressedRun.id,
                sideEffectsForRun: () => noSideEffects,
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
                    at: new Date(7000),
                    sideEffectsForWorker: () => noSideEffects,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "updated", worker: { state: "draining" } });
            expect(
                await repository.stopWorker({
                    at: new Date(8000),
                    sideEffectsForWorker: () => noSideEffects,
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
            const rejectedEnqueue = repository.enqueueManualRun({
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
            });
            expect(rejectedEnqueue).rejects.toThrow();
            await rejectedEnqueue.catch(() => {});
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

    test("reads bounded active and terminal action-payload runs from one snapshot", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const realPayload = '{"policyId":"docker-managed"}';
        const dryRunPayload = '{"dryRun":true,"policyId":"docker-managed"}';
        async function enqueue(index: number, payloadJson: string) {
            const run = queuedRun(index, {
                actionKey: "maintenance.rotate-logs",
                attemptLimit: 1,
                displayName: "Managed log maintenance",
                payloadJson,
                requestedById: "system.logs-service",
                requestedByKind: "system",
                resourceClass: "host-heavy",
                resourceKeysJson: '["host.logs"]',
                retrySafe: false,
                scheduledJobId: null,
                scheduledJobVersion: null,
                triggerType: "system",
            });
            await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent: queuedEvent(run),
                run,
            });
            return run;
        }
        try {
            const firstReal = await enqueue(80, realPayload);
            await repository.cancelRun({
                actor: { id: "system.logs-service", kind: "system" },
                at: new Date(2000),
                id: firstReal.id,
                sideEffectsForRun: () => noSideEffects,
                terminalCode: "logs/maintenance-cancelled",
                terminalMessage: "Log maintenance was cancelled.",
            });
            const latestTerminalReal = await enqueue(81, realPayload);
            await repository.cancelRun({
                actor: { id: "system.logs-service", kind: "system" },
                at: new Date(3000),
                id: latestTerminalReal.id,
                sideEffectsForRun: () => noSideEffects,
                terminalCode: "logs/maintenance-cancelled",
                terminalMessage: "Log maintenance was cancelled.",
            });
            const dryRun = await enqueue(82, dryRunPayload);
            await repository.cancelRun({
                actor: { id: "system.logs-service", kind: "system" },
                at: new Date(3500),
                id: dryRun.id,
                sideEffectsForRun: () => noSideEffects,
                terminalCode: "logs/maintenance-cancelled",
                terminalMessage: "Log maintenance was cancelled.",
            });
            await repository.registerWorker({
                ...noSideEffects,
                worker: worker(workerOneId),
            });
            const activeReal = await enqueue(83, realPayload);
            expect(
                await repository.claimNextRun({
                    at: new Date(4000),
                    leaseExpiresAt: new Date(10_000),
                    leaseToken: uuid(830),
                    minimumHeartbeatAt: new Date(1000),
                    sideEffectsForClaim: () => noSideEffects,
                    workerId: workerOneId,
                })
            ).toMatchObject({ kind: "claimed", run: { id: activeReal.id } });
            const newerQueuedReal = await enqueue(84, realPayload);

            const snapshots = repository.readActionPayloadRunSnapshots({
                actionKey: "maintenance.rotate-logs",
                payloadJsons: [realPayload, dryRunPayload],
            });
            expect(snapshots).toMatchObject([
                {
                    activeRun: { id: activeReal.id, state: "running" },
                    lastRun: { id: latestTerminalReal.id, state: "cancelled" },
                    payloadJson: realPayload,
                },
                {
                    lastRun: { id: dryRun.id, state: "cancelled" },
                    payloadJson: dryRunPayload,
                },
            ]);
            const blockedRun = queuedRun(85, {
                actionKey: "maintenance.rotate-logs",
                attemptLimit: 1,
                displayName: "Managed log maintenance",
                payloadJson: realPayload,
                requestedById: "system.logs-service",
                requestedByKind: "system",
                resourceClass: "host-heavy",
                resourceKeysJson: '["host.logs"]',
                retrySafe: false,
                scheduledJobId: null,
                scheduledJobVersion: null,
                triggerType: "system",
            });
            expect(
                await repository.enqueueManualRun({
                    ...noSideEffects,
                    queuedEvent: queuedEvent(blockedRun),
                    rejectWhenActionActive: true,
                    run: blockedRun,
                })
            ).toMatchObject({ kind: "active" });
            expect(repository.findRun(blockedRun.id)).toBeUndefined();
            expect(repository.findRun(newerQueuedReal.id)).toMatchObject({
                state: "queued",
            });
            expect(
                repository.readActionPayloadRunSnapshots({
                    actionKey: "system.worker-smoke",
                    payloadJsons: [realPayload],
                })
            ).toEqual([{ payloadJson: realPayload }]);

            const invalidReads = [
                () =>
                    repository.readActionPayloadRunSnapshots({
                        actionKey: "maintenance.rotate-logs",
                        payloadJsons: [],
                    }),
                () =>
                    repository.readActionPayloadRunSnapshots({
                        actionKey: "maintenance.rotate-logs",
                        payloadJsons: [realPayload, realPayload],
                    }),
                () =>
                    repository.readActionPayloadRunSnapshots({
                        actionKey: "maintenance.rotate-logs",
                        payloadJsons: ["not-json"],
                    }),
                () =>
                    repository.readActionPayloadRunSnapshots({
                        actionKey: "maintenance.rotate-logs",
                        payloadJsons: Array.from({ length: 33 }, (_, index) =>
                            JSON.stringify({ index })
                        ),
                    }),
            ];
            for (const read of invalidReads) expect(read).toThrow();
            expect(() =>
                repository.readActionPayloadRunSnapshots({
                    actionKey: "maintenance.rotate-logs",
                    payloadJsons: [" ".repeat(65_537)],
                })
            ).toThrow("outside its budget");
            expect(() =>
                repository.readActionPayloadRunSnapshots({
                    actionKey: "maintenance.rotate-logs",
                    payloadJsons: [JSON.stringify({ value: "x".repeat(128) })],
                })
            ).toThrow("outside its status budget");
        } finally {
            database.sqlite.close(true);
        }
    });
});
