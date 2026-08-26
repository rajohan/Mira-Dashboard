import { describe, expect, test } from "bun:test";

import type { DeliveryProductionJobPayload } from "../../contracts/deliveryWorker.ts";
import type { JobExecutionRunIdentity } from "../../contracts/jobModel.ts";
import {
    parseDeliveryProductionOperationCapsule,
    parseDeliveryProductionOperationRecord,
    type DeliveryProductionOperationRecord,
} from "../../shared/deliveryProductionOperation.ts";
import { publishedReleaseAuthority } from "../../testSupport/publishedReleaseAuthority.ts";
import { projectDeliveryOperationAuthority } from "./overviewProjection.ts";
import { createDeliveryProductionExecutionPort } from "./productionExecution.ts";

const nowMs = Date.parse("2026-08-13T12:00:00.000Z");
const mergedMainHead = "2".repeat(40);
const currentReleaseId = "4".repeat(40);
const currentRuntimeRevision = "5".repeat(40);
const candidateRuntimeRevision = "c".repeat(40);
const previousReleaseId = "6".repeat(40);
const previousRuntimeRevision = "7".repeat(40);
const activationRevision = "8".repeat(64);
const sourceRevision = "9".repeat(64);
const checkoutRevision = "a".repeat(64);
const runId = "01917d36-2e64-7c89-9abc-1234567890ab";

