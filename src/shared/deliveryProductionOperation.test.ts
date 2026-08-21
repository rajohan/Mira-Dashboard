import { describe, expect, test } from "bun:test";

import {
    deliveryProductionOperationPhases,
    parseDeliveryProductionOperationCapsule,
    parseDeliveryProductionOperationRecord,
    retainedDeliveryProductionReceiptIds,
    serializeDeliveryProductionOperationCapsule,
    serializeDeliveryProductionOperationRecord,
    serializeDeliveryProductionPayload,
    type DeliveryProductionOperationCapsule,
} from "./deliveryProductionOperation.ts";

const transitionId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
const previousTransitionId = "019fd974-54a2-74dd-a64b-d4186f8d8827";

function operationPayload(
    operation: "deploy" | "merge-pull-request" | "rollback-release",
    targetReleaseId: string
): DeliveryProductionOperationCapsule["enqueue"]["payload"] {
    switch (operation) {
        case "rollback-release": {
            return {
                activationRevision: "1".repeat(64),
                operation,
                sourceRevision: "f".repeat(64),
                target: {
                    databaseSnapshotTransitionId: "019fd974-54a2-74dd-a64b-d4186f8d8826",
                    releaseId: targetReleaseId,
                    runtimeRevision: "d".repeat(40),
                },
            };
        }
        case "merge-pull-request": {
            return {
                activationRevision: "1".repeat(64),
                checkoutRevision: "2".repeat(64),
                deploy: true,
                expectedHeads: [{ headSha: "9".repeat(40), number: 7 }],
                mergeStack: false,
                number: 7,
                operation,
                sourceRevision: "f".repeat(64),
            };
        }
        case "deploy": {
            return {
                activationRevision: "1".repeat(64),
                checkoutRevision: "2".repeat(64),
                expectedMainHeadSha: targetReleaseId,
                operation,
                sourceRevision: "f".repeat(64),
            };
        }
    }
}

