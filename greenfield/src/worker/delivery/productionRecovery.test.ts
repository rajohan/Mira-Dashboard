import { describe, expect, test } from "bun:test";

import {
    createDeliveryProductionRecovery,
    DeliveryProductionRecoveryError,
} from "../../server/domains/jobs/deliveryProductionRecovery.ts";
import { createJobRepository } from "../../server/domains/jobs/repository.ts";
import { testImmediateDatabaseWriteAdmission } from "../../server/test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../server/test/support/freshDatabase.ts";
import {
    parseDeliveryProductionOperationCapsule,
    parseDeliveryProductionOperationRecord,
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
        protocol: "delivery.production.v1",
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
    phase: "intent-recorded" | "services-stopped"
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
                repository,
            });
            await recovery.reconcileBeforeClaims();
            await recovery.reconcileBeforeClaims();
            expect(cleared).toEqual([transitionId, transitionId]);
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
            },
        }).reconcileBeforeClaims();

        expect(rejected).rejects.toBeInstanceOf(DeliveryProductionRecoveryError);
    });
});
