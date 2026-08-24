import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { Effect } from "effect";

import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import { JobConflictError, JobNotFoundError, JobValidationError } from "./errors.ts";
import { createTestJobService } from "./testSupport/service.ts";

const runId = "018f6f50-6a9e-7b88-8000-000000000001";
const scheduleId = "system.worker-smoke";

const queuedRun = Object.freeze({
    actionKey: "system.worker-smoke",
    attemptCount: 0,
    attemptLimit: 3,
    availableAtMs: 1000,
    cancellationPolicy: "cooperative" as const,
    displayName: "Worker smoke",
    eventCount: 1,
    id: runId,
    priority: 0,
    queuedAtMs: 1000,
    resourceClass: "light" as const,
    resourceKeys: ["database"],
    retrySafe: true,
    scheduledJobId: scheduleId,
    scheduledJobVersion: 1,
    state: "queued" as const,
    stateVersion: 1,
    timeoutMs: 30_000,
    triggerType: "manual" as const,
    updatedAtMs: 1000,
});

const kopiaSchedule = Object.freeze({
    actionKey: "backup.kopia.run",
    attemptLimit: 1,
    cancellationPolicy: "never" as const,
    createdAtMs: 500,
    description: "Runs one fixed Kopia provider backup.",
    enabled: true,
    id: "backup.kopia.run",
    manualRunAvailable: true,
    name: "Kopia backup",
    nextRunAtMs: 60_000,
    priority: 10,
    resourceClass: "exclusive" as const,
    resourceKeys: ["backup.heavy-io", "docker.engine"],
    retrySafe: false,
    schedule: {
        kind: "daily" as const,
        timeOfDay: "03:50",
        timeZone: "Europe/Oslo",
    },
    timeoutMs: 6 * 60 * 60_000,
    updatedAtMs: 1000,
    version: 1,
});

const workerSmokeSchedule = Object.freeze({
    ...kopiaSchedule,
    actionKey: "system.worker-smoke",
    attemptLimit: 3,
    cancellationPolicy: "cooperative" as const,
    description: "Verifies the release worker without host mutation.",
    id: scheduleId,
    name: "Worker smoke",
    priority: 0,
    resourceClass: "light" as const,
    resourceKeys: ["database"],
    retrySafe: true,
    schedule: { intervalMs: 86_400_000, kind: "interval" as const },
    timeoutMs: 30_000,
});

async function expectTrpcCode(
    operation: () => Promise<unknown>,
    code: TRPCError["code"]
): Promise<void> {
    const failure = await captureFailure(operation);
    expect(failure).toBeInstanceOf(TRPCError);
    expect((failure as TRPCError).code).toBe(code);
}

describe("durable jobs procedures", () => {
    test("enforces capabilities and session-only operator mutations", async () => {
        const anonymous = appRouter.createCaller(await createTestRequestContext());
        await expectTrpcCode(
            () => anonymous.jobs.listRuns({ limit: 10 }),
            "UNAUTHORIZED"
        );

        const missingCapability = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["tasks:read"])
            )
        );
        await expectTrpcCode(
            () => missingCapability.schedules.list({ limit: 10 }),
            "FORBIDDEN"
        );

        const automationService = createTestJobService({
            getSchedule: () => Effect.succeed(workerSmokeSchedule),
            runSchedule: () => Effect.succeed(queuedRun),
        });
        const automation = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["jobs:write"]),
                createTestApplicationRuntime(),
                { jobService: automationService }
            )
        );
        await expectTrpcCode(() => automation.jobs.cancelRun({ id: runId }), "FORBIDDEN");
        await expectTrpcCode(
            () =>
                automation.jobs.setClaimingPaused({
                    expectedVersion: 1,
                    paused: true,
                }),
            "FORBIDDEN"
        );
        await expectTrpcCode(
            () =>
                automation.schedules.update({
                    expectedVersion: 1,
                    id: scheduleId,
                    patch: {
                        disableIntent: {
                            reason: "Operator-only",
                        },
                        enabled: false,
                    },
                }),
            "FORBIDDEN"
        );
        expect(
            await automation.schedules.run({
                id: scheduleId,
                idempotencyKey: "A".repeat(32),
            })
        ).toEqual(queuedRun);
    });

    test("maps declared domain failures without exposing implementation errors", async () => {
        const service = createTestJobService({
            cancelRun: () =>
                Effect.fail(
                    new JobConflictError({
                        id: runId,
                        reason: "state-changed",
                        resource: "job-run",
                    })
                ),
            getRun: () =>
                Effect.fail(new JobNotFoundError({ id: runId, resource: "job-run" })),
            updateSchedule: () =>
                Effect.fail(
                    new JobValidationError({
                        id: scheduleId,
                        reason: "disable-intent-expired",
                        resource: "schedule",
                    })
                ),
        });
        const caller = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["jobs:read", "jobs:write"]),
                createTestApplicationRuntime(),
                { jobService: service }
            )
        );

        await expectTrpcCode(() => caller.jobs.getRun({ id: runId }), "NOT_FOUND");
        await expectTrpcCode(() => caller.jobs.cancelRun({ id: runId }), "CONFLICT");
        await expectTrpcCode(
            () =>
                caller.schedules.update({
                    expectedVersion: 1,
                    id: scheduleId,
                    patch: { schedule: { intervalMs: 60_000, kind: "interval" } },
                }),
            "BAD_REQUEST"
        );
    });

    test("requires the schedule domain grant and recent MFA before manual enqueue", async () => {
        const service = createTestJobService({
            getSchedule: () => Effect.succeed(kopiaSchedule),
            runSchedule: () => Effect.succeed(queuedRun),
        });
        const jobsOnly = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["jobs:write"]),
                createTestApplicationRuntime(),
                { jobService: service }
            )
        );
        await expectTrpcCode(
            () =>
                jobsOnly.schedules.run({
                    id: kopiaSchedule.id,
                    idempotencyKey: "B".repeat(32),
                }),
            "FORBIDDEN"
        );

        const automation = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["jobs:write"]),
                createTestApplicationRuntime(),
                { jobService: service }
            )
        );
        await expectTrpcCode(
            () =>
                automation.schedules.run({
                    id: kopiaSchedule.id,
                    idempotencyKey: "E".repeat(32),
                }),
            "FORBIDDEN"
        );

        const staleMfa = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["backups:write", "jobs:write"]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        authorizeRecentMfa: () => "step-up-required",
                    }),
                    jobService: service,
                }
            )
        );
        await expectTrpcCode(
            () =>
                staleMfa.schedules.run({
                    id: kopiaSchedule.id,
                    idempotencyKey: "C".repeat(32),
                }),
            "FORBIDDEN"
        );

        const authorized = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["backups:write", "jobs:write"]),
                createTestApplicationRuntime(),
                { jobService: service }
            )
        );
        expect(
            await authorized.schedules.run({
                id: kopiaSchedule.id,
                idempotencyKey: "D".repeat(32),
            })
        ).toEqual(queuedRun);
    });
});
