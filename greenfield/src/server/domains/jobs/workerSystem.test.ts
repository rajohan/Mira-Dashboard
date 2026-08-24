import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { realtimeEvents } from "../../database/schema/realtime.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createCacheRepository } from "../cache/repository.ts";
import { createSystemHostExecutor, findJobWorkerAction } from "./actionExecutors.ts";
import {
    findJobActionDefinition,
    jobActionDefinitions,
    validateJobActionRegistration,
} from "./actionRegistry.ts";
import { createJobWorkerCoordinator } from "./coordinator.ts";
import {
    createJobRepository,
    type JobMutationSideEffects,
    type JobRunEventInsert,
    type JobRunInsert,
} from "./repository.ts";
import { createSystemJobWorkerSideEffects } from "./workerRuntime.ts";

const noSideEffects: JobMutationSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});
const terminalRunStates = new Set(["cancelled", "failed", "succeeded", "timed-out"]);

async function waitForTerminal(
    readState: () => string | undefined
): Promise<string | undefined> {
    const deadline = Date.now() + 2000;
    let state = readState();
    while (state === undefined || !terminalRunStates.has(state)) {
        if (Date.now() >= deadline) return state;
        await Bun.sleep(2);
        state = readState();
    }
    return state;
}

describe("durable job worker system", () => {
    test("stops polling when any terminal state is observed", async () => {
        for (const terminalState of terminalRunStates) {
            let reads = 0;
            expect(
                await waitForTerminal(() => {
                    reads += 1;
                    return terminalState;
                })
            ).toBe(terminalState);
            expect(reads).toBe(1);
        }
    });

    test("claims and settles a repository-enqueued smoke run", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const nowMs = Date.now();
        const workerId = Bun.randomUUIDv7();
        const runId = Bun.randomUUIDv7();
        const coordinator = createJobWorkerCoordinator({
            actionDefinitions: jobActionDefinitions,
            databaseReleaseId: "a".repeat(40),
            findAction: findJobWorkerAction,
            generateId: () => Bun.randomUUIDv7(),
            nowMs: () => nowMs,
            pid: 1234,
            repository,
            sideEffects: createSystemJobWorkerSideEffects(),
            timings: {
                cancellationPollMs: 2,
                claimLeaseMs: 100,
                claimRenewalMs: 20,
                heartbeatMs: 20,
                idlePollMs: 2,
                schedulePollMs: 20,
                workerFreshnessMs: 50,
            },
            workerInstanceId: workerId,
        });
        try {
            await coordinator.initialize();
            const schedule = repository.findSchedule("system.worker-smoke");
            if (schedule === undefined)
                throw new Error("Smoke schedule was not reconciled");
            const at = new Date(nowMs);
            const run: JobRunInsert = {
                actionKey: "system.worker-smoke",
                attemptLimit: 3,
                availableAt: at,
                cancellationPolicy: "cooperative",
                cancelRequestedAt: null,
                cancelRequestedById: null,
                cancelRequestedByKind: null,
                displayName: "Worker smoke",
                enqueueSha256: "b".repeat(64),
                finishedAt: null,
                firstStartedAt: null,
                heartbeatAt: null,
                id: runId,
                idempotencyKey: "c".repeat(64),
                lastAttemptStartedAt: null,
                leaseExpiresAt: null,
                leaseOwnerId: null,
                leaseToken: null,
                payloadJson: "{}",
                priority: 0,
                queuedAt: at,
                requestedById: Bun.randomUUIDv7(),
                requestedByKind: "user",
                resourceClass: "light",
                resourceKeysJson: '["database"]',
                resultJson: null,
                retrySafe: true,
                scheduledForAt: null,
                scheduledJobId: schedule.schedule.id,
                scheduledJobVersion: schedule.schedule.version,
                state: "queued",
                terminalCode: null,
                terminalMessage: null,
                timeoutMs: 30_000,
                triggerType: "manual",
                updatedAt: at,
            };
            const queuedEvent: JobRunEventInsert = {
                attempt: 0,
                jobRunId: run.id,
                kind: "queued",
                message: null,
                occurredAt: at,
                progressJson: null,
                sequence: 1,
                workerInstanceId: null,
            };
            await repository.enqueueManualRun({
                ...noSideEffects,
                queuedEvent,
                run,
            });

            expect(await waitForTerminal(() => repository.findRun(run.id)?.state)).toBe(
                "succeeded"
            );
            expect(repository.findRun(run.id)).toMatchObject({
                attemptCount: 1,
                resultJson: expect.stringContaining('"status":"ok"'),
                state: "succeeded",
            });
        } finally {
            await coordinator.dispose().catch(() => {});
            database.sqlite.close(true);
        }
    });

    test("runs the initially due system.host schedule through cache and outbox commit", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const nowMs = 10_000;
        const cacheRepository = createCacheRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            () => nowMs
        );
        const definition = findJobActionDefinition("cache.refresh.system-host");
        if (definition === undefined) throw new Error("Missing system.host action");
        const registration = validateJobActionRegistration({
            ...definition,
            execute: createSystemHostExecutor({
                collect: () =>
                    Promise.resolve({
                        architecture: "x64",
                        disk: { freeBytes: 512, path: "/", totalBytes: 1024 },
                        hostname: "dashboard-host",
                        memory: { freeBytes: 1024, totalBytes: 2048 },
                        platform: "linux",
                        release: "6.8.0",
                        uptimeSeconds: 42,
                    }),
                monotonicNowMs: () => 10,
            }),
        });
        const workerId = Bun.randomUUIDv7();
        const coordinator = createJobWorkerCoordinator({
            actionDefinitions: [definition],
            commitCacheAttempt: (input) => cacheRepository.commitAttempt(input),
            databaseReleaseId: "a".repeat(40),
            findAction: (actionKey) =>
                actionKey === registration.actionKey ? registration : undefined,
            generateId: () => Bun.randomUUIDv7(),
            nowMs: () => nowMs,
            pid: 1234,
            repository,
            sideEffects: createSystemJobWorkerSideEffects(),
            timings: {
                cancellationPollMs: 2,
                claimLeaseMs: 100,
                claimRenewalMs: 20,
                heartbeatMs: 20,
                idlePollMs: 2,
                schedulePollMs: 2,
                workerFreshnessMs: 50,
            },
            workerInstanceId: workerId,
        });
        try {
            await coordinator.initialize();

            expect(
                await waitForTerminal(
                    () => repository.findLatestRunForSchedule("cache.system-host")?.state
                )
            ).toBe("succeeded");
            expect(
                repository.findLatestRunForSchedule("cache.system-host")
            ).toMatchObject({
                actionKey: "cache.refresh.system-host",
                attemptCount: 1,
                state: "succeeded",
                triggerType: "schedule",
            });
            expect(
                repository.findSchedule("cache.system-host")?.schedule.nextRunAt
            ).toEqual(new Date(nowMs + 86_400_000));
            expect(cacheRepository.findEntry("system.host")).toMatchObject({
                consecutiveFailures: 0,
                expiresAt: new Date(nowMs + 86_400_000),
                key: "system.host",
                lastAttemptNumber: 1,
                lastAttemptStatus: "succeeded",
                payloadJson: expect.stringContaining('"hostname":"dashboard-host"'),
                schemaId: "system.host.v1",
                source: "system.host",
            });
            expect(
                database.orm
                    .select({
                        entityId: realtimeEvents.entityId,
                        payloadJson: realtimeEvents.payloadJson,
                        topic: realtimeEvents.topic,
                    })
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "cache.entries"))
                    .all()
            ).toEqual([
                {
                    entityId: "system.host",
                    payloadJson: '{"key":"system.host"}',
                    topic: "cache.entries",
                },
            ]);
        } finally {
            await coordinator.dispose().catch(() => {});
            database.sqlite.close(true);
        }
    });
});
