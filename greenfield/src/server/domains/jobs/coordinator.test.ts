import { describe, expect, spyOn, test } from "bun:test";

import { Effect } from "effect";

import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createJobWorkerActionResolver } from "./actionExecutors.ts";
import {
    type JobActionRegistration,
    type JobActionExecutionContext,
    JobActionRetryableError,
    jobActionDefinitions,
} from "./actionRegistry.ts";
import {
    createJobWorkerCoordinator,
    jobSchedulePollScanLimit,
    type JobWorkerCoordinatorOptions,
    type JobWorkerSideEffectFactory,
    type JobWorkerSideEffectInput,
} from "./coordinator.ts";
import type {
    JobDisableIntentRecord,
    JobRunRecord,
    ScheduledJobRecord,
    WorkerInstanceRecord,
} from "./records.ts";
import {
    createJobRepository,
    type DueScheduleEnqueueInput,
    type ExpireDisableIntentResult,
    type ExpireDisableIntentsInput,
    type JobAppendEventResult,
    type JobClaimResult,
    type JobMutationSideEffects,
    type JobRepository,
    type JobRunInsert,
    type JobSettlementResult,
    type ListDueSchedulesInput,
} from "./repository.ts";
import { createJobRealtimeSideEffects } from "./sideEffects.ts";

const findJobWorkerAction = createJobWorkerActionResolver({
    run: () => Promise.resolve(),
});

const releaseId = "a".repeat(40);
const at = new Date("2026-08-08T00:00:00.000Z");

const noSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});
const sideEffects: JobWorkerSideEffectFactory = Object.freeze({
    forQueue: () => noSideEffects,
    forRun: () => noSideEffects,
    forRunEvent: () => noSideEffects,
    forSchedule: () => noSideEffects,
    forScheduleEvent: () => noSideEffects,
});

function deferred<T>() {
    let resolveDeferred: ((value: T | PromiseLike<T>) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolveDeferred = resolve;
    });
    return {
        promise,
        resolve(value: T) {
            resolveDeferred?.(value);
        },
    };
}

function workerRecord(
    id: string,
    state: "draining" | "online" | "stopped",
    heartbeatAt = at
) {
    return {
        capacity: 1,
        drainingAt: state === "online" ? null : heartbeatAt,
        heartbeatAt,
        id,
        pid: 100,
        releaseId,
        startedAt: at,
        state,
        stoppedAt: state === "stopped" ? heartbeatAt : null,
    } satisfies WorkerInstanceRecord;
}

function claimedRun(workerId: string, actionKey = "system.worker-smoke"): JobRunRecord {
    return {
        actionKey,
        attemptCount: 1,
        attemptLimit: 3,
        availableAt: at,
        cancellationPolicy: "cooperative",
        cancelRequestedAt: null,
        cancelRequestedById: null,
        cancelRequestedByKind: null,
        displayName: "Worker smoke",
        enqueueSha256: "b".repeat(64),
        eventBytes: 0,
        eventCount: 2,
        finishedAt: null,
        firstStartedAt: at,
        heartbeatAt: at,
        id: Bun.randomUUIDv7(),
        idempotencyKey: "c".repeat(64),
        lastAttemptStartedAt: at,
        leaseExpiresAt: new Date(at.getTime() + 120_000),
        leaseOwnerId: workerId,
        leaseToken: Bun.randomUUIDv7(),
        payloadEventCount: 0,
        payloadJson: "{}",
        priority: 0,
        queuedAt: at,
        requestedById: "system.scheduler",
        requestedByKind: "system",
        resourceClass: "light",
        resourceKeysJson: '["database"]',
        resultJson: null,
        retrySafe: true,
        scheduledForAt: null,
        scheduledJobId: null,
        scheduledJobVersion: null,
        state: "running",
        stateVersion: 2,
        terminalCode: null,
        terminalMessage: null,
        timeoutMs: 30_000,
        triggerType: "system",
        updatedAt: at,
    };
}

function intervalSchedule(
    overrides: Partial<ScheduledJobRecord> = {}
): ScheduledJobRecord {
    return {
        actionKey: "system.worker-smoke",
        actionPayloadJson: "{}",
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAt: at,
        cronExpression: null,
        description: "Worker smoke",
        enabled: true,
        id: "system.worker-smoke",
        intervalMs: 60_000,
        name: "Worker smoke",
        nextRunAt: new Date(at.getTime() - 120_000),
        priority: 0,
        resourceClass: "light",
        resourceKeysJson: '["database"]',
        retrySafe: true,
        scheduleKind: "interval",
        timeOfDay: null,
        timeZone: null,
        timeoutMs: 30_000,
        updatedAt: at,
        version: 1,
        ...overrides,
    };
}

function queuedScheduledRun(
    schedule: ScheduledJobRecord,
    overrides: Partial<JobRunInsert> = {}
): JobRunInsert {
    if (schedule.nextRunAt === null) {
        throw new Error("Expected a durable schedule cursor");
    }
    return {
        actionKey: schedule.actionKey,
        attemptLimit: schedule.attemptLimit,
        availableAt: new Date(at.getTime() + 86_400_000),
        cancellationPolicy: schedule.cancellationPolicy,
        cancelRequestedAt: null,
        cancelRequestedById: null,
        cancelRequestedByKind: null,
        displayName: schedule.name,
        enqueueSha256: "d".repeat(64),
        finishedAt: null,
        firstStartedAt: null,
        heartbeatAt: null,
        id: Bun.randomUUIDv7(),
        idempotencyKey: "e".repeat(32),
        lastAttemptStartedAt: null,
        leaseExpiresAt: null,
        leaseOwnerId: null,
        leaseToken: null,
        payloadJson: schedule.actionPayloadJson,
        priority: schedule.priority,
        queuedAt: at,
        requestedById: "jobs-scheduler",
        requestedByKind: "system",
        resourceClass: schedule.resourceClass,
        resourceKeysJson: schedule.resourceKeysJson,
        resultJson: null,
        retrySafe: schedule.retrySafe,
        scheduledForAt: schedule.nextRunAt,
        scheduledJobId: schedule.id,
        scheduledJobVersion: schedule.version,
        state: "queued",
        terminalCode: null,
        terminalMessage: null,
        timeoutMs: schedule.timeoutMs,
        triggerType: "schedule",
        updatedAt: at,
        ...overrides,
    };
}

function expiredDisableIntent(scheduleId: string): JobDisableIntentRecord {
    return {
        createdAt: new Date(at.getTime() - 120_000),
        createdById: "019fdf20-0000-7000-8000-000000000001",
        createdByKind: "user",
        endedAt: at,
        endedById: "system.jobs-worker",
        endedByKind: "system",
        endedReason: "expired",
        expiresAt: new Date(at.getTime() - 60_000),
        externalJobId: null,
        externalProvider: null,
        id: "019fdf20-0000-7000-8000-000000000002",
        reason: "Temporary operator pause",
        scheduledJobId: scheduleId,
        targetKind: "dashboard-schedule",
    };
}