function capsule(
    operation: "deploy" | "merge-pull-request" | "rollback-release" = "deploy"
): DeliveryProductionOperationCapsule {
    const targetReleaseId = "c".repeat(40);
    const payload = operationPayload(operation, targetReleaseId);
    return {
        cas: {
            current: {
                activationTransitionId: previousTransitionId,
                releaseId: "a".repeat(40),
                rollbackSnapshotTransitionId: transitionId,
                runtimeRevision: "b".repeat(40),
            },
            target: {
                databaseSnapshotTransitionId:
                    operation === "rollback-release"
                        ? "019fd974-54a2-74dd-a64b-d4186f8d8826"
                        : null,
                releaseId: targetReleaseId,
                runtimeRevision: "d".repeat(40),
            },
        },
        enqueue: {
            actionKey: "delivery.production.v1",
            actor: {
                authenticatorId: "a".repeat(32),
                id: "019fd974-54a2-74dd-a64b-d4186f8d8825",
                kind: "user",
            },
            audit: {
                eventId: "019fd974-54a2-74dd-a64b-d4186f8d8824",
                requestId: "request-delivery-1",
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
    };
}

function targetActivation() {
    return {
        current: {
            releaseId: "c".repeat(40),
            runtimeRevision: "d".repeat(40),
        },
        formatVersion: 1 as const,
        previous: {
            databaseSnapshotTransitionId: transitionId,
            releaseId: "a".repeat(40),
            runtimeRevision: "b".repeat(40),
        },
        transitionId,
    };
}

describe("delivery production operation protocol", () => {
    test("canonically parses, freezes, and serializes the secret-free rehydration capsule", () => {
        const parsed = parseDeliveryProductionOperationCapsule(capsule());

        expect(parsed.protocol).toBe("delivery.production.v1");
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(Object.isFrozen(parsed.enqueue.actor)).toBe(true);
        expect(Object.isFrozen(parsed.enqueue.payload)).toBe(true);
        expect(serializeDeliveryProductionPayload(parsed.enqueue.payload)).toBe(
            JSON.stringify(parsed.enqueue.payload)
        );
        expect(JSON.parse(serializeDeliveryProductionOperationCapsule(parsed))).toEqual(
            parsed
        );
    });

    test("rejects identity, target-snapshot, hidden-field, and control-text drift", () => {
        expect(() =>
            parseDeliveryProductionOperationCapsule({
                ...capsule(),
                runId: "019fd974-54a2-74dd-a64b-d4186f8d8823",
            })
        ).toThrow("Delivery production operation is invalid");
        expect(() =>
            parseDeliveryProductionOperationCapsule({
                ...capsule(),
                cas: {
                    ...capsule().cas,
                    target: {
                        ...capsule().cas.target,
                        databaseSnapshotTransitionId:
                            "019fd974-54a2-74dd-a64b-d4186f8d8822",
                    },
                },
            })
        ).toThrow("Delivery production operation is invalid");
        expect(() =>
            parseDeliveryProductionOperationCapsule({
                ...capsule("rollback-release"),
                cas: {
                    ...capsule("rollback-release").cas,
                    target: {
                        ...capsule("rollback-release").cas.target,
                        databaseSnapshotTransitionId: null,
                    },
                },
            })
        ).toThrow("Delivery production operation is invalid");
        expect(() =>
            parseDeliveryProductionOperationCapsule({
                ...capsule(),
                token: "must-never-be-stored",
            })
        ).toThrow("Delivery production operation is invalid");
        expect(() =>
            parseDeliveryProductionOperationCapsule({
                ...capsule(),
                enqueue: {
                    ...capsule().enqueue,
                    actor: { ...capsule().enqueue.actor, id: "actor\nsecret" },
                },
            })
        ).toThrow("Delivery production operation is invalid");
    });

    test("requires terminal success to activate the exact target and pair the prior snapshot", () => {
        const terminal = parseDeliveryProductionOperationRecord({
            capsule: capsule(),
            phase: "terminal",
            result: {
                activation: targetActivation(),
                completedAtMs: 2000,
                outcome: "succeeded",
            },
            updatedAtMs: 2000,
        });

        expect(terminal.phase).toBe("terminal");
        if (terminal.phase !== "terminal") throw new Error("expected terminal");
        expect(Object.isFrozen(terminal)).toBe(true);
        expect(JSON.parse(serializeDeliveryProductionOperationRecord(terminal))).toEqual(
            terminal
        );
        expect(() =>
            parseDeliveryProductionOperationRecord({
                ...terminal,
                result: {
                    ...terminal.result,
                    activation: {
                        ...targetActivation(),
                        current: {
                            ...targetActivation().current,
                            releaseId: "9".repeat(40),
                        },
                    },
                },
            })
        ).toThrow("Delivery production operation is invalid");
    });

    test("keeps failure results categorical and bounds phase and retention vocabularies", () => {
        expect(
            parseDeliveryProductionOperationRecord({
                capsule: capsule("rollback-release"),
                phase: "terminal",
                result: {
                    activation: null,
                    completedAtMs: 2000,
                    outcome: "failed",
                    reason: "rollback-failed",
                },
                updatedAtMs: 2000,
            }).phase
        ).toBe("terminal");
        expect(() =>
            parseDeliveryProductionOperationRecord({
                capsule: capsule(),
                phase: "terminal",
                result: {
                    activation: null,
                    completedAtMs: 2000,
                    message: "raw upstream error",
                    outcome: "failed",
                    reason: "activation-failed",
                },
                updatedAtMs: 2000,
            })
        ).toThrow("Delivery production operation is invalid");
        expect(deliveryProductionOperationPhases).toHaveLength(9);
        expect(
            retainedDeliveryProductionReceiptIds({
                currentTransitionId: transitionId,
                inFlightTransitionId: transitionId,
                previousTransitionId,
            })
        ).toEqual([previousTransitionId, transitionId]);
    });
});
