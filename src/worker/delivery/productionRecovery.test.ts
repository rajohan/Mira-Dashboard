import { describe, expect, test } from "bun:test";

import {
    createDeliveryProductionRecovery,
    DeliveryProductionRecoveryError,
} from "../../server/domains/jobs/deliveryProductionRecovery.ts";
import { createJobRepository } from "../../server/domains/jobs/repository.ts";
import { createJobMutationSideEffects } from "../../server/domains/jobs/sideEffects.ts";
import { testImmediateDatabaseWriteAdmission } from "../../server/test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../server/test/support/freshDatabase.ts";
import {
    parseDeliveryProductionOperationCapsule,
    parseDeliveryProductionOperationRecord,
    serializeDeliveryProductionPayload,
    type DeliveryProductionOperationInspection,
} from "../../shared/deliveryProductionOperation.ts";
import type { ProductionDeliveryControlPort } from "./productionDeliveryControl.ts";
import { reconcileDeliveryProductionCutoverBeforeValidation } from "./productionRecovery.ts";

const transitionId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
const noSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});

function terminalInspection(): Extract<
    DeliveryProductionOperationInspection,
    { state: "terminal" }
> {
    const payload = {
        activationRevision: "1".repeat(64),
        operation: "rollback-release" as const,
        sourceRevision: "f".repeat(64),
        target: {
            databaseSnapshotTransitionId: "019fd974-54a2-74dd-a64b-d4186f8d8826",
            releaseId: "c".repeat(40),
            runtimeRevision: "d".repeat(40),
        },
    };
    const capsule = parseDeliveryProductionOperationCapsule({
        cas: {
            current: {
                activationTransitionId: "019fd974-54a2-74dd-a64b-d4186f8d8827",
                releaseId: "a".repeat(40),
                rollbackSnapshotTransitionId: transitionId,
                runtimeRevision: "b".repeat(40),
            },
            target: {
                databaseSnapshotTransitionId: "019fd974-54a2-74dd-a64b-d4186f8d8826",
                releaseId: "c".repeat(40),
                runtimeRevision: "d".repeat(40),
            },
        },
        enqueue: {
            actionKey: "delivery.production.v1",
            actor: {
                authenticatorId: "authenticator-delivery-test",
                id: "019fd974-54a2-74dd-a64b-d4186f8d8825",
                kind: "user",
            },
            audit: {
                eventId: "019fd974-54a2-74dd-a64b-d4186f8d8824",
                requestId: "request-delivery-test",
            },
            enqueueSha256: "e".repeat(64),
            idempotencyKey: "A".repeat(32),
            payload,
            payloadSha256: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify(payload))
                .digest("hex"),
            queuedAtMs: 1000,
        },
        executor: {
            releaseId: "e".repeat(40),
            runtimeRevision: "b".repeat(40),
        },
        protocol: "delivery.production.v2",
        runId: transitionId,
        transitionId,
    });
    const record = parseDeliveryProductionOperationRecord({
        capsule,
        phase: "terminal",
        result: {
            activation: {
                current: {
                    releaseId: "c".repeat(40),
                    runtimeRevision: "d".repeat(40),
                },
                formatVersion: 1,
                previous: {
                    databaseSnapshotTransitionId: transitionId,
                    releaseId: "a".repeat(40),
                    runtimeRevision: "b".repeat(40),
                },
                transitionId,
            },
            completedAtMs: 2000,
            outcome: "succeeded",
        },
        updatedAtMs: 2000,
    });
    if (record.phase !== "terminal") throw new Error("Expected terminal fixture");
    return Object.freeze({ record, state: "terminal", transitionId });
}

function inProgressInspection(
    phase: "intent-recorded" | "normal-runtime-starting" | "services-stopped"
): Extract<DeliveryProductionOperationInspection, { state: "in-progress" }> {
    const terminal = terminalInspection();
    const record = parseDeliveryProductionOperationRecord({
        capsule: terminal.record.capsule,
        phase,
        updatedAtMs: 1500,
    });
    if (record.phase === "terminal") throw new Error("Expected in-progress fixture");
    return Object.freeze({
        record,
        state: "in-progress",
        transitionId,
    });
}

