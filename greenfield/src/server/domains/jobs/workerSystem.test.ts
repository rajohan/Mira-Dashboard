import { describe, expect, test } from "bun:test";

import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
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
            databaseReleaseId: "a".repeat(40),
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
});
