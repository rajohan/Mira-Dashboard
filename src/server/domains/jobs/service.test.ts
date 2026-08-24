import { describe, expect, test } from "bun:test";

import { and, asc, eq, gt, max } from "drizzle-orm";
import { Effect } from "effect";

import { jobWorkerFreshnessMs } from "../../../contracts/jobModel.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { auditEvents } from "../../database/schema/auditEvents.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import {
    authenticationTestNow,
    authenticationTestUserId,
    openAuthenticationTestDatabase,
} from "../security/testSupport/authentication.ts";
import {
    dockerFreeJobActionDefinitions,
    dockerOverviewCacheJobScheduleId,
    dockerUpdaterJobScheduleId,
} from "./actionRegistry.ts";
import { JobConflictError, JobValidationError } from "./errors.ts";
import {
    type JobRunEventRecord,
    type ScheduledJobRecord,
    type WorkerInstanceRecord,
    toScheduleSummary,
} from "./records.ts";
import {
    createJobRepository,
    type JobMutationSideEffects,
    type JobRepository,
    type JobRunInsert,
} from "./repository.ts";
import { createJobService, reconcileJobSchedules } from "./service.ts";

function createIdGenerator(): () => string {
    let index = 1;
    return () => `019fdf20-0000-7000-8000-${String(index++).padStart(12, "0")}`;
}

const serviceNowMs = () => authenticationTestNow.getTime();
const noSideEffects: JobMutationSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});

function scheduledRun(schedule: ScheduledJobRecord, at: Date, id: string): JobRunInsert {
    if (schedule.nextRunAt === null) {
        throw new Error("Expected an enabled schedule cursor");
    }
    return {
        actionKey: schedule.actionKey,
        attemptLimit: schedule.attemptLimit,
        availableAt: at,
        cancellationPolicy: schedule.cancellationPolicy,
        cancelRequestedAt: null,
        cancelRequestedById: null,
        cancelRequestedByKind: null,
        displayName: schedule.name,
        enqueueSha256: "2".repeat(64),
        finishedAt: null,
        firstStartedAt: null,
        heartbeatAt: null,
        id,
        idempotencyKey: "2".repeat(32),
        lastAttemptStartedAt: null,
        leaseExpiresAt: null,
        leaseOwnerId: null,
        leaseToken: null,
        payloadJson: schedule.actionPayloadJson,
        priority: schedule.priority,
        queuedAt: at,
        requestedById: "system.scheduler",
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
    };
}