function control(
    inspection: DeliveryProductionOperationInspection,
    cleared: string[]
): ProductionDeliveryControlPort {
    return Object.freeze({
        clear(observedTransitionId: string) {
            cleared.push(observedTransitionId);
            return inspection.state === "terminal"
                ? Promise.resolve(inspection.record)
                : Promise.reject(new Error("not terminal"));
        },
        inspect() {
            return Promise.resolve(inspection);
        },
        inspectActive() {
            return Promise.resolve(inspection);
        },
        prepare() {
            return Promise.reject(new Error("not used"));
        },
    });
}

async function insertStaleTerminalRun(
    repository: ReturnType<typeof createJobRepository>,
    inspection: ReturnType<typeof terminalInspection>,
    state: "cancelled" | "failed" | "succeeded" | "timed-out",
    attemptLimit = 3
): Promise<void> {
    const { capsule } = inspection.record;
    const { enqueue } = capsule;
    const queuedAt = new Date(enqueue.queuedAtMs);
    const finishedAt = new Date(2500);
    const workerId = "019fd974-54a2-74dd-a64b-d4186f8d8830";
    const leaseToken = "019fd974-54a2-74dd-a64b-d4186f8d8831";
    const sideEffects = createJobMutationSideEffects({
        action: "delivery.operation.enqueue",
        actor: enqueue.actor,
        auditId: enqueue.audit.eventId,
        occurredAt: queuedAt,
        outcome: "accepted",
        realtime: { id: capsule.runId, kind: "run", operation: "created" },
        requestId: enqueue.audit.requestId,
        targetId: capsule.runId,
        targetType: "job-run",
    });
    const inserted = await repository.enqueueManualRun({
        ...sideEffects,
        queuedEvent: {
            attempt: 0,
            jobRunId: capsule.runId,
            kind: "queued",
            message: null,
            occurredAt: queuedAt,
            progressJson: null,
            sequence: 1,
            workerInstanceId: null,
        },
        run: {
            actionKey: enqueue.actionKey,
            attemptLimit,
            availableAt: queuedAt,
            cancellationPolicy: state === "cancelled" ? "cooperative" : "never",
            cancelRequestedAt: null,
            cancelRequestedById: null,
            cancelRequestedByKind: null,
            displayName: "Delivery production operation",
            enqueueSha256: enqueue.enqueueSha256,
            finishedAt: null,
            firstStartedAt: null,
            heartbeatAt: null,
            id: capsule.runId,
            idempotencyKey: enqueue.idempotencyKey,
            lastAttemptStartedAt: null,
            leaseExpiresAt: null,
            leaseOwnerId: null,
            leaseToken: null,
            payloadJson: serializeDeliveryProductionPayload(enqueue.payload),
            priority: 50,
            queuedAt,
            requestedById: enqueue.actor.id,
            requestedByKind: enqueue.actor.kind,
            requiredWorkerReleaseId: null,
            resourceClass: "exclusive",
            resourceKeysJson:
                '["database","delivery.mutation","delivery.production","github.repository","host.mutation"]',
            resultJson: null,
            retrySafe: true,
            scheduledForAt: null,
            scheduledJobId: null,
            scheduledJobVersion: null,
            state: "queued",
            terminalCode: null,
            terminalMessage: null,
            timeoutMs: 90 * 60_000,
            triggerType: "manual",
            updatedAt: queuedAt,
        },
    });
    expect(inserted).toMatchObject({ kind: "inserted", run: { state: "queued" } });
    await repository.registerWorker({
        ...noSideEffects,
        worker: {
            actionKeysJson: '["delivery.production.v1"]',
            capacity: 1,
            drainingAt: null,
            heartbeatAt: new Date(1500),
            id: workerId,
            pid: 1234,
            releaseId: "e".repeat(40),
            startedAt: new Date(1500),
            state: "online",
            stoppedAt: null,
        },
    });
    const claim = await repository.claimNextRun({
        at: new Date(1500),
        bootIdentity: "00000000-0000-0000-0000-000000000001",
        leaseExpiresAt: new Date(3000),
        leaseToken,
        minimumHeartbeatAt: queuedAt,
        sideEffectsForClaim: () => noSideEffects,
        workerId,
    });
    expect(claim).toMatchObject({ kind: "claimed", run: { state: "running" } });
    if (state === "cancelled") {
        const requested = await repository.cancelRun({
            actor: { id: enqueue.actor.id, kind: enqueue.actor.kind },
            at: new Date(2000),
            id: capsule.runId,
            sideEffectsForRun: () => noSideEffects,
            terminalCode: "delivery/recovery-test-cancelled",
            terminalMessage: "Stale cancelled Delivery recovery test state.",
        });
        expect(requested).toMatchObject({ kind: "requested" });
    }
    const outcome = (() => {
        if (state === "succeeded") {
            return { kind: "succeeded" as const, resultJson: '{"outcome":"succeeded"}' };
        }
        if (state === "cancelled") {
            return {
                kind: "cancelled" as const,
                terminalCode: "delivery/recovery-test-cancelled",
                terminalMessage: "Stale cancelled Delivery recovery test state.",
            };
        }
        if (state === "failed") {
            return {
                kind: "failed" as const,
                terminalCode: "delivery/recovery-test-failed",
                terminalMessage: "Stale failed Delivery recovery test state.",
            };
        }
        return {
            kind: "timed-out" as const,
            terminalCode: "delivery/recovery-test-timed-out",
            terminalMessage: "Stale timed-out Delivery recovery test state.",
        };
    })();
    const settled = await repository.settleClaim({
        at: finishedAt,
        leaseToken,
        outcome,
        runId: capsule.runId,
        sideEffectsForRun: () => noSideEffects,
        workerId,
    });
    expect(settled).toMatchObject({ kind: "settled", run: { state } });
}