function sha256(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function identity(input: DeliveryProductionJobPayload): JobExecutionRunIdentity {
    return {
        actionKey: "delivery.production.v1",
        enqueueAuditEventId: "01917d36-2e64-7c89-9abc-1234567890ac",
        enqueueAuthenticatorId: "01917d36-2e64-7c89-9abc-1234567890ad",
        enqueueRequestId: "request-1",
        enqueueSha256: "b".repeat(64),
        idempotencyKey: "A".repeat(43),
        payloadSha256: sha256(JSON.stringify(input)),
        queuedAtMs: nowMs,
        requestedById: "01917d36-2e64-7c89-9abc-1234567890ae",
        requestedByKind: "user",
        runId,
    };
}

function currentAuthority(runtimeRevision = currentRuntimeRevision) {
    return projectDeliveryOperationAuthority({
        checkoutInspection: {
            branch: "main",
            condition: "ready",
            headSha: currentReleaseId,
            safe: true,
        },
        mainHeadSha: currentReleaseId,
        observedAtMs: nowMs,
        previewStatus: { status: "stopped", updatedAtMs: nowMs },
        production: {
            actionActive: false,
            releases: {
                activationRevision,
                candidate: publishedReleaseAuthority(
                    mergedMainHead,
                    "v1.2.3",
                    runtimeRevision
                ),
                current: {
                    builtAtMs: nowMs - 1000,
                    commitTitle: "Current",
                    commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${currentReleaseId}`,
                    releaseId: currentReleaseId,
                    runtimeRevision: currentRuntimeRevision,
                    schemaTarget: 1,
                },
                previous: {
                    builtAtMs: nowMs - 2000,
                    commitTitle: "Previous",
                    commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${previousReleaseId}`,
                    releaseId: previousReleaseId,
                    runtimeRevision: previousRuntimeRevision,
                    schemaTarget: 1,
                },
                rollback: {
                    actor: "mira",
                    available: true,
                    target: {
                        databaseSnapshotTransitionId:
                            "01917d36-2e64-7c89-9abc-1234567890af",
                        releaseId: previousReleaseId,
                        runtimeRevision: previousRuntimeRevision,
                    },
                },
            },
        },
        pullRequests: [],
        reviewer: { state: "available" },
        supportsNativeStacks: true,
    });
}

function terminalExecutionPort(
    record: Extract<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    cleared: string[]
) {
    return createDeliveryProductionExecutionPort({
        authority: {
            read: () => Promise.reject(new Error("unused")),
            readExact: () => Promise.reject(new Error("unused")),
            readForOperation: () => Promise.reject(new Error("unused")),
        },
        control: {
            clear(transitionId) {
                cleared.push(transitionId);
                return Promise.resolve(record);
            },
            inspect: () =>
                Promise.resolve({
                    record,
                    state: "terminal" as const,
                    transitionId: runId,
                }),
            inspectActive: () => Promise.reject(new Error("unused")),
            prepare: () => Promise.reject(new Error("unused")),
        },
        executorReleaseId: currentReleaseId,
        executorRuntimeRevision: currentRuntimeRevision,
        github: {
            createNativeStack: () => Promise.reject(new Error("unused")),
            findNativeStack: () => Promise.reject(new Error("unused")),
            getPullRequest: () => Promise.reject(new Error("unused")),
            listOpenPullRequests: () => Promise.reject(new Error("unused")),
            mergeNativeStack: () => Promise.reject(new Error("unused")),
            mergePullRequest: () => Promise.reject(new Error("unused")),
            readMainRef: () => Promise.reject(new Error("unused")),
            rejectPullRequest: () => Promise.reject(new Error("unused")),
            supportsNativeStacks: () => Promise.reject(new Error("unused")),
            updatePullRequestBranch: () => Promise.reject(new Error("unused")),
        },
        mainGit: {
            inspect: () => Promise.reject(new Error("unused")),
            syncMainToExactRef: () => Promise.reject(new Error("unused")),
        },
        projectRoot: "/srv/mira-dashboard",
        readinessUrl: "http://127.0.0.1/api/health/ready",
    });
}

describe("Delivery production execution", () => {
    test("clears an exact terminal marker before returning its durable result", async () => {
        const input: DeliveryProductionJobPayload = {
            activationRevision,
            checkoutRevision,
            expectedMainHeadSha: mergedMainHead,
            operation: "deploy",
            release: publishedReleaseAuthority(
                mergedMainHead,
                "v1.2.3",
                candidateRuntimeRevision
            ),
            sourceRevision,
        };
        const runIdentity = identity(input);
        const capsule = parseDeliveryProductionOperationCapsule({
            cas: {
                current: {
                    activationTransitionId: "01917d36-2e64-7c89-9abc-1234567890b0",
                    releaseId: currentReleaseId,
                    rollbackSnapshotTransitionId: runId,
                    runtimeRevision: currentRuntimeRevision,
                },
                target: {
                    databaseSnapshotTransitionId: null,
                    releaseId: mergedMainHead,
                    runtimeRevision: candidateRuntimeRevision,
                },
            },
            enqueue: {
                actionKey: runIdentity.actionKey,
                actor: {
                    authenticatorId: runIdentity.enqueueAuthenticatorId,
                    id: runIdentity.requestedById,
                    kind: "user",
                },
                audit: {
                    eventId: runIdentity.enqueueAuditEventId,
                    requestId: runIdentity.enqueueRequestId,
                },
                enqueueSha256: runIdentity.enqueueSha256,
                idempotencyKey: runIdentity.idempotencyKey,
                payload: input,
                payloadSha256: runIdentity.payloadSha256,
                queuedAtMs: runIdentity.queuedAtMs,
            },
            executor: {
                releaseId: currentReleaseId,
                runtimeRevision: currentRuntimeRevision,
            },
            protocol: "delivery.production.v3",
            runId,
            transitionId: runId,
        });
        const record = parseDeliveryProductionOperationRecord({
            capsule,
            phase: "terminal",
            result: {
                activation: {
                    current: {
                        releaseId: mergedMainHead,
                        runtimeRevision: candidateRuntimeRevision,
                    },
                    formatVersion: 1,
                    previous: {
                        databaseSnapshotTransitionId: runId,
                        releaseId: currentReleaseId,
                        runtimeRevision: currentRuntimeRevision,
                    },
                    transitionId: runId,
                },
                completedAtMs: nowMs + 1000,
                outcome: "succeeded",
            },
            updatedAtMs: nowMs + 1000,
        });
        if (record.phase !== "terminal") throw new Error("Expected terminal fixture");
        const cleared: string[] = [];
        const port = terminalExecutionPort(record, cleared);

        expect(
            await port.execute(
                input,
                {
                    ...currentAuthority(candidateRuntimeRevision),
                    releases: {
                        ...currentAuthority(candidateRuntimeRevision).releases,
                        candidate: undefined,
                    },
                },
                runIdentity
            )
        ).toEqual({
            operation: "deploy",
            outcome: "completed",
            releaseId: mergedMainHead,
        });
        expect(cleared).toEqual([runId]);
    });

    test("clears an exact failed terminal marker before surfacing the failure", async () => {
        const input: DeliveryProductionJobPayload = {
            activationRevision,
            checkoutRevision,
            expectedMainHeadSha: mergedMainHead,
            operation: "deploy",
            release: publishedReleaseAuthority(
                mergedMainHead,
                "v1.2.3",
                currentRuntimeRevision
            ),
            sourceRevision,
        };
        const runIdentity = identity(input);
        const capsule = parseDeliveryProductionOperationCapsule({
            cas: {
                current: {
                    activationTransitionId: "01917d36-2e64-7c89-9abc-1234567890b0",
                    releaseId: currentReleaseId,
                    rollbackSnapshotTransitionId: runId,
                    runtimeRevision: currentRuntimeRevision,
                },
                target: {
                    databaseSnapshotTransitionId: null,
                    releaseId: mergedMainHead,
                    runtimeRevision: currentRuntimeRevision,
                },
            },
            enqueue: {
                actionKey: runIdentity.actionKey,
                actor: {
                    authenticatorId: runIdentity.enqueueAuthenticatorId,
                    id: runIdentity.requestedById,
                    kind: "user",
                },
                audit: {
                    eventId: runIdentity.enqueueAuditEventId,
                    requestId: runIdentity.enqueueRequestId,
                },
                enqueueSha256: runIdentity.enqueueSha256,
                idempotencyKey: runIdentity.idempotencyKey,
                payload: input,
                payloadSha256: runIdentity.payloadSha256,
                queuedAtMs: runIdentity.queuedAtMs,
            },
            executor: {
                releaseId: currentReleaseId,
                runtimeRevision: currentRuntimeRevision,
            },
            protocol: "delivery.production.v3",
            runId,
            transitionId: runId,
        });
        const record = parseDeliveryProductionOperationRecord({
            capsule,
            phase: "terminal",
            result: {
                activation: null,
                completedAtMs: nowMs + 1000,
                outcome: "failed",
                reason: "activation-failed",
            },
            updatedAtMs: nowMs + 1000,
        });
        if (record.phase !== "terminal") throw new Error("Expected terminal fixture");
        const cleared: string[] = [];
        const port = terminalExecutionPort(record, cleared);

        const error = await port
            .execute(input, currentAuthority(), runIdentity)
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain("Delivery production execution failed");
        expect(cleared).toEqual([runId]);
    });
});