describe("durable jobs service", () => {
    test("converges on Docker-free schedules in either development startup order", async () => {
        const actionDefinitionsByProcess = Object.freeze({
            web: dockerFreeJobActionDefinitions,
            worker: dockerFreeJobActionDefinitions,
        });
        const startupOrders = [
            ["web", "worker"],
            ["worker", "web"],
        ] as const;

        for (const startupOrder of startupOrders) {
            const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
            const repository = createJobRepository(
                fixture.database.orm,
                testImmediateDatabaseWriteAdmission
            );
            const generateId = createIdGenerator();

            try {
                for (const processRole of startupOrder) {
                    await reconcileJobSchedules({
                        actionDefinitions: actionDefinitionsByProcess[processRole],
                        generateId,
                        nowMs: serviceNowMs,
                        repository,
                    });
                }

                expect(
                    repository.findSchedule(dockerOverviewCacheJobScheduleId)
                ).toBeUndefined();
                expect(
                    repository.findSchedule(dockerUpdaterJobScheduleId)
                ).toBeUndefined();
                expect(
                    dockerFreeJobActionDefinitions.every(
                        ({ actionKey, scheduleId }) =>
                            repository.findSchedule(scheduleId)?.schedule.actionKey ===
                            actionKey
                    )
                ).toBe(true);
            } finally {
                fixture.database.sqlite.close(true);
            }
        }
    });

    test("hides the internal worker smoke while exposing operator schedules", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const result = await Effect.runPromise(
                service.listSchedules({ enabled: "all", limit: 100 })
            );

            expect(result.schedules).not.toHaveLength(0);
            expect(result.schedules.some(({ id }) => id === "system.worker-smoke")).toBe(
                false
            );
            expect(
                result.schedules.every(({ manualRunAvailable }) => manualRunAvailable)
            ).toBe(true);
            expect(
                toScheduleSummary(
                    repository.findSchedule("system.worker-smoke")!.schedule
                ).manualRunAvailable
            ).toBe(false);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("accepts a full-form cadence edit while an enabled schedule stays enabled", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            expect(
                Effect.runPromise(
                    service.updateSchedule(principal, {
                        expectedVersion: 1,
                        id: "system.worker-smoke",
                        patch: {
                            disableIntent: { reason: "Already disabled" },
                            enabled: false,
                            schedule: { intervalMs: 120_000, kind: "interval" },
                        },
                    })
                )
            ).rejects.toBeInstanceOf(JobValidationError);
            await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    patch: { disableIntent: null, enabled: true },
                })
            );
            expect(
                Effect.runPromise(
                    service.updateSchedule(principal, {
                        expectedVersion: 2,
                        id: "system.worker-smoke",
                        patch: {
                            disableIntent: null,
                            enabled: true,
                            schedule: {
                                intervalMs: 86_400_000,
                                kind: "interval",
                            },
                        },
                    })
                )
            ).rejects.toBeInstanceOf(JobValidationError);

            const updated = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 2,
                    id: "system.worker-smoke",
                    patch: {
                        disableIntent: null,
                        enabled: true,
                        schedule: { intervalMs: 120_000, kind: "interval" },
                    },
                })
            );

            expect(updated).toMatchObject({
                enabled: true,
                nextRunAtMs: authenticationTestNow.getTime() + 120_000,
                schedule: { intervalMs: 120_000, kind: "interval" },
                version: 3,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("atomically invalidates run and schedule projections for a manual enqueue", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const previousEventId =
                fixture.database.orm
                    .select({ value: max(realtimeEvents.id) })
                    .from(realtimeEvents)
                    .get()?.value ?? 0;

            const run = await Effect.runPromise(
                service.runSchedule(principal, {
                    id: "system.worker-smoke",
                    idempotencyKey: "e".repeat(32),
                })
            );
            const addedEvents = fixture.database.orm
                .select({
                    entityId: realtimeEvents.entityId,
                    id: realtimeEvents.id,
                    topic: realtimeEvents.topic,
                })
                .from(realtimeEvents)
                .where(gt(realtimeEvents.id, previousEventId))
                .orderBy(asc(realtimeEvents.id))
                .all()
                .map(({ entityId, topic }) => ({ entityId, topic }));

            expect(addedEvents).toEqual([
                { entityId: run.id, topic: "jobs.runs" },
                { entityId: "system.worker-smoke", topic: "schedules.records" },
            ]);
            expect(repository.findRun(run.id)).toBeDefined();
            const replayService = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository: {
                    ...repository,
                    findSchedule() {
                        throw new Error(
                            "Idempotency replay performed a mutable schedule lookup"
                        );
                    },
                },
            });
            expect(
                await Effect.runPromise(
                    replayService.runSchedule(principal, {
                        id: "system.worker-smoke",
                        idempotencyKey: "e".repeat(32),
                    })
                )
            ).toEqual(run);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("builds direct cancellation side effects from the durable run snapshot", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };
        const workerId = "019fdf20-0000-7000-8000-000000000900";
        const leaseToken = "019fdf20-0000-7000-8000-000000000901";

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const setupService = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const queued = await Effect.runPromise(
                setupService.runSchedule(principal, {
                    id: "system.worker-smoke",
                    idempotencyKey: "3".repeat(32),
                })
            );
            const queuedRecord = repository.findRun(queued.id);
            if (queuedRecord === undefined) throw new Error("Missing queued run");
            const transitionAt = new Date(authenticationTestNow.getTime() + 60_000);
            await repository.registerWorker({
                ...noSideEffects,
                worker: {
                    actionKeysJson: '["system.worker-smoke"]',
                    capacity: 1,
                    drainingAt: null,
                    heartbeatAt: transitionAt,
                    id: workerId,
                    pid: 1234,
                    releaseId: "a".repeat(40),
                    startedAt: transitionAt,
                    state: "online",
                    stoppedAt: null,
                },
            });
            expect(
                await repository.claimNextRun({
                    bootIdentity: "00000000-0000-0000-0000-000000000001",
                    at: transitionAt,
                    leaseExpiresAt: new Date(transitionAt.getTime() + 30_000),
                    leaseToken,
                    minimumHeartbeatAt: transitionAt,
                    sideEffectsForClaim: () => noSideEffects,
                    workerId,
                })
            ).toMatchObject({
                kind: "claimed",
                run: { id: queued.id, updatedAt: transitionAt },
            });
            const previousEventId =
                fixture.database.orm
                    .select({ value: max(realtimeEvents.id) })
                    .from(realtimeEvents)
                    .get()?.value ?? 0;
            const staleReadRepository: JobRepository = {
                ...repository,
                findRun: (id) =>
                    id === queued.id ? queuedRecord : repository.findRun(id),
            };
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository: staleReadRepository,
            });

            const result = await Effect.runPromise(
                service.cancelRun(principal, { id: queued.id })
            );
            const replay = await Effect.runPromise(
                service.cancelRun(principal, { id: queued.id })
            );
            const addedEvents = fixture.database.orm
                .select({
                    entityId: realtimeEvents.entityId,
                    occurredAt: realtimeEvents.occurredAt,
                    topic: realtimeEvents.topic,
                })
                .from(realtimeEvents)
                .where(gt(realtimeEvents.id, previousEventId))
                .orderBy(asc(realtimeEvents.id))
                .all();
            const cancellationAudits = fixture.database.orm
                .select({
                    action: auditEvents.action,
                    occurredAt: auditEvents.occurredAt,
                    outcome: auditEvents.outcome,
                })
                .from(auditEvents)
                .where(
                    and(
                        eq(auditEvents.action, "jobs.run.cancel"),
                        eq(auditEvents.targetId, queued.id)
                    )
                )
                .all();

            expect(result).toMatchObject({
                cancelRequestedAtMs: transitionAt.getTime(),
                id: queued.id,
                state: "running",
                updatedAtMs: transitionAt.getTime(),
            });
            expect(replay).toEqual(result);
            expect(addedEvents).toEqual([
                {
                    entityId: queued.id,
                    occurredAt: transitionAt,
                    topic: "jobs.runs",
                },
                {
                    entityId: "system.worker-smoke",
                    occurredAt: transitionAt,
                    topic: "schedules.records",
                },
            ]);
            expect(cancellationAudits).toEqual([
                {
                    action: "jobs.run.cancel",
                    occurredAt: transitionAt,
                    outcome: "accepted",
                },
            ]);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("timestamps disable cancellation side effects from the cancelled run", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    patch: { disableIntent: null, enabled: true },
                })
            );
            const relation = repository.findSchedule("system.worker-smoke");
            if (relation === undefined) throw new Error("Missing enabled schedule");
            const schedule = relation.schedule;
            const runAt = schedule.nextRunAt;
            if (runAt === null) throw new Error("Missing enabled schedule cursor");
            if (schedule.intervalMs === null) {
                throw new Error("Expected the smoke interval schedule");
            }
            const run = scheduledRun(
                schedule,
                runAt,
                "019fdf20-0000-7000-8000-000000000902"
            );
            expect(
                await repository.enqueueNextDueSchedule({
                    ...noSideEffects,
                    at: runAt,
                    nextRunAt: new Date(runAt.getTime() + schedule.intervalMs),
                    observedNextRunAt: runAt,
                    run,
                    scheduleId: schedule.id,
                })
            ).toMatchObject({ kind: "inserted", run: { id: run.id } });
            const previousEventId =
                fixture.database.orm
                    .select({ value: max(realtimeEvents.id) })
                    .from(realtimeEvents)
                    .get()?.value ?? 0;

            await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 2,
                    id: schedule.id,
                    patch: {
                        disableIntent: { reason: "Clock-regression maintenance" },
                        enabled: false,
                    },
                })
            );
            const cancelled = repository.findRun(run.id);
            const addedEvents = fixture.database.orm
                .select({
                    entityId: realtimeEvents.entityId,
                    occurredAt: realtimeEvents.occurredAt,
                    topic: realtimeEvents.topic,
                })
                .from(realtimeEvents)
                .where(gt(realtimeEvents.id, previousEventId))
                .orderBy(asc(realtimeEvents.id))
                .all();
            const cancellationAudits = fixture.database.orm
                .select({
                    occurredAt: auditEvents.occurredAt,
                    outcome: auditEvents.outcome,
                })
                .from(auditEvents)
                .where(
                    and(
                        eq(auditEvents.action, "jobs.run.cancel"),
                        eq(auditEvents.targetId, run.id)
                    )
                )
                .all();

            expect(cancelled).toMatchObject({
                state: "cancelled",
                updatedAt: runAt,
            });
            expect(addedEvents).toEqual([
                { entityId: run.id, occurredAt: runAt, topic: "jobs.runs" },
                {
                    entityId: schedule.id,
                    occurredAt: runAt,
                    topic: "schedules.records",
                },
                {
                    entityId: schedule.id,
                    occurredAt: authenticationTestNow,
                    topic: "schedules.records",
                },
            ]);
            expect(cancellationAudits).toEqual([
                { occurredAt: runAt, outcome: "cancelled" },
            ]);
            expect(repository.findSchedule(schedule.id)?.schedule).toMatchObject({
                enabled: false,
                updatedAt: authenticationTestNow,
                version: 3,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("preserves an active disable intent across a schedule-only update", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            expect(
                Effect.runPromise(
                    service.updateSchedule(principal, {
                        expectedVersion: 1,
                        id: "system.worker-smoke",
                        patch: {
                            schedule: {
                                intervalMs: 86_400_000,
                                kind: "interval",
                            },
                        },
                    })
                )
            ).rejects.toBeInstanceOf(JobValidationError);
            expect(
                Effect.runPromise(
                    service.updateSchedule(principal, {
                        expectedVersion: 1,
                        id: "system.worker-smoke",
                        patch: {
                            disableIntent: { reason: "Already disabled" },
                            enabled: false,
                        },
                    })
                )
            ).rejects.toBeInstanceOf(JobValidationError);
            const unchanged = repository.findSchedule("system.worker-smoke");
            expect(unchanged?.activeDisableIntent).toBeUndefined();
            expect(unchanged?.schedule).toMatchObject({ enabled: false, version: 1 });

            const enabled = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    patch: { disableIntent: null, enabled: true },
                })
            );
            expect(enabled.nextRunAtMs).toBe(
                authenticationTestNow.getTime() + 86_400_000
            );
            const disabled = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 2,
                    id: "system.worker-smoke",
                    patch: {
                        disableIntent: { reason: "Operator maintenance" },
                        enabled: false,
                    },
                })
            );
            const originalIntent = disabled.activeDisableIntent;
            expect(disabled).toMatchObject({
                enabled: false,
                version: 3,
            });
            expect(disabled.nextRunAtMs).toBeUndefined();
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(enabled.nextRunAtMs!));
            expect(originalIntent).toMatchObject({
                reason: "Operator maintenance",
            });

            const updated = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 3,
                    id: "system.worker-smoke",
                    patch: {
                        schedule: { intervalMs: 120_000, kind: "interval" },
                    },
                })
            );

            expect(updated).toMatchObject({
                activeDisableIntent: originalIntent,
                enabled: false,
                schedule: { intervalMs: 120_000, kind: "interval" },
                version: 4,
            });
            expect(
                repository.findSchedule("system.worker-smoke")?.activeDisableIntent
            ).toMatchObject({
                endedAt: null,
                id: originalIntent?.id,
                reason: "Operator maintenance",
            });
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(authenticationTestNow.getTime() + 120_000));

            const replacement = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 4,
                    id: "system.worker-smoke",
                    patch: {
                        disableIntent: {
                            expiresAtMs: authenticationTestNow.getTime() + 600_000,
                            reason: "Extended operator maintenance",
                        },
                        enabled: false,
                    },
                })
            );
            expect(replacement).toMatchObject({
                activeDisableIntent: {
                    reason: "Extended operator maintenance",
                },
                enabled: false,
                version: 5,
            });
            expect(replacement.activeDisableIntent?.id).not.toBe(originalIntent?.id);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("stores the recalculated dormant cursor when cadence changes during disable", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const enabled = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    patch: { disableIntent: null, enabled: true },
                })
            );
            const disabled = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 2,
                    id: "system.worker-smoke",
                    patch: {
                        disableIntent: { reason: "Change cadence during maintenance" },
                        enabled: false,
                        schedule: { intervalMs: 120_000, kind: "interval" },
                    },
                })
            );

            expect(disabled).toMatchObject({
                enabled: false,
                schedule: { intervalMs: 120_000, kind: "interval" },
                version: 3,
            });
            expect(disabled.nextRunAtMs).toBeUndefined();
            expect(enabled.nextRunAtMs).toBe(
                authenticationTestNow.getTime() + 86_400_000
            );
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(authenticationTestNow.getTime() + 120_000));
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("atomically cancels queued schedule work retired from the registry", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const retiredScheduleId = "system.worker-smoke-retired";

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const registered = repository.findSchedule("system.worker-smoke")?.schedule;
            if (registered === undefined) throw new Error("Missing registered schedule");
            const runAt = new Date(authenticationTestNow.getTime() + 60_000);
            await repository.reconcileSchedules({
                at: authenticationTestNow,
                schedules: [
                    registered,
                    {
                        ...registered,
                        enabled: true,
                        id: retiredScheduleId,
                        nextRunAt: runAt,
                    },
                ],
                sideEffectsForSchedule: () => noSideEffects,
            });
            const retiredSchedule = repository.findSchedule(retiredScheduleId)?.schedule;
            if (retiredSchedule === undefined) {
                throw new Error("Missing retired schedule fixture");
            }
            if (retiredSchedule.intervalMs === null) {
                throw new Error("Expected the smoke interval schedule");
            }
            const run = scheduledRun(
                retiredSchedule,
                runAt,
                "019fdf20-0000-7000-8000-000000000903"
            );
            await repository.enqueueNextDueSchedule({
                ...noSideEffects,
                at: runAt,
                nextRunAt: new Date(runAt.getTime() + retiredSchedule.intervalMs),
                observedNextRunAt: runAt,
                run,
                scheduleId: retiredScheduleId,
            });
            const previousEventId =
                fixture.database.orm
                    .select({ value: max(realtimeEvents.id) })
                    .from(realtimeEvents)
                    .get()?.value ?? 0;

            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });

            expect(repository.findRun(run.id)).toMatchObject({
                eventCount: 3,
                state: "cancelled",
                terminalCode: "cancelled/schedule-retired",
                updatedAt: runAt,
            });
            expect(repository.findSchedule(retiredScheduleId)?.schedule).toMatchObject({
                enabled: false,
                updatedAt: authenticationTestNow,
                version: 2,
            });
            expect(
                fixture.database.orm
                    .select({
                        entityId: realtimeEvents.entityId,
                        occurredAt: realtimeEvents.occurredAt,
                        topic: realtimeEvents.topic,
                    })
                    .from(realtimeEvents)
                    .where(gt(realtimeEvents.id, previousEventId))
                    .orderBy(asc(realtimeEvents.id))
                    .all()
            ).toEqual([
                { entityId: run.id, occurredAt: runAt, topic: "jobs.runs" },
                {
                    entityId: retiredScheduleId,
                    occurredAt: runAt,
                    topic: "schedules.records",
                },
                {
                    entityId: retiredScheduleId,
                    occurredAt: authenticationTestNow,
                    topic: "schedules.records",
                },
            ]);
            expect(
                fixture.database.orm
                    .select({
                        action: auditEvents.action,
                        actorId: auditEvents.actorId,
                        actorKind: auditEvents.actorKind,
                        occurredAt: auditEvents.occurredAt,
                        outcome: auditEvents.outcome,
                    })
                    .from(auditEvents)
                    .where(
                        and(
                            eq(auditEvents.action, "jobs.run.cancel"),
                            eq(auditEvents.targetId, run.id)
                        )
                    )
                    .all()
            ).toEqual([
                {
                    action: "jobs.run.cancel",
                    actorId: "jobs-scheduler",
                    actorKind: "system",
                    occurredAt: runAt,
                    outcome: "cancelled",
                },
            ]);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails a queued never-cancellable run whose action leaves the registry", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const retiredScheduleId = "system.worker-smoke-never-retired";

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const registered = repository.findSchedule("system.worker-smoke")?.schedule;
            if (registered === undefined) throw new Error("Missing registered schedule");
            const runAt = new Date(authenticationTestNow.getTime() + 60_000);
            await repository.reconcileSchedules({
                at: authenticationTestNow,
                schedules: [
                    registered,
                    {
                        ...registered,
                        cancellationPolicy: "never",
                        enabled: true,
                        id: retiredScheduleId,
                        nextRunAt: runAt,
                    },
                ],
                sideEffectsForSchedule: () => noSideEffects,
            });
            const retiredSchedule = repository.findSchedule(retiredScheduleId)?.schedule;
            if (retiredSchedule === undefined) {
                throw new Error("Missing never-cancellable retired schedule fixture");
            }
            if (retiredSchedule.intervalMs === null) {
                throw new Error("Expected the smoke interval schedule");
            }
            const run = scheduledRun(
                retiredSchedule,
                runAt,
                "019fdf20-0000-7000-8000-000000000904"
            );
            await repository.enqueueNextDueSchedule({
                ...noSideEffects,
                at: runAt,
                nextRunAt: new Date(runAt.getTime() + retiredSchedule.intervalMs),
                observedNextRunAt: runAt,
                run,
                scheduleId: retiredScheduleId,
            });
            const previousEventId =
                fixture.database.orm
                    .select({ value: max(realtimeEvents.id) })
                    .from(realtimeEvents)
                    .get()?.value ?? 0;

            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });

            expect(repository.findRun(run.id)).toMatchObject({
                attemptCount: 0,
                cancelRequestedAt: null,
                eventCount: 2,
                firstStartedAt: null,
                lastAttemptStartedAt: null,
                state: "failed",
                terminalCode: "action-unavailable",
                updatedAt: runAt,
            });
            expect(repository.findSchedule(retiredScheduleId)?.schedule).toMatchObject({
                enabled: false,
                updatedAt: authenticationTestNow,
                version: 2,
            });
            expect(
                fixture.database.orm
                    .select({
                        entityId: realtimeEvents.entityId,
                        occurredAt: realtimeEvents.occurredAt,
                        topic: realtimeEvents.topic,
                    })
                    .from(realtimeEvents)
                    .where(gt(realtimeEvents.id, previousEventId))
                    .orderBy(asc(realtimeEvents.id))
                    .all()
            ).toEqual([
                {
                    entityId: run.id,
                    occurredAt: runAt,
                    topic: "jobs.runs",
                },
                {
                    entityId: retiredScheduleId,
                    occurredAt: runAt,
                    topic: "schedules.records",
                },
                {
                    entityId: retiredScheduleId,
                    occurredAt: authenticationTestNow,
                    topic: "schedules.records",
                },
            ]);
            expect(
                fixture.database.orm
                    .select({ action: auditEvents.action })
                    .from(auditEvents)
                    .where(eq(auditEvents.targetId, run.id))
                    .all()
            ).toEqual([{ action: "jobs.run.action-unavailable" }]);

            const eventCount = fixture.database.orm
                .select()
                .from(realtimeEvents)
                .all().length;
            const auditCount = fixture.database.orm
                .select()
                .from(auditEvents)
                .all().length;
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            expect(fixture.database.orm.select().from(realtimeEvents).all()).toHaveLength(
                eventCount
            );
            expect(fixture.database.orm.select().from(auditEvents).all()).toHaveLength(
                auditCount
            );
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("rejects mutations for a schedule outside the exact action registry pair", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const registered = repository.findSchedule("system.worker-smoke")?.schedule;
            if (registered === undefined) throw new Error("Missing registered schedule");
            await repository.reconcileSchedules({
                at: authenticationTestNow,
                schedules: [{ ...registered, id: "system.worker-smoke-retired" }],
                sideEffectsForSchedule: () => ({
                    auditEvents: [],
                    realtimeEvents: [],
                }),
            });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });

            const runError = await Effect.runPromise(
                service.runSchedule(principal, {
                    id: "system.worker-smoke-retired",
                    idempotencyKey: "f".repeat(32),
                })
            ).catch((error: unknown) => error);
            expect(runError).toBeInstanceOf(JobConflictError);
            expect(runError).toMatchObject({ reason: "action-unavailable" });
            expect(
                Effect.runPromise(
                    service.updateSchedule(principal, {
                        expectedVersion: 1,
                        id: "system.worker-smoke-retired",
                        patch: { disableIntent: null, enabled: true },
                    })
                )
            ).rejects.toBeInstanceOf(JobConflictError);
            expect(
                repository.findSchedule("system.worker-smoke-retired")?.schedule
            ).toMatchObject({ enabled: false, version: 1 });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("rejects a manual enqueue when code metadata changes after the service read", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            let attemptedRunId: string | undefined;
            const interleavedRepository: JobRepository = {
                ...repository,
                enqueueManualRun: async (input) => {
                    attemptedRunId = input.run.id;
                    const current = repository.findSchedule(
                        input.run.scheduledJobId ?? ""
                    )?.schedule;
                    if (current === undefined) {
                        throw new Error("Missing schedule for interleaved enqueue");
                    }
                    await repository.reconcileSchedules({
                        at: new Date(authenticationTestNow.getTime() + 1),
                        schedules: [
                            {
                                ...current,
                                name: "Worker smoke from the next release",
                                updatedAt: new Date(authenticationTestNow.getTime() + 1),
                            },
                        ],
                        sideEffectsForSchedule: () => noSideEffects,
                    });
                    return repository.enqueueManualRun(input);
                },
            };
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository: interleavedRepository,
            });

            const error = await Effect.runPromise(
                service.runSchedule(principal, {
                    id: "system.worker-smoke",
                    idempotencyKey: "d".repeat(32),
                })
            ).catch((error: unknown) => error);

            expect(error).toBeInstanceOf(JobConflictError);
            expect(error).toMatchObject({ reason: "action-unavailable" });
            expect(attemptedRunId).toBeDefined();
            expect(repository.findRun(attemptedRunId ?? "")).toBeUndefined();
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule
            ).toMatchObject({
                name: "Worker smoke from the next release",
                version: 2,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("maps a never-cancellable queued schedule run to a declared conflict", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    patch: { disableIntent: null, enabled: true },
                })
            );
            const runSummary = await Effect.runPromise(
                service.runSchedule(principal, {
                    id: "system.worker-smoke",
                    idempotencyKey: "1".repeat(32),
                })
            );
            const run = repository.findRun(runSummary.id);
            if (run === undefined) throw new Error("Expected the manual run fixture");
            const conflictRepository: JobRepository = {
                ...repository,
                updateSchedule: () =>
                    Promise.resolve({
                        kind: "cancellation-not-supported",
                        run,
                    }),
            };
            const conflictService = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository: conflictRepository,
            });

            expect(
                Effect.runPromise(
                    conflictService.updateSchedule(principal, {
                        expectedVersion: 2,
                        id: "system.worker-smoke",
                        patch: {
                            disableIntent: { reason: "Maintenance" },
                            enabled: false,
                        },
                    })
                )
            ).rejects.toBeInstanceOf(JobConflictError);
            const unchangedSchedule = repository.findSchedule("system.worker-smoke");
            expect(unchangedSchedule?.activeDisableIntent).toBeUndefined();
            expect(unchangedSchedule?.schedule).toMatchObject({
                enabled: true,
                version: 2,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("reads run and events from one snapshot across an interleaved worker transition", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const setupService = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const queued = await Effect.runPromise(
                setupService.runSchedule(principal, {
                    id: "system.worker-smoke",
                    idempotencyKey: "A".repeat(32),
                })
            );
            const snapshot = repository.findRunDetail({
                limit: 10,
                runId: queued.id,
            });
            if (snapshot === undefined) throw new Error("Missing queued run snapshot");

            const interleavedEvent = {
                attempt: 1,
                jobRunId: queued.id,
                kind: "claimed",
                message: null,
                occurredAt: new Date(snapshot.run.updatedAt.getTime() + 1),
                progressJson: null,
                sequence: 2,
                workerInstanceId: "019fdf20-0000-7000-8000-000000000099",
            } satisfies JobRunEventRecord;
            const listSnapshot = repository.listRunsWithQueueState({
                limit: 10,
                minimumHeartbeatAt: new Date(0),
            });
            const expectedMinimumHeartbeatAt = new Date(
                serviceNowMs() - jobWorkerFreshnessMs
            );
            const workerStartedAt = new Date(expectedMinimumHeartbeatAt.getTime() - 1000);
            const workerRecord = (
                id: string,
                heartbeatAt: Date
            ): WorkerInstanceRecord => ({
                actionKeysJson: "[]",
                capacity: 1,
                drainingAt: null,
                heartbeatAt,
                id,
                pid: 1234,
                releaseId: "a".repeat(40),
                startedAt: workerStartedAt,
                state: "online",
                stoppedAt: null,
            });
            const staleWorker = workerRecord(
                "019fdf20-0000-7000-8000-000000000097",
                new Date(expectedMinimumHeartbeatAt.getTime() - 1)
            );
            const boundaryWorker = workerRecord(
                "019fdf20-0000-7000-8000-000000000098",
                expectedMinimumHeartbeatAt
            );
            let snapshotReads = 0;
            let listSnapshotReads = 0;
            let legacyRunReads = 0;
            let legacyEventReads = 0;
            let legacyListReads = 0;
            let legacyQueueReads = 0;
            let observedMinimumHeartbeatAt: Date | undefined;
            const interleavedRepository: JobRepository = {
                ...repository,
                findRun: () => {
                    legacyRunReads += 1;
                    return snapshot.run;
                },
                findRunDetail: () => {
                    snapshotReads += 1;
                    return snapshot;
                },
                listRunEvents: () => {
                    legacyEventReads += 1;
                    return [interleavedEvent, ...snapshot.events];
                },
                listRuns: () => {
                    legacyListReads += 1;
                    return [];
                },
                listRunsWithQueueState: (input) => {
                    listSnapshotReads += 1;
                    observedMinimumHeartbeatAt = input.minimumHeartbeatAt;
                    return {
                        ...listSnapshot,
                        queue: {
                            ...listSnapshot.queue,
                            workers: [staleWorker, boundaryWorker]
                                .filter(
                                    (worker) =>
                                        worker.heartbeatAt.getTime() >=
                                        input.minimumHeartbeatAt.getTime()
                                )
                                .map((worker) => ({ activeRunCount: 0, worker })),
                        },
                    };
                },
                readQueueState: () => {
                    legacyQueueReads += 1;
                    return listSnapshot.queue;
                },
            };
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository: interleavedRepository,
            });

            const detail = await Effect.runPromise(
                service.getRun({ eventLimit: 10, id: queued.id })
            );
            const listing = await Effect.runPromise(service.listRuns({ limit: 10 }));

            expect(detail.events.map(({ sequence }) => sequence)).toEqual([1]);
            expect(detail.run).toMatchObject({ attemptCount: 0, eventCount: 1 });
            expect(listing.runs.map(({ id }) => id)).toEqual([queued.id]);
            expect(observedMinimumHeartbeatAt).toEqual(expectedMinimumHeartbeatAt);
            expect(listing.summary.workers.map(({ id }) => id)).toEqual([
                boundaryWorker.id,
            ]);
            expect(listing.summary.workers[0]?.heartbeatAtMs).toBe(
                expectedMinimumHeartbeatAt.getTime()
            );
            expect({
                legacyEventReads,
                legacyListReads,
                legacyQueueReads,
                legacyRunReads,
                listSnapshotReads,
                snapshotReads,
            }).toEqual({
                legacyEventReads: 0,
                legacyListReads: 0,
                legacyQueueReads: 0,
                legacyRunReads: 0,
                listSnapshotReads: 1,
                snapshotReads: 1,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("reads only worker control before changing the claiming state", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };
        let queueReads = 0;
        let workerControlReads = 0;
        const narrowRepository: JobRepository = {
            ...repository,
            readQueueState: () => {
                queueReads += 1;
                throw new Error("Queue summary should not be read before pausing claims");
            },
            readWorkerControl: () => {
                workerControlReads += 1;
                return repository.readWorkerControl();
            },
        };
        const service = createJobService({
            generateId: createIdGenerator(),
            nowMs: serviceNowMs,
            repository: narrowRepository,
        });

        try {
            const control = await Effect.runPromise(
                service.setClaimingPaused(principal, {
                    expectedVersion: 1,
                    paused: true,
                })
            );

            expect(control).toMatchObject({ claimingPaused: true, version: 2 });
            expect({ queueReads, workerControlReads }).toEqual({
                queueReads: 0,
                workerControlReads: 1,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