interface RepositoryFixtureOptions {
    readonly appendEvent?: (
        input: Parameters<JobRepository["appendClaimEvent"]>[0]
    ) => JobAppendEventResult;
    readonly cancellationRequested?: boolean;
    readonly claim?: JobClaimResult;
    readonly claimGate?: Promise<void>;
    readonly claims?: readonly JobClaimResult[];
    readonly dueSchedules?: readonly ScheduledJobRecord[];
    readonly drainWorkerAt?: Date;
    readonly expiringSchedule?: ScheduledJobRecord;
    readonly expiryGate?: Promise<void>;
    readonly expiryFailure?: Error;
    readonly expiryResults?: readonly ExpireDisableIntentResult[];
    readonly heartbeatFailure?: Error;
    readonly reconciliationFailure?: Error;
    readonly recoveredRuns?: readonly JobRunRecord[];
    readonly registrationFailure?: Error;
    readonly settlementAt?: Date;
    readonly settlementRun?: JobRunRecord;
    readonly stopWorkerAt?: Date;
}

function repositoryFixture(options: RepositoryFixtureOptions = {}) {
    const events: string[] = [];
    const claimSideEffects: JobMutationSideEffects[] = [];
    const claimInputs: Array<Parameters<JobRepository["claimNextRun"]>[0]> = [];
    const enqueues: DueScheduleEnqueueInput[] = [];
    const eventSideEffects: JobMutationSideEffects[] = [];
    const expiryEligibility: boolean[] = [];
    const expiryNextRuns: Date[] = [];
    const recoverySideEffects: JobMutationSideEffects[] = [];
    const reconciliationInputs: Array<
        Parameters<JobRepository["reconcileSchedules"]>[0]
    > = [];
    const lifecycleSideEffects: Array<{
        readonly operation: "drain" | "stop";
        readonly sideEffects: JobMutationSideEffects;
    }> = [];
    const settlements: Array<Parameters<JobRepository["settleClaim"]>[0]> = [];
    const settlementSideEffects: JobMutationSideEffects[] = [];
    const claims = [
        ...(options.claims ?? (options.claim === undefined ? [] : [options.claim])),
    ];
    let recoveredRuns = [...(options.recoveredRuns ?? [])];
    const eventRun = claims.find((result) => result.kind === "claimed")?.run;
    let dueSchedules = [...(options.dueSchedules ?? [])];
    const repository = {
        appendClaimEvent(input) {
            events.push(`append:${input.kind}`);
            const result = options.appendEvent?.(input) ?? { kind: "dropped" };
            if (
                eventRun !== undefined &&
                (result.kind === "appended" || result.kind === "truncated")
            ) {
                eventSideEffects.push(
                    input.sideEffectsForRun({
                        ...eventRun,
                        updatedAt: result.event?.occurredAt ?? eventRun.updatedAt,
                    })
                );
            }
            return Promise.resolve(result);
        },
        beginWorkerDrain(input) {
            events.push("drain");
            const worker = workerRecord(
                input.workerId,
                "draining",
                options.drainWorkerAt
            );
            lifecycleSideEffects.push({
                operation: "drain",
                sideEffects: input.sideEffectsForWorker(worker),
            });
            return Promise.resolve({
                kind: "updated" as const,
                worker,
            });
        },
        async claimNextRun(input) {
            claimInputs.push(input);
            const result = claims.shift() ?? ({ kind: "empty" } as const);
            events.push(`claim:${result.kind}`);
            if (result.kind === "claimed") {
                claimSideEffects.push(input.sideEffectsForClaim(result.run));
            }
            if (options.claimGate !== undefined) await options.claimGate;
            return result;
        },
        enqueueNextDueSchedule(input) {
            enqueues.push(input);
            events.push("enqueue-due");
            return Promise.resolve({ kind: "not-due" as const });
        },
        async expireDisableIntents(input: ExpireDisableIntentsInput) {
            events.push("expire-disable-intents");
            await options.expiryGate;
            if (options.expiryFailure !== undefined) {
                throw options.expiryFailure;
            }
            if (options.expiringSchedule !== undefined) {
                const canReenable = input.canReenableSchedule(options.expiringSchedule);
                expiryEligibility.push(canReenable);
                if (canReenable) {
                    const next = input.nextRunAt(options.expiringSchedule, input.at);
                    if (next !== undefined) expiryNextRuns.push(next);
                }
            }
            return options.expiryResults ?? [];
        },
        heartbeatWorker(input) {
            events.push("heartbeat");
            if (options.heartbeatFailure) {
                return Promise.reject(options.heartbeatFailure);
            }
            return Promise.resolve(workerRecord(input.workerId, "online"));
        },
        listDueSchedules() {
            events.push("list-due");
            const schedules = dueSchedules;
            dueSchedules = [];
            return schedules;
        },
        readClaimCancellation() {
            events.push("read-cancellation");
            return {
                cancelRequested: options.cancellationRequested ?? false,
                valid: true,
            };
        },
        reconcileSchedules(input) {
            events.push(`reconcile:${input.schedules.length}`);
            reconciliationInputs.push(input);
            return options.reconciliationFailure === undefined
                ? Promise.resolve([])
                : Promise.reject(options.reconciliationFailure);
        },
        recoverExpiredClaims(input) {
            const recovered = recoveredRuns;
            recoveredRuns = [];
            recoverySideEffects.push(
                ...recovered.map((run) => input.sideEffectsForRun(run))
            );
            return Promise.resolve(recovered);
        },
        registerWorker(input) {
            events.push("register");
            return options.registrationFailure === undefined
                ? Promise.resolve(workerRecord(input.worker.id, "online"))
                : Promise.reject(options.registrationFailure);
        },
        renewClaim(input) {
            events.push("renew");
            return Promise.resolve({
                kind: "renewed" as const,
                run: claimedRun(input.workerId),
            });
        },
        settleClaim(input) {
            settlements.push(input);
            events.push(`settle:${input.outcome.kind}`);
            const settled = {
                ...(options.settlementRun ?? claimedRun(input.workerId)),
                updatedAt: options.settlementAt ?? at,
            };
            settlementSideEffects.push(input.sideEffectsForRun(settled));
            return Promise.resolve({
                kind: "settled" as const,
                run: settled,
            } satisfies JobSettlementResult);
        },
        stopWorker(input) {
            events.push("stop");
            const worker = workerRecord(input.workerId, "stopped", options.stopWorkerAt);
            lifecycleSideEffects.push({
                operation: "stop",
                sideEffects: input.sideEffectsForWorker(worker),
            });
            return Promise.resolve({
                kind: "updated" as const,
                worker,
            });
        },
    } satisfies JobWorkerCoordinatorOptions["repository"];
    return {
        claimInputs,
        claimSideEffects,
        enqueues,
        eventSideEffects,
        events,
        expiryEligibility,
        expiryNextRuns,
        lifecycleSideEffects,
        reconciliationInputs,
        recoverySideEffects,
        repository,
        settlements,
        settlementSideEffects,
    };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Test condition timed out");
        await Bun.sleep(1);
    }
}