describe("Delivery production startup recovery", () => {
    for (const phase of ["intent-recorded", "services-stopped"] as const) {
        test(`resumes an orphaned exact executor from ${phase} without clearing the fence`, async () => {
            const inspection = inProgressInspection(phase);
            const ensured: unknown[] = [];

            const recovered = await reconcileDeliveryProductionCutoverBeforeValidation({
                ensure(options) {
                    ensured.push(options);
                    return Promise.resolve("launched");
                },
                projectRoot: "/srv/mira-dashboard",
                readActive: () => Promise.resolve(inspection.record),
                readinessUrl: "http://127.0.0.1:3100/api/health/ready",
            });

            expect(recovered).toEqual(inspection);
            expect(ensured).toEqual([
                {
                    executorReleaseId: inspection.record.capsule.executor.releaseId,
                    projectRoot: "/srv/mira-dashboard",
                    readinessUrl: "http://127.0.0.1:3100/api/health/ready",
                    runtimeRevision: inspection.record.capsule.executor.runtimeRevision,
                    transitionId,
                },
            ]);
        });
    }

    test("skips the immutable executor when no cutover record exists", async () => {
        const inspection = terminalInspection();
        let inspected = 0;
        const baseControl = control(inspection, []);
        const recovery = createDeliveryProductionRecovery({
            control: {
                ...baseControl,
                inspectActive() {
                    inspected += 1;
                    return baseControl.inspectActive();
                },
            },
            readActive: () => Promise.resolve(null),
            repository: {
                enqueueManualRun() {
                    throw new Error("must not enqueue without an active cutover");
                },
                findEnqueueAuditProvenance() {
                    return;
                },
                findRun() {
                    return;
                },
                findRunByIdempotency() {
                    return;
                },
                recoverExpiredClaims() {
                    throw new Error("must not recover without an active cutover");
                },
                recoverDeliveryProductionTerminalRun() {
                    throw new Error("must not recover without an active cutover");
                },
            },
        });

        await recovery.reconcileBeforeClaims();

        expect(inspected).toBe(0);
    });

    test("rehydrates an exact rollback Job and audit before clearing the terminal fence", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const inspection = terminalInspection();
        const cleared: string[] = [];
        let wakes = 0;
        try {
            const recovery = createDeliveryProductionRecovery({
                control: control(inspection, cleared),
                readActive: () => Promise.resolve(inspection.record),
                repository,
                wake() {
                    wakes += 1;
                },
            });

            await recovery.reconcileBeforeClaims();

            const run = repository.findRun(transitionId);
            expect(run).toMatchObject({
                actionKey: "delivery.production.v1",
                id: transitionId,
                requiredWorkerReleaseId: null,
                state: "queued",
            });
            expect(repository.findEnqueueAuditProvenance(transitionId)).toMatchObject({
                auditEventId: inspection.record.capsule.enqueue.audit.eventId,
                actorId: inspection.record.capsule.enqueue.actor.id,
                requestId: inspection.record.capsule.enqueue.audit.requestId,
            });
            expect(cleared).toEqual([transitionId]);
            expect(wakes).toBe(1);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("accepts only an exact replay", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const inspection = terminalInspection();
        const cleared: string[] = [];
        try {
            const recovery = createDeliveryProductionRecovery({
                control: control(inspection, cleared),
                readActive: () => Promise.resolve(inspection.record),
                repository,
            });
            await recovery.reconcileBeforeClaims();
            await recovery.reconcileBeforeClaims();
            expect(cleared).toEqual([transitionId, transitionId]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("waits for the final normal-runtime receipt before rehydrating or claiming", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const inProgress = inProgressInspection("normal-runtime-starting");
        const terminal = terminalInspection();
        const cleared: string[] = [];
        let inspections = 0;
        try {
            const baseControl = control(terminal, cleared);
            const recovery = createDeliveryProductionRecovery({
                control: {
                    ...baseControl,
                    inspectActive() {
                        inspections += 1;
                        return Promise.resolve(inspections === 1 ? inProgress : terminal);
                    },
                },
                readActive: () => Promise.resolve(inProgress.record),
                repository,
            });

            await recovery.reconcileBeforeClaims();

            expect(inspections).toBe(2);
            expect(repository.findRun(transitionId)).toMatchObject({
                id: transitionId,
                state: "queued",
            });
            expect(cleared).toEqual([transitionId]);
        } finally {
            database.sqlite.close(true);
        }
    });

    for (const terminalState of ["cancelled", "failed", "timed-out"] as const) {
        test(`requeues an exact stale ${terminalState} Job before clearing its successful receipt`, async () => {
            const database = await openFreshMigratedDatabase();
            const repository = createJobRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission
            );
            const inspection = terminalInspection();
            try {
                await insertStaleTerminalRun(repository, inspection, terminalState);

                const cleared: string[] = [];
                const baseControl = control(inspection, cleared);
                await createDeliveryProductionRecovery({
                    control: {
                        ...baseControl,
                        clear(observedTransitionId) {
                            expect(repository.findRun(transitionId)).toMatchObject({
                                cancelRequestedAt: null,
                                finishedAt: null,
                                resultJson: null,
                                state: "queued",
                                terminalCode: null,
                                terminalMessage: null,
                            });
                            return baseControl.clear(observedTransitionId);
                        },
                    },
                    now: () => new Date(4000),
                    readActive: () => Promise.resolve(inspection.record),
                    repository,
                }).reconcileBeforeClaims();

                expect(cleared).toEqual([transitionId]);
                expect(
                    repository.listRunEvents({ limit: 20, runId: transitionId })[0]
                ).toMatchObject({ kind: "retry-scheduled" });
            } finally {
                database.sqlite.close(true);
            }
        });
    }

    test("extends an exact exhausted terminal retry budget only for receipt settlement", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const inspection = terminalInspection();
        const cleared: string[] = [];
        try {
            await insertStaleTerminalRun(repository, inspection, "failed", 1);

            await createDeliveryProductionRecovery({
                control: control(inspection, cleared),
                now: () => new Date(4000),
                readActive: () => Promise.resolve(inspection.record),
                repository,
            }).reconcileBeforeClaims();

            expect(repository.findRun(transitionId)).toMatchObject({
                attemptCount: 1,
                attemptLimit: 2,
                state: "queued",
            });
            expect(cleared).toEqual([transitionId]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("keeps an exact succeeded Job terminal while clearing its receipt", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const inspection = terminalInspection();
        const cleared: string[] = [];
        try {
            await insertStaleTerminalRun(repository, inspection, "succeeded");

            await createDeliveryProductionRecovery({
                control: control(inspection, cleared),
                readActive: () => Promise.resolve(inspection.record),
                repository,
            }).reconcileBeforeClaims();

            expect(repository.findRun(transitionId)).toMatchObject({
                resultJson: '{"outcome":"succeeded"}',
                state: "succeeded",
            });
            expect(cleared).toEqual([transitionId]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("fails closed when the trusted terminal run or enqueue audit snapshot drifts", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const inspection = terminalInspection();
        try {
            await insertStaleTerminalRun(repository, inspection, "failed");
            const run = repository.findRun(transitionId);
            const audit = repository.findEnqueueAuditProvenance(transitionId);
            if (run === undefined || audit === undefined) {
                throw new Error("Expected stale terminal recovery fixtures");
            }

            expect(
                await repository.recoverDeliveryProductionTerminalRun({
                    at: new Date(4000),
                    expectedAudit: audit,
                    expectedRun: { ...run, stateVersion: run.stateVersion + 1 },
                    sideEffectsForRun: () => noSideEffects,
                })
            ).toEqual({ kind: "state-changed" });
            expect(
                await repository.recoverDeliveryProductionTerminalRun({
                    at: new Date(4000),
                    expectedAudit: { ...audit, requestId: "request-drifted" },
                    expectedRun: run,
                    sideEffectsForRun: () => noSideEffects,
                })
            ).toEqual({ kind: "state-changed" });
            expect(repository.findRun(transitionId)?.state).toBe("failed");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("recovers an exact expired force-killed production claim before clearing", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const inspection = terminalInspection();
        const workerId = "019fd974-54a2-74dd-a64b-d4186f8d8830";
        const cleared: string[] = [];
        try {
            await createDeliveryProductionRecovery({
                control: control(inspection, cleared),
                readActive: () => Promise.resolve(inspection.record),
                repository,
            }).reconcileBeforeClaims();
            await repository.registerWorker({
                ...noSideEffects,
                worker: {
                    actionKeysJson: '["delivery.production.v1"]',
                    capacity: 1,
                    drainingAt: null,
                    heartbeatAt: new Date(2000),
                    id: workerId,
                    pid: 1234,
                    releaseId: "e".repeat(40),
                    startedAt: new Date(2000),
                    state: "online",
                    stoppedAt: null,
                },
            });
            const claim = await repository.claimNextRun({
                at: new Date(2000),
                bootIdentity: "00000000-0000-0000-0000-000000000001",
                leaseExpiresAt: new Date(3000),
                leaseToken: "019fd974-54a2-74dd-a64b-d4186f8d8831",
                minimumHeartbeatAt: new Date(1000),
                sideEffectsForClaim: () => noSideEffects,
                workerId,
            });
            expect(claim).toMatchObject({
                kind: "claimed",
                run: { id: transitionId, state: "running" },
            });

            await createDeliveryProductionRecovery({
                control: control(inspection, cleared),
                now: () => new Date(4000),
                readActive: () => Promise.resolve(inspection.record),
                repository,
            }).reconcileBeforeClaims();

            expect(repository.findRun(transitionId)).toMatchObject({
                leaseOwnerId: null,
                leaseToken: null,
                state: "queued",
            });
            expect(cleared).toEqual([transitionId, transitionId]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("fails closed before clearing when a restored idempotency identity collides", () => {
        const inspection = terminalInspection();
        const rejected = createDeliveryProductionRecovery({
            control: control(inspection, []),
            readActive: () => Promise.resolve(inspection.record),
            repository: {
                enqueueManualRun() {
                    throw new Error("must not enqueue a collision");
                },
                findEnqueueAuditProvenance() {
                    return;
                },
                findRun() {
                    return;
                },
                findRunByIdempotency() {
                    return { id: "collision" } as never;
                },
                recoverExpiredClaims() {
                    throw new Error("must not recover a collision");
                },
                recoverDeliveryProductionTerminalRun() {
                    throw new Error("must not recover a collision");
                },
            },
        }).reconcileBeforeClaims();

        expect(rejected).rejects.toBeInstanceOf(DeliveryProductionRecoveryError);
    });
});
