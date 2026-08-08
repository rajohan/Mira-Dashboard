import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
    type JobActionRegistration,
    JobActionRetryableError,
    jobActionRegistrations,
} from "./actionRegistry.ts";
import {
    createJobWorkerCoordinator,
    type JobWorkerCoordinatorOptions,
    type JobWorkerSideEffectFactory,
} from "./coordinator.ts";
import type {
    JobRunRecord,
    ScheduledJobRecord,
    WorkerInstanceRecord,
} from "./records.ts";
import type {
    DueScheduleEnqueueInput,
    ExpireDisableIntentsInput,
    JobAppendEventResult,
    JobClaimResult,
    JobRepository,
    JobSettlementResult,
} from "./repository.ts";

const releaseId = "a".repeat(40);
const at = new Date("2026-08-08T00:00:00.000Z");

const noSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});
const sideEffects: JobWorkerSideEffectFactory = Object.freeze({
    forQueue: () => noSideEffects,
    forRun: () => noSideEffects,
    forSchedule: () => noSideEffects,
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

function workerRecord(id: string, state: "draining" | "online" | "stopped") {
    return {
        capacity: 1,
        drainingAt: state === "online" ? null : at,
        heartbeatAt: at,
        id,
        pid: 100,
        releaseId,
        startedAt: at,
        state,
        stoppedAt: state === "stopped" ? at : null,
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

interface RepositoryFixtureOptions {
    readonly appendEvent?: (
        kind: "progress" | "stderr" | "stdout"
    ) => JobAppendEventResult;
    readonly cancellationRequested?: boolean;
    readonly claim?: JobClaimResult;
    readonly dueSchedules?: readonly ScheduledJobRecord[];
    readonly expiringSchedule?: ScheduledJobRecord;
    readonly expiryGate?: Promise<void>;
    readonly expiryFailure?: Error;
    readonly heartbeatFailure?: Error;
    readonly settlementAt?: Date;
}

function repositoryFixture(options: RepositoryFixtureOptions = {}) {
    const events: string[] = [];
    const enqueues: DueScheduleEnqueueInput[] = [];
    const expiryNextRuns: Date[] = [];
    const settlements: Array<Parameters<JobRepository["settleClaim"]>[0]> = [];
    let claim = options.claim;
    let dueSchedules = [...(options.dueSchedules ?? [])];
    const repository = {
        appendClaimEvent(input) {
            events.push(`append:${input.kind}`);
            return Promise.resolve(
                options.appendEvent?.(input.kind) ?? { kind: "dropped" }
            );
        },
        beginWorkerDrain(input) {
            events.push("drain");
            return Promise.resolve({
                kind: "updated" as const,
                worker: workerRecord(input.workerId, "draining"),
            });
        },
        claimNextRun(input) {
            const result = claim ?? ({ kind: "empty" } as const);
            claim = undefined;
            events.push(`claim:${result.kind}`);
            if (result.kind === "claimed") input.sideEffectsForClaim(result.run);
            return Promise.resolve(result);
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
                const next = input.nextRunAt(options.expiringSchedule, input.at);
                if (next !== undefined) expiryNextRuns.push(next);
            }
            return [];
        },
        heartbeatWorker(input) {
            events.push("heartbeat");
            if (options.heartbeatFailure) {
                return Promise.reject(options.heartbeatFailure);
            }
            return Promise.resolve(workerRecord(input.workerId, "online"));
        },
        listDueSchedules() {
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
            return Promise.resolve([]);
        },
        recoverExpiredClaims() {
            return Promise.resolve([]);
        },
        registerWorker(input) {
            events.push("register");
            return Promise.resolve(workerRecord(input.worker.id, "online"));
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
                ...claimedRun(input.workerId),
                updatedAt: options.settlementAt ?? at,
            };
            input.sideEffectsForRun(settled);
            return Promise.resolve({
                kind: "settled" as const,
                run: settled,
            } satisfies JobSettlementResult);
        },
        stopWorker(input) {
            events.push("stop");
            return Promise.resolve({
                kind: "updated" as const,
                worker: workerRecord(input.workerId, "stopped"),
            });
        },
    } satisfies JobWorkerCoordinatorOptions["repository"];
    return { enqueues, events, expiryNextRuns, repository, settlements };
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
    return {
        databaseReleaseId: releaseId,
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
        const baseRegistration = jobActionRegistrations.at(0);
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

    test("timestamps claim and settlement side effects from durable state", async () => {
        const workerId = Bun.randomUUIDv7();
        const durableAt = new Date(at.getTime() + 20_000);
        const run: JobRunRecord = {
            ...claimedRun(workerId),
            firstStartedAt: durableAt,
            heartbeatAt: durableAt,
            lastAttemptStartedAt: durableAt,
            leaseExpiresAt: new Date(durableAt.getTime() + 30_000),
            updatedAt: durableAt,
        };
        const fixture = repositoryFixture({
            claim: { kind: "claimed", run },
            settlementAt: durableAt,
        });
        const observed: Array<{ readonly action: string; readonly at: Date }> = [];
        const recordingSideEffects: JobWorkerSideEffectFactory = {
            forQueue: (input) => {
                observed.push({ action: input.action, at: input.at });
                return noSideEffects;
            },
            forRun: (input) => {
                observed.push({ action: input.action, at: input.at });
                return noSideEffects;
            },
            forSchedule: () => noSideEffects,
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
            { action: "jobs.run.claim", at: durableAt },
            { action: "jobs.run.succeeded", at: durableAt },
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

    test("provides bounded durable progress and output callbacks to actions", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.progress");
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionRegistrations.at(0);
        if (baseRegistration === undefined) throw new Error("Missing smoke action");
        const registration: JobActionRegistration = {
            ...baseRegistration,
            actionKey: "test.progress",
            execute: (
                context: Parameters<(typeof jobActionRegistrations)[0]["execute"]>[0]
            ) =>
                Effect.gen(function* () {
                    yield* context.reportProgress({ completed: 1 });
                    yield* context.writeOutput("stdout", "safe output");
                    return {};
                }),
        };
        const coordinator = createJobWorkerCoordinator({
            ...coordinatorOptions(fixture.repository, workerId),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
        });

        await coordinator.initialize();
        await waitUntil(() => fixture.settlements.length === 1);
        await coordinator.dispose();

        expect(fixture.events).toContain("append:progress");
        expect(fixture.events).toContain("append:stdout");
        expect(fixture.settlements[0]?.outcome.kind).toBe("succeeded");
    });

    test("settles persisted cooperative cancellation as cancelled", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.cancel");
        const fixture = repositoryFixture({
            cancellationRequested: true,
            claim: { kind: "claimed", run },
        });
        const baseRegistration = jobActionRegistrations.at(0);
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
        const baseRegistration = jobActionRegistrations.at(0);
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
        const baseRegistration = jobActionRegistrations.at(0);
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
        const baseRegistration = jobActionRegistrations.at(0);
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

    test("interrupts and retry-safely settles active work before worker stop", async () => {
        const workerId = Bun.randomUUIDv7();
        const run = claimedRun(workerId, "test.shutdown");
        const fixture = repositoryFixture({ claim: { kind: "claimed", run } });
        const baseRegistration = jobActionRegistrations.at(0);
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
        expect(
            await coordinator.completion.catch((error: unknown) => error)
        ).toBeDefined();
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
        expect(
            await coordinator.completion.catch((error: unknown) => error)
        ).toBeDefined();
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
    });
});