function coordinatorOptions(
    repository: JobWorkerCoordinatorOptions["repository"],
    workerInstanceId: string
): JobWorkerCoordinatorOptions {
    const smokeDefinition = jobActionDefinitions.find(
        (definition) => definition.actionKey === "system.worker-smoke"
    );
    if (smokeDefinition === undefined) throw new Error("Missing smoke definition");
    return {
        databaseReleaseId: releaseId,
        actionDefinitions: [smokeDefinition],
        findAction: findJobWorkerAction,
        generateId: () => Bun.randomUUIDv7(),
        nowMs: () => at.getTime(),
        pid: 100,
        repository,
        sideEffects,
        timings: {
            cancellationPollMs: 2,
            claimLeaseMs: 100,
            claimRenewalMs: 20,
            heartbeatMs: 20,
            idlePollMs: 2,
            schedulePollMs: 20,
            workerFreshnessMs: 50,
        },
        workerInstanceId,
    };
}

describe("durable job worker coordinator", () => {
    test("reconciles, registers, executes the safe smoke action, and drains in order", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId);
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.settlements[0]?.outcome).toMatchObject({
            kind: "succeeded",
        });
        expect(fixture.events.indexOf("register")).toBeGreaterThan(
            fixture.events.indexOf("reconcile:1")
        );
        expect(fixture.events.indexOf("drain")).toBeLessThan(
            fixture.events.indexOf("stop")
        );
        expect(await coordinator.completion).toBeUndefined();
    });

    test("derives drain and stop queue effects inside durable worker callbacks", async () => {
        const workerId = Bun.randomUUIDv7();
        const drainWorkerAt = new Date(at.getTime() + 20_000);
        const stopWorkerAt = new Date(at.getTime() + 30_000);
        const fixture = repositoryFixture({ drainWorkerAt, stopWorkerAt });
        const queueTransitions: JobWorkerSideEffectInput[] = [];
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            sideEffects: {
                ...sideEffects,
                forQueue: (input) => {
                    queueTransitions.push(input);
                    return createJobRealtimeSideEffects({
                        occurredAt: input.at,
                        realtime: { id: input.targetId, kind: "queue" },
                    });
                },
            },
        });

        await coordinator.initialize();
        await coordinator.dispose();

        expect(queueTransitions).toEqual([
            {
                action: "jobs.worker.register",
                at,
                outcome: "accepted",
                targetId: workerId,
            },
            {
                action: "jobs.worker.drain",
                at: drainWorkerAt,
                outcome: "accepted",
                targetId: workerId,
            },
            {
                action: "jobs.worker.stop",
                at: stopWorkerAt,
                outcome: "succeeded",
                targetId: workerId,
            },
        ]);
        expect(
            fixture.lifecycleSideEffects.map(({ operation, sideEffects }) => ({
                operation,
                realtime: sideEffects.realtimeEvents.map(
                    ({ entityId, occurredAt, topic }) => ({
                        entityId,
                        occurredAt,
                        topic,
                    })
                ),
            }))
        ).toEqual([
            {
                operation: "drain",
                realtime: [
                    {
                        entityId: workerId,
                        occurredAt: drainWorkerAt,
                        topic: "jobs.runs",
                    },
                ],
            },
            {
                operation: "stop",
                realtime: [
                    {
                        entityId: workerId,
                        occurredAt: stopWorkerAt,
                        topic: "jobs.runs",
                    },
                ],
            },
        ]);
    });

    test("supplies durable cancelled-run effects for retired schedules", async () => {
        const workerId = Bun.randomUUIDv7();
        const scheduleId = "system.worker-smoke";
        const cancelledAt = new Date(at.getTime() + 20_000);
        const cancelledRun: JobRunRecord = {
            ...claimedRun(workerId),
            cancelRequestedAt: cancelledAt,
            cancelRequestedById: "system.jobs-worker",
            cancelRequestedByKind: "system",
            finishedAt: cancelledAt,
            heartbeatAt: null,
            leaseExpiresAt: null,
            leaseOwnerId: null,
            leaseToken: null,
            scheduledForAt: at,
            scheduledJobId: scheduleId,
            scheduledJobVersion: 1,
            state: "cancelled",
            stateVersion: 3,
            terminalCode: "cancelled/schedule-retired",
            terminalMessage:
                "Cancelled because the schedule was retired from the action registry",
            triggerType: "schedule",
            updatedAt: cancelledAt,
        };
        const fixture = repositoryFixture();
        const runTransitions: JobWorkerSideEffectInput[] = [];
        const scheduleTransitions: JobWorkerSideEffectInput[] = [];
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            sideEffects: {
                ...sideEffects,
                forRun: (input) => {
                    runTransitions.push(input);
                    return createJobRealtimeSideEffects({
                        occurredAt: input.at,
                        realtime: {
                            id: input.targetId,
                            kind: "run",
                            operation: "updated",
                        },
                    });
                },
                forScheduleEvent: (input) => {
                    scheduleTransitions.push(input);
                    return createJobRealtimeSideEffects({
                        occurredAt: input.at,
                        realtime: {
                            id: input.targetId,
                            kind: "schedule",
                            operation: "updated",
                        },
                    });
                },
            },
        });

        await coordinator.initialize();
        const reconciliation = fixture.reconciliationInputs.at(0);
        const retiredRunCancellation = reconciliation?.retiredRunCancellation;
        if (retiredRunCancellation === undefined) {
            throw new Error("Missing retired-run cancellation metadata");
        }
        const cancellationSideEffects =
            retiredRunCancellation.sideEffectsForRun(cancelledRun);
        await coordinator.dispose();

        expect(retiredRunCancellation).toMatchObject({
            actor: { id: "system.jobs-worker", kind: "system" },
            terminalCode: "cancelled/schedule-retired",
            terminalMessage:
                "Cancelled because the schedule was retired from the action registry",
        });
        expect(runTransitions).toEqual([
            {
                action: "jobs.run.cancelled",
                at: cancelledAt,
                outcome: "cancelled",
                targetId: cancelledRun.id,
            },
        ]);
        expect(scheduleTransitions).toEqual([
            {
                action: "jobs.run.cancelled",
                at: cancelledAt,
                outcome: "cancelled",
                targetId: scheduleId,
            },
        ]);
        expect(
            cancellationSideEffects.realtimeEvents.map(({ entityId, topic }) => ({
                entityId,
                topic,
            }))
        ).toEqual([
            { entityId: cancelledRun.id, topic: "jobs.runs" },
            { entityId: scheduleId, topic: "schedules.records" },
        ]);
    });

    test("starts after retiring a queued never-cancellable schedule run", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const workerId = Bun.randomUUIDv7();
        const scheduleId = "system.worker-smoke-never-retired";
        const scheduleTransitions: JobWorkerSideEffectInput[] = [];
        const runTransitions: JobWorkerSideEffectInput[] = [];

        try {
            const [registered] = await repository.reconcileSchedules({
                at,
                schedules: [
                    intervalSchedule({
                        actionKey: "retired.action",
                        cancellationPolicy: "never",
                        createdAt: new Date(at.getTime() - 1000),
                        id: scheduleId,
                        nextRunAt: at,
                        updatedAt: new Date(at.getTime() - 1000),
                    }),
                ],
                sideEffectsForSchedule: () => noSideEffects,
            });
            if (registered === undefined) {
                throw new Error("Missing never-cancellable schedule fixture");
            }
            const run = queuedScheduledRun(registered, { availableAt: at });
            expect(
                await repository.enqueueNextDueSchedule({
                    ...noSideEffects,
                    at,
                    nextRunAt: new Date(at.getTime() + 60_000),
                    observedNextRunAt: at,
                    run,
                    scheduleId,
                })
            ).toMatchObject({ kind: "inserted" });

            const coordinator = createJobWorkerCoordinator({
                ...coordinatorOptions(repository, workerId),
                sideEffects: {
                    ...sideEffects,
                    forRun: (input) => {
                        runTransitions.push(input);
                        if (input.action === "jobs.run.cancelled") {
                            throw new Error(
                                "worker reconciliation cancelled never-cancellable work"
                            );
                        }
                        return noSideEffects;
                    },
                    forSchedule: (input) => {
                        scheduleTransitions.push(input);
                        return noSideEffects;
                    },
                    forScheduleEvent: (input) => {
                        scheduleTransitions.push(input);
                        return noSideEffects;
                    },
                },
            });

            await coordinator.initialize();
            await waitUntil(() => repository.findRun(run.id)?.state === "failed");
            expect(repository.findSchedule(scheduleId)?.schedule).toMatchObject({
                enabled: false,
                updatedAt: at,
                version: 2,
            });
            expect(repository.findRun(run.id)).toMatchObject({
                cancelRequestedAt: null,
                eventCount: 3,
                state: "failed",
                terminalCode: "action-unavailable",
            });
            expect(runTransitions).toEqual([
                {
                    action: "jobs.run.action-unavailable",
                    at,
                    outcome: "failed",
                    targetId: run.id,
                },
            ]);
            expect(scheduleTransitions).toContainEqual({
                action: "schedules.reconcile",
                at,
                outcome: "accepted",
                targetId: scheduleId,
            });
            expect(scheduleTransitions).toContainEqual({
                action: "jobs.run.action-unavailable",
                at,
                outcome: "failed",
                targetId: scheduleId,
            });
            expect(scheduleTransitions).not.toContainEqual(
                expect.objectContaining({ action: "jobs.run.cancelled" })
            );

            await coordinator.dispose();
            expect(await coordinator.completion).toBeUndefined();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("continues bounded claim pages and resets the cursor after a claim", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId);
        const cursor = {
            availableAt: new Date(at.getTime() - 1000),
            availableThrough: at,
            id: Bun.randomUUIDv7(),
            priority: 0,
            queuedAt: new Date(at.getTime() - 1000),
        } as const;
        const fixture = repositoryFixture({
            claims: [
                { cursor, kind: "page-exhausted" },
                { kind: "claimed", run },
            ],
        });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        await waitUntil(() => fixture.claimInputs.length >= 3);
        await coordinator.dispose();

        expect(fixture.claimInputs[0]).not.toHaveProperty("cursor");
        expect(fixture.claimInputs[1]).toMatchObject({ cursor });
        expect(fixture.claimInputs[2]).not.toHaveProperty("cursor");
        expect(fixture.settlements).toHaveLength(1);
    });

    test("rejects completion when initialization fails before worker loops start", async () => {
        for (const operation of ["reconcile", "register"] as const) {
            const failure = new Error(`${operation} failed`);
            const workerId = Bun.randomUUIDv7();
            const fixture = repositoryFixture(
                operation === "reconcile"
                    ? { reconciliationFailure: failure }
                    : { registrationFailure: failure }
            );
            const coordinator = createJobWorkerCoordinator(
                coordinatorOptions(fixture.repository, workerId)
            );
            const completion = coordinator.completion.catch((error: unknown) => error);
            const initialization = coordinator.initialize();

            expect(coordinator.initialize()).toBe(initialization);
            expect(await initialization.catch((error: unknown) => error)).toBe(failure);
            expect(await completion).toBe(failure);
            expect(await coordinator.dispose().catch((error: unknown) => error)).toBe(
                failure
            );
        }
    });

    test("stops the claim monitor immediately after a fast action finishes", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId);
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const options = coordinatorOptions(fixture.repository, workerId);
        const coordinator = createJobWorkerCoordinator({
            ...options,
            timings: {
                ...options.timings,
                cancellationPollMs: 60_000,
            },
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.settlements).toHaveLength(1);
        expect(fixture.settlements[0]?.outcome.kind).toBe("succeeded");
        expect(fixture.events).not.toContain("read-cancellation");
        expect(fixture.events).not.toContain("renew");
    });

    test("anchors claim renewal to the durable clamped heartbeat", async () => {
        const workerId = Bun.randomUUIDv7();
        const durableHeartbeat = new Date(at.getTime() + 20_000);
        const run: JobRunRecord = {
            ...claimedRun(workerId, "test.clock-regression"),
            heartbeatAt: durableHeartbeat,
            leaseExpiresAt: new Date(at.getTime() + 30_000),
            updatedAt: durableHeartbeat,
        };
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        let logicalNowMs = at.getTime();
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () =>
                Effect.tryPromise(async () => {
                    await Bun.sleep(5);
                    logicalNowMs = at.getTime() + 25;
                    await Bun.sleep(20);
                    return {};
                }),
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
            nowMs: () => logicalNowMs,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.events).not.toContain("renew");
        expect(fixture.settlements[0]?.outcome.kind).toBe("succeeded");
    });

    test("invalidates a claimed schedule projection at the durable claim time", async () => {
        const workerId = Bun.randomUUIDv7();
        const scheduleId = "system.worker-smoke";
        const durableAt = new Date(at.getTime() + 20_000);
        const run: JobRunRecord = {
            ...claimedRun(workerId),
            firstStartedAt: durableAt,
            heartbeatAt: durableAt,
            lastAttemptStartedAt: durableAt,
            leaseExpiresAt: new Date(durableAt.getTime() + 30_000),
            scheduledForAt: at,
            scheduledJobId: scheduleId,
            scheduledJobVersion: 1,
            triggerType: "schedule",
            updatedAt: durableAt,
        };
        const fixture = repositoryFixture({
            claim: { kind: "claimed", run },
            settlementAt: durableAt,
        });
        const observed: Array<{
            readonly action: string;
            readonly at: Date;
            readonly target: "queue" | "run" | "run-event" | "schedule-event";
        }> = [];
        const recordingSideEffects: JobWorkerSideEffectFactory = {
            forQueue: (input) => {
                observed.push({ action: input.action, at: input.at, target: "queue" });
                return input.action === "jobs.run.claim"
                    ? createJobRealtimeSideEffects({
                          occurredAt: input.at,
                          realtime: { id: "jobs.queue", kind: "queue" },
                      })
                    : noSideEffects;
            },
            forRun: (input) => {
                observed.push({ action: input.action, at: input.at, target: "run" });
                return noSideEffects;
            },
            forRunEvent: (input) => {
                observed.push({
                    action: input.action,
                    at: input.at,
                    target: "run-event",
                });
                return createJobRealtimeSideEffects({
                    occurredAt: input.at,
                    realtime: {
                        id: input.targetId,
                        kind: "run",
                        operation: "updated",
                    },
                });
            },
            forSchedule: () => noSideEffects,
            forScheduleEvent: (input) => {
                observed.push({
                    action: input.action,
                    at: input.at,
                    target: "schedule-event",
                });
                return createJobRealtimeSideEffects({
                    occurredAt: input.at,
                    realtime: {
                        id: input.targetId,
                        kind: "schedule",
                        operation: "updated",
                    },
                });
            },
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            sideEffects: recordingSideEffects,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(
            observed.filter(({ action }) =>
                ["jobs.run.claim", "jobs.run.succeeded"].includes(action)
            )
        ).toEqual([
            { action: "jobs.run.claim", at: durableAt, target: "queue" },
            { action: "jobs.run.claim", at: durableAt, target: "run-event" },
            {
                action: "jobs.run.claim",
                at: durableAt,
                target: "schedule-event",
            },
            { action: "jobs.run.succeeded", at: durableAt, target: "run" },
        ]);
        expect(fixture.claimSideEffects).toEqual([
            {
                auditEvents: [],
                realtimeEvents: [
                    expect.objectContaining({
                        entityId: "jobs.queue",
                        entityType: "job-queue",
                        operation: "snapshot-required",
                        topic: "jobs.runs",
                    }),
                    expect.objectContaining({
                        entityId: run.id,
                        entityType: "job-run",
                        operation: "updated",
                        topic: "jobs.runs",
                    }),
                    expect.objectContaining({
                        entityId: scheduleId,
                        entityType: "schedule",
                        operation: "updated",
                        topic: "schedules.records",
                    }),
                ],
            },
        ]);
    });

    test("fails the claim transaction callback when schedule invalidation fails", async () => {
        const failure = new Error("schedule invalidation failed");
        const workerId = Bun.randomUUIDv7();
        const run: JobRunRecord = {
            ...claimedRun(workerId),
            scheduledForAt: at,
            scheduledJobId: "system.worker-smoke",
            scheduledJobVersion: 1,
            triggerType: "schedule",
        };
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            sideEffects: {
                ...sideEffects,
                forScheduleEvent: () => {
                    throw failure;
                },
            },
        });
        const completion = coordinator.completion.catch((error: unknown) => error);

        await coordinator.initialize();

        expect(await completion).toBe(failure);
        await coordinator.dispose();
        expect(fixture.claimSideEffects).toEqual([]);
        expect(fixture.settlements).toEqual([]);
    });

    test("invalidates the schedule projection in the settlement transaction", async () => {
        const workerId = Bun.randomUUIDv7();
        const scheduleId = "system.worker-smoke";
        const run: JobRunRecord = {
            ...claimedRun(workerId),
            scheduledForAt: at,
            scheduledJobId: scheduleId,
            scheduledJobVersion: 1,
            triggerType: "schedule",
        };
        const settlementRun: JobRunRecord = {
            ...run,
            finishedAt: at,
            heartbeatAt: null,
            leaseExpiresAt: null,
            leaseOwnerId: null,
            leaseToken: null,
            resultJson: "{}",
            state: "succeeded",
            stateVersion: run.stateVersion + 1,
        };
        const fixture = repositoryFixture({
            claim: { kind: "claimed", run },
            settlementRun,
        });
        const recordingSideEffects: JobWorkerSideEffectFactory = {
            ...sideEffects,
            forRun: (input) =>
                createJobRealtimeSideEffects({
                    occurredAt: input.at,
                    realtime: {
                        id: input.targetId,
                        kind: "run",
                        operation: "updated",
                    },
                }),
            forScheduleEvent: (input) =>
                createJobRealtimeSideEffects({
                    occurredAt: input.at,
                    realtime: {
                        id: input.targetId,
                        kind: "schedule",
                        operation: "updated",
                    },
                }),
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            sideEffects: recordingSideEffects,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.settlementSideEffects).toEqual([
            {
                auditEvents: [],
                realtimeEvents: [
                    expect.objectContaining({
                        entityId: run.id,
                        topic: "jobs.runs",
                    }),
                    expect.objectContaining({
                        entityId: scheduleId,
                        topic: "schedules.records",
                    }),
                ],
            },
        ]);
    });

    test("invalidates scheduled retry and cancellation recoveries atomically", async () => {
        const workerId = Bun.randomUUIDv7();
        const scheduleId = "system.worker-smoke";
        const retryRun: JobRunRecord = {
            ...claimedRun(workerId),
            availableAt: new Date(at.getTime() + 1000),
            heartbeatAt: null,
            leaseExpiresAt: null,
            leaseOwnerId: null,
            leaseToken: null,
            scheduledForAt: at,
            scheduledJobId: scheduleId,
            scheduledJobVersion: 1,
            state: "queued",
            stateVersion: 3,
            triggerType: "schedule",
        };
        const cancelledAt = new Date(at.getTime() + 2000);
        const cancelledRun: JobRunRecord = {
            ...retryRun,
            availableAt: at,
            cancelRequestedAt: cancelledAt,
            cancelRequestedById: Bun.randomUUIDv7(),
            cancelRequestedByKind: "user",
            finishedAt: cancelledAt,
            id: Bun.randomUUIDv7(),
            state: "cancelled",
            stateVersion: 4,
            terminalCode: "job/cancel-requested",
            terminalMessage: "The run was cancelled after its worker lease expired.",
            updatedAt: cancelledAt,
        };
        const fixture = repositoryFixture({ recoveredRuns: [retryRun, cancelledRun] });
        const runTransitions: JobWorkerSideEffectInput[] = [];
        const scheduleTransitions: JobWorkerSideEffectInput[] = [];
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            sideEffects: {
                ...sideEffects,
                forRun: (input) => {
                    runTransitions.push(input);
                    return createJobRealtimeSideEffects({
                        occurredAt: input.at,
                        realtime: {
                            id: input.targetId,
                            kind: "run",
                            operation: "updated",
                        },
                    });
                },
                forScheduleEvent: (input) => {
                    scheduleTransitions.push(input);
                    return createJobRealtimeSideEffects({
                        occurredAt: input.at,
                        realtime: {
                            id: input.targetId,
                            kind: "schedule",
                            operation: "updated",
                        },
                    });
                },
            },
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.recoverySideEffects.length === 2);
        await coordinator.dispose();

        expect(runTransitions).toEqual([
            {
                action: "jobs.run.lease-expired",
                at: retryRun.updatedAt,
                outcome: "failed",
                targetId: retryRun.id,
            },
            {
                action: "jobs.run.cancelled",
                at: cancelledAt,
                outcome: "cancelled",
                targetId: cancelledRun.id,
            },
        ]);
        expect(scheduleTransitions).toEqual([
            {
                action: "jobs.run.lease-expired",
                at: retryRun.updatedAt,
                outcome: "failed",
                targetId: scheduleId,
            },
            {
                action: "jobs.run.cancelled",
                at: cancelledAt,
                outcome: "cancelled",
                targetId: scheduleId,
            },
        ]);
        expect(
            fixture.recoverySideEffects.map(({ realtimeEvents }) =>
                realtimeEvents.map(({ entityId, topic }) => ({ entityId, topic }))
            )
        ).toEqual([
            [
                { entityId: retryRun.id, topic: "jobs.runs" },
                { entityId: scheduleId, topic: "schedules.records" },
            ],
            [
                { entityId: cancelledRun.id, topic: "jobs.runs" },
                { entityId: scheduleId, topic: "schedules.records" },
            ],
        ]);
    });

    test("classifies a repository-normalized shutdown cancellation", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.shutdown-cancellation-race");
        const cancelledAt = new Date(at.getTime() + 1000);
        const settlementRun: JobRunRecord = {
            ...run,
            cancelRequestedAt: cancelledAt,
            cancelRequestedById: Bun.randomUUIDv7(),
            cancelRequestedByKind: "user",
            finishedAt: cancelledAt,
            heartbeatAt: null,
            leaseExpiresAt: null,
            leaseOwnerId: null,
            leaseToken: null,
            state: "cancelled",
            stateVersion: run.stateVersion + 2,
            terminalCode: "cancel-requested",
            terminalMessage: "The job action was cancelled.",
            updatedAt: cancelledAt,
        };
        const fixture = repositoryFixture({
            claim: { kind: "claimed", run },
            settlementAt: cancelledAt,
            settlementRun,
        });
        const observed: JobWorkerSideEffectInput[] = [];
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === run.actionKey
                    ? {
                          ...baseRegistration,
                          actionKey: run.actionKey,
                          execute: () => Effect.never,
                      }
                    : undefined,
            sideEffects: {
                ...sideEffects,
                forRun: (input) => {
                    observed.push(input);
                    return noSideEffects;
                },
            },
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.events.includes("read-cancellation"));
        await coordinator.dispose();

        expect(fixture.settlements[0]?.outcome).toMatchObject({
            kind: "failed",
            terminalCode: "worker-shutdown",
        });
        expect(observed).toEqual([
            {
                action: "jobs.run.cancelled",
                at: cancelledAt,
                outcome: "cancelled",
                targetId: run.id,
            },
        ]);
    });

    test("fails an unknown action closed without retrying it", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "unknown.action");
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.settlements[0]?.outcome).toEqual({
            kind: "failed",
            terminalCode: "action-unavailable",
            terminalMessage: "This release does not implement the queued action.",
        });
    });

    test("coalesces one due interval run and advances its cadence", async () => {
        const workerId = Bun.randomUUIDv7();
        const schedule = intervalSchedule();
        const fixture = repositoryFixture({ dueSchedules: [schedule] });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        await waitUntil(() => fixture.enqueues.length === 1);
        await coordinator.dispose();

        const enqueue = fixture.enqueues[0];
        expect(enqueue?.observedNextRunAt).toEqual(schedule.nextRunAt);
        expect(enqueue?.nextRunAt).toEqual(new Date(at.getTime() + 60_000));
        expect(enqueue?.run).toMatchObject({
            requestedById: "system.scheduler",
            requestedByKind: "system",
            scheduledForAt: schedule.nextRunAt,
            scheduledJobId: schedule.id,
            scheduledJobVersion: schedule.version,
            triggerType: "schedule",
        });
    });

    test("pages past active schedules across bounded polling passes", async () => {
        const workerId = Bun.randomUUIDv7();
        const dueAt = new Date(at.getTime() - 30_000);
        const schedules = Array.from(
            { length: jobSchedulePollScanLimit + 2 },
            (_, index) =>
                intervalSchedule({
                    id: `system.worker-smoke-${String(index).padStart(3, "0")}`,
                    nextRunAt: dueAt,
                })
        );
        const runnableSchedule = schedules.at(-1);
        if (runnableSchedule === undefined) throw new Error("Missing runnable schedule");
        const newlyDueSchedule = intervalSchedule({
            id: "system.worker-smoke-newly-due",
            nextRunAt: new Date(at.getTime() + 30_000),
        });
        const allSchedules = [...schedules, newlyDueSchedule];
        const fixture = repositoryFixture();
        const listInputs: ListDueSchedulesInput[] = [];
        const listedScheduleIds: string[][] = [];
        const enqueueAttempts: DueScheduleEnqueueInput[] = [];
        let clockMs = at.getTime();
        const activeRun = claimedRun(workerId);
        const repository = {
            ...fixture.repository,
            enqueueNextDueSchedule(input: DueScheduleEnqueueInput) {
                enqueueAttempts.push(input);
                return Promise.resolve(
                    input.scheduleId === runnableSchedule.id
                        ? { kind: "inserted" as const, run: activeRun }
                        : { kind: "active" as const, run: activeRun }
                );
            },
            listDueSchedules(input: ListDueSchedulesInput) {
                listInputs.push(input);
                const afterCursor = allSchedules.filter((schedule) => {
                    if (schedule.nextRunAt === null) return false;
                    if (schedule.nextRunAt.getTime() > input.at.getTime()) return false;
                    if (input.cursor === undefined) return true;
                    const timeDifference =
                        schedule.nextRunAt.getTime() - input.cursor.nextRunAt.getTime();
                    return (
                        timeDifference > 0 ||
                        (timeDifference === 0 && schedule.id > input.cursor.id)
                    );
                });
                const page = afterCursor.slice(0, input.limit);
                listedScheduleIds.push(page.map(({ id }) => id));
                if (listInputs.length === 8) clockMs = at.getTime() - 60_000;
                return page;
            },
        } satisfies JobWorkerCoordinatorOptions["repository"];
        const baseOptions = coordinatorOptions(repository, workerId);
        const coordinator = createJobWorkerCoordinator({
            ...baseOptions,
            nowMs: () => clockMs,
            timings: { ...baseOptions.timings, schedulePollMs: 1 },
        });

        await coordinator.initialize();
        await waitUntil(() =>
            enqueueAttempts.some(({ scheduleId }) => scheduleId === runnableSchedule.id)
        );
        await coordinator.dispose();

        expect(listInputs.length).toBeGreaterThanOrEqual(9);
        expect(listInputs[0]?.cursor).toBeUndefined();
        expect(listInputs[1]?.cursor).toEqual({
            id: schedules[31]?.id,
            nextRunAt: dueAt,
        });
        expect(listInputs[8]?.cursor).toEqual({
            id: schedules[jobSchedulePollScanLimit - 1]?.id,
            nextRunAt: dueAt,
        });
        expect(listInputs[8]?.at).toEqual(at);
        expect(listedScheduleIds[8]).not.toContain(newlyDueSchedule.id);
        const firstTraversal = enqueueAttempts.slice(0, schedules.length);
        expect(firstTraversal.map(({ scheduleId }) => scheduleId)).toEqual(
            schedules.map(({ id }) => id)
        );
        expect(new Set(firstTraversal.map(({ scheduleId }) => scheduleId)).size).toBe(
            schedules.length
        );
        expect(
            fixture.events.filter((event) => event === "expire-disable-intents").length
        ).toBeGreaterThanOrEqual(2);
        expect(firstTraversal.at(-1)?.observedNextRunAt).toEqual(dueAt);
        expect(firstTraversal.at(-1)).toMatchObject({
            at,
            run: { queuedAt: at },
        });
    });

    test("atomically invalidates a manual run's schedule for durable action events", async () => {
        const workerId = Bun.randomUUIDv7();
        const scheduleId = "system.worker-smoke";
        const run: JobRunRecord = {
            ...claimedRun(workerId, "test.progress"),
            requestedById: Bun.randomUUIDv7(),
            requestedByKind: "user",
            scheduledJobId: scheduleId,
            scheduledJobVersion: 1,
            triggerType: "manual",
        };
        const durableEventAt = new Date(at.getTime() + 20_000);
        const durableEventKinds: string[] = [];
        let appendCount = 0;
        const fixture = repositoryFixture({
            appendEvent: (input) => {
                appendCount += 1;
                if (appendCount === 5) return { kind: "dropped" };
                const event = {
                    attempt: run.attemptCount,
                    jobRunId: run.id,
                    kind: appendCount === 4 ? "output-truncated" : input.kind,
                    message: appendCount === 4 ? null : (input.message ?? null),
                    occurredAt: durableEventAt,
                    progressJson: appendCount === 4 ? null : (input.progressJson ?? null),
                    sequence: appendCount,
                    workerInstanceId: workerId,
                } as const;
                durableEventKinds.push(event.kind);
                return appendCount === 4
                    ? { event, kind: "truncated" }
                    : { event, kind: "appended" };
            },
            claim: { kind: "claimed", run },
        });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: "test.progress",
            execute: (context: JobActionExecutionContext) =>
                Effect.gen(function* () {
                    yield* context.reportProgress({ completed: 1 });
                    yield* context.writeOutput("stdout", "safe output");
                    yield* context.writeOutput("stderr", "safe diagnostic");
                    yield* context.writeOutput("stdout", "truncated output");
                    yield* context.writeOutput("stdout", "dropped output");
                    return {};
                }),
        };
        const eventInvalidations: Array<{
            readonly action: string;
            readonly at: Date;
            readonly targetId: string;
        }> = [];
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
            sideEffects: {
                ...sideEffects,
                forRunEvent: (input) => {
                    eventInvalidations.push({
                        action: input.action,
                        at: input.at,
                        targetId: input.targetId,
                    });
                    return createJobRealtimeSideEffects({
                        occurredAt: input.at,
                        realtime: {
                            id: input.targetId,
                            kind: "run",
                            operation: "updated",
                        },
                    });
                },
                forScheduleEvent: (input) => {
                    eventInvalidations.push({
                        action: input.action,
                        at: input.at,
                        targetId: input.targetId,
                    });
                    return createJobRealtimeSideEffects({
                        occurredAt: input.at,
                        realtime: {
                            id: input.targetId,
                            kind: "schedule",
                            operation: "updated",
                        },
                    });
                },
            },
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.events.filter((event) => event.startsWith("append:"))).toEqual([
            "append:progress",
            "append:stdout",
            "append:stderr",
            "append:stdout",
            "append:stdout",
        ]);
        expect(durableEventKinds).toEqual([
            "progress",
            "stdout",
            "stderr",
            "output-truncated",
        ]);
        expect(eventInvalidations).toEqual([
            { action: "jobs.run.claim", at, targetId: run.id },
            { action: "jobs.run.claim", at, targetId: scheduleId },
            ...Array.from({ length: 4 }, () => [
                { action: "jobs.run.event", at: durableEventAt, targetId: run.id },
                {
                    action: "jobs.run.event",
                    at: durableEventAt,
                    targetId: scheduleId,
                },
            ]).flat(),
        ]);
        expect(
            fixture.eventSideEffects.map(({ auditEvents, realtimeEvents }) => ({
                auditEventCount: auditEvents.length,
                realtime: realtimeEvents.map(({ entityId, topic }) => ({
                    entityId,
                    topic,
                })),
            }))
        ).toEqual(
            Array.from({ length: 4 }, () => ({
                auditEventCount: 0,
                realtime: [
                    { entityId: run.id, topic: "jobs.runs" },
                    { entityId: scheduleId, topic: "schedules.records" },
                ],
            }))
        );
        expect(fixture.settlements[0]?.outcome.kind).toBe("succeeded");
    });

    test("settles persisted cooperative cancellation as cancelled", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.cancel");
        const fixture = repositoryFixture({
            cancellationRequested: true,
            claim: { kind: "claimed", run },
        });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () => Effect.never,
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.settlements[0]?.outcome).toMatchObject({
            kind: "cancelled",
            terminalCode: "cancel-requested",
        });
    });

    test("settles an action timeout without retry", async () => {
        const workerId = Bun.randomUUIDv7();
        const run: JobRunRecord = {
            ...claimedRun(workerId, "test.timeout"),
            timeoutMs: 5,
        };
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () => Effect.never,
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.settlements[0]?.outcome).toMatchObject({
            kind: "timed-out",
            terminalCode: "action-timeout",
        });
    });

    test("schedules retry only for retry-safe failed actions with attempts left", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.retry");
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () =>
                Effect.fail(new JobActionRetryableError(new Error("private failure"))),
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        const outcome = fixture.settlements[0]?.outcome;
        expect(outcome).toMatchObject({
            kind: "failed",
            terminalCode: "action-failed",
            terminalMessage: "The job action failed.",
        });
        expect(outcome?.kind === "failed" ? outcome.retryAt : undefined).toEqual(
            new Date(at.getTime() + 1000)
        );
    });

    test("does not retry permanent action failures", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.permanent-failure");
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () => Effect.fail(new Error("private permanent failure")),
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.settlements[0]?.outcome).toEqual({
            kind: "failed",
            terminalCode: "action-failed",
            terminalMessage: "The job action failed.",
        });
    });

    test("settles a synchronous executor-construction defect without failing the worker", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.synchronous-failure");
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing action definition");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () => {
                throw new Error("private synchronous failure");
            },
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.settlements[0]?.outcome).toEqual({
            kind: "failed",
            terminalCode: "action-failed",
            terminalMessage: "The job action failed.",
        });
        expect(await coordinator.completion).toBeUndefined();
    });

    test("withholds cache persistence from non-cache actions", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.cache-port-denied");
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.find(
            (definition) => definition.actionKey === "system.worker-smoke"
        );
        if (baseRegistration === undefined) throw new Error("Missing smoke definition");
        let cacheCommitCalls = 0;
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: (context) =>
                Effect.tryPromise(() =>
                    context.commitCacheAttempt({
                        durationMs: 1,
                        failureCode: "provider/unavailable",
                        failureMessage: "Provider unavailable.",
                        key: "system.host",
                        kind: "failed",
                    })
                ).pipe(Effect.as({})),
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            commitCacheAttempt: () => {
                cacheCommitCalls += 1;
                return Promise.resolve("committed");
            },
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(cacheCommitCalls).toBe(0);
        expect(fixture.settlements[0]?.outcome).toEqual({
            kind: "failed",
            terminalCode: "action-failed",
            terminalMessage: "The job action failed.",
        });
    });

    test("interrupts and retry-safely settles active work before worker stop", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.shutdown");
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () => Effect.never,
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.events.includes("read-cancellation"));
        await coordinator.dispose();

        expect(fixture.settlements[0]?.outcome).toMatchObject({
            kind: "failed",
            terminalCode: "worker-shutdown",
        });
        expect(
            fixture.settlements[0]?.outcome.kind === "failed"
                ? fixture.settlements[0].outcome.retryAt
                : undefined
        ).toBeInstanceOf(Date);
        expect(fixture.events.indexOf("drain")).toBeLessThan(
            fixture.events.indexOf("settle:failed")
        );
        expect(fixture.events.indexOf("settle:failed")).toBeLessThan(
            fixture.events.indexOf("stop")
        );
    });

    test("clears the forced-drain timer when interrupted work finishes", async () => {
        const forceDrainMs = 123_456;
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.forced-drain-completes");
        const actionGate = deferred<void>();
        const actionStarted = deferred<void>();
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () =>
                Effect.uninterruptible(
                    Effect.promise(() => {
                        actionStarted.resolve();
                        return actionGate.promise;
                    }).pipe(Effect.as({}))
                ),
        };
        const options = coordinatorOptions(fixture.repository, workerId);
        const coordinator = createJobWorkerCoordinator({
            ...options,
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
            timings: { ...options.timings, forceDrainMs },
        });
        const setTimeoutSpy = spyOn(globalThis, "setTimeout");
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
        let forcedTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await coordinator.initialize();
            await actionStarted.promise;
            const force = new AbortController();
            const disposal = coordinator.dispose(force.signal);
            await waitUntil(() => fixture.events.includes("drain"));

            force.abort();
            await waitUntil(() =>
                setTimeoutSpy.mock.calls.some(
                    ([, milliseconds]) => milliseconds === forceDrainMs
                )
            );
            const timerCall = setTimeoutSpy.mock.calls.findIndex(
                ([, milliseconds]) => milliseconds === forceDrainMs
            );
            const timerResult = setTimeoutSpy.mock.results[timerCall];
            if (timerResult?.type !== "return") {
                throw new Error("Forced-drain timer was not created");
            }
            forcedTimer = timerResult.value;
            actionGate.resolve();
            await disposal;

            expect(
                clearTimeoutSpy.mock.calls.some(([timer]) => timer === forcedTimer)
            ).toBeTrue();
        } finally {
            actionGate.resolve();
            if (forcedTimer !== undefined) clearTimeout(forcedTimer);
            clearTimeoutSpy.mockRestore();
            setTimeoutSpy.mockRestore();
        }
    });

    test("fails a forced drain after its bounded timeout", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.forced-drain-timeout");
        const actionGate = deferred<void>();
        const actionStarted = deferred<void>();
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () =>
                Effect.uninterruptible(
                    Effect.promise(() => {
                        actionStarted.resolve();
                        return actionGate.promise;
                    }).pipe(Effect.as({}))
                ),
        };
        const options = coordinatorOptions(fixture.repository, workerId);
        const coordinator = createJobWorkerCoordinator({
            ...options,
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
            timings: { ...options.timings, forceDrainMs: 5 },
        });

        try {
            await coordinator.initialize();
            await actionStarted.promise;
            const force = new AbortController();
            const disposal = coordinator
                .dispose(force.signal)
                .catch((error: unknown) => error);
            await waitUntil(() => fixture.events.includes("drain"));
            force.abort();

            expect(await disposal).toEqual(
                new Error("Durable job action exceeded forced-drain timeout")
            );
            expect(fixture.events).toContain("stop");
        } finally {
            actionGate.resolve();
            await waitUntil(() => fixture.settlements.length === 1);
        }
    });

    test("settles a claim that resolves after worker draining begins", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.deferred-claim");
        const claimGate = deferred<void>();
        const fixture = repositoryFixture({
            claim: { kind: "claimed", run },
            claimGate: claimGate.promise,
        });
        const baseRegistration = jobActionDefinitions.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        let executions = 0;
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: run.actionKey,
            execute: () => {
                executions += 1;
                return Effect.succeed({});
            },
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.events.includes("claim:claimed"));
        const disposal = coordinator.dispose();
        await waitUntil(() => fixture.events.includes("drain"));

        expect(fixture.settlements).toHaveLength(0);
        expect(fixture.events).not.toContain("stop");
        claimGate.resolve();
        await disposal;

        expect(fixture.settlements).toHaveLength(1);
        expect(executions).toBe(0);
        expect(fixture.settlements[0]?.outcome).toMatchObject({
            kind: "failed",
            terminalCode: "worker-shutdown",
        });
        expect(fixture.events.indexOf("drain")).toBeLessThan(
            fixture.events.indexOf("settle:failed")
        );
        expect(fixture.events.indexOf("settle:failed")).toBeLessThan(
            fixture.events.indexOf("stop")
        );
    });

    test("waits for an interrupted infrastructure pass before stopping", async () => {
        const workerId = Bun.randomUUIDv7();
        const expiryGate = deferred<void>();
        const fixture = repositoryFixture({ expiryGate: expiryGate.promise });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        await waitUntil(() => fixture.events.includes("expire-disable-intents"));
        const disposal = coordinator.dispose();
        await waitUntil(() => fixture.events.includes("drain"));
        await Bun.sleep(5);

        expect(fixture.events).not.toContain("stop");
        expiryGate.resolve();
        await disposal;
        expect(fixture.events.indexOf("expire-disable-intents")).toBeLessThan(
            fixture.events.indexOf("stop")
        );
    });

    test("rejects completion when a coordinator loop fails", async () => {
        const workerId = Bun.randomUUIDv7();
        const failure = new Error("heartbeat failed");
        const fixture = repositoryFixture({ heartbeatFailure: failure });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        expect(await coordinator.completion.catch((error: unknown) => error)).toBe(
            failure
        );
        await coordinator.dispose();
    });

    test("fails completion when bounded disable-intent expiry fails", async () => {
        const workerId = Bun.randomUUIDv7();
        const failure = new Error("expiry failed");
        const fixture = repositoryFixture({ expiryFailure: failure });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        expect(await coordinator.completion.catch((error: unknown) => error)).toBe(
            failure
        );
        expect(fixture.events).toContain("expire-disable-intents");
        await coordinator.dispose();
    });

    test("resumes an expired interval at its retained future dormant cursor", async () => {
        const workerId = Bun.randomUUIDv7();
        const schedule = intervalSchedule({
            enabled: false,
            nextRunAt: new Date(at.getTime() + 60_000),
        });
        const fixture = repositoryFixture({ expiringSchedule: schedule });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        await waitUntil(() => fixture.expiryNextRuns.length === 1);
        await coordinator.dispose();

        expect(fixture.expiryNextRuns).toEqual([new Date(at.getTime() + 60_000)]);
        expect(fixture.expiryEligibility).toEqual([true]);
    });

    test("does not resume an expired schedule outside the exact registry pair", async () => {
        const workerId = Bun.randomUUIDv7();
        const schedule = intervalSchedule({
            enabled: false,
            id: "system.worker-smoke-retired",
            nextRunAt: new Date(at.getTime() + 60_000),
        });
        const fixture = repositoryFixture({
            dueSchedules: [schedule],
            expiringSchedule: schedule,
            expiryResults: [
                {
                    intent: expiredDisableIntent(schedule.id),
                    kind: "left-disabled",
                    schedule,
                },
            ],
        });
        const coordinator = createJobWorkerCoordinator(
            coordinatorOptions(fixture.repository, workerId)
        );

        await coordinator.initialize();
        await waitUntil(() => fixture.events.includes("list-due"));
        await coordinator.dispose();

        expect(fixture.expiryEligibility.length).toBeGreaterThanOrEqual(1);
        expect(fixture.expiryEligibility.every((eligible) => !eligible)).toBe(true);
        expect(fixture.expiryNextRuns).toEqual([]);
        expect(fixture.enqueues).toEqual([]);
        expect(fixture.events.indexOf("expire-disable-intents")).toBeLessThan(
            fixture.events.indexOf("list-due")
        );
    });
});
