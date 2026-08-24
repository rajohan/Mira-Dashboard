import { describe, expect, test } from "bun:test";

import type { DeliveryGitHubPullRequest } from "../../contracts/deliveryGithub.ts";
import type { DeliveryProductionJobPayload } from "../../contracts/deliveryWorker.ts";
import type { JobExecutionRunIdentity } from "../../contracts/jobModel.ts";
import {
    parseDeliveryProductionOperationCapsule,
    parseDeliveryProductionOperationRecord,
    type DeliveryProductionOperationRecord,
} from "../../shared/deliveryProductionOperation.ts";
import { projectDeliveryOperationAuthority } from "./overviewProjection.ts";
import { createDeliveryProductionExecutionPort } from "./productionExecution.ts";

const nowMs = Date.parse("2026-08-13T12:00:00.000Z");
const pullRequestHead = "1".repeat(40);
const mergedMainHead = "2".repeat(40);
const laterMainHead = "3".repeat(40);
const currentReleaseId = "4".repeat(40);
const currentRuntimeRevision = "5".repeat(40);
const previousReleaseId = "6".repeat(40);
const previousRuntimeRevision = "7".repeat(40);
const activationRevision = "8".repeat(64);
const sourceRevision = "9".repeat(64);
const checkoutRevision = "a".repeat(64);
const runId = "01917d36-2e64-7c89-9abc-1234567890ab";

function pullRequest(
    state: "MERGED" | "OPEN",
    mergeCommitSha?: string
): DeliveryGitHubPullRequest {
    return {
        additions: 1,
        authorLogin: "mira-2026",
        baseRefName: "main",
        body: "body",
        changedFiles: 1,
        checks: [
            {
                conclusion: "SUCCESS",
                identity: "check:Dashboard",
                status: "COMPLETED",
            },
        ],
        checksComplete: true,
        createdAt: "2026-08-13T10:00:00.000Z",
        deletions: 0,
        headRefName: "mira/delivery",
        headSha: pullRequestHead,
        isCrossRepository: false,
        isDraft: false,
        mergeable: "MERGEABLE",
        ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
        mergeStateStatus: "CLEAN",
        number: 42,
        reviews: [
            {
                authorLogin: "rajohan",
                state: "APPROVED",
                submittedAt: "2026-08-13T11:00:00.000Z",
            },
        ],
        state,
        title: "Delivery",
        updatedAt: "2026-08-13T11:30:00.000Z",
        url: "https://github.com/rajohan/Mira-Dashboard/pull/42",
    };
}

function payload(): DeliveryProductionJobPayload {
    return {
        activationRevision,
        checkoutRevision,
        deploy: true,
        expectedHeads: [{ headSha: pullRequestHead, number: 42 }],
        mergeStack: false,
        number: 42,
        operation: "merge-pull-request",
        sourceRevision,
    };
}

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

function currentAuthority() {
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
        pullRequests: [pullRequest("OPEN")],
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
            protocol: "delivery.production.v1",
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
                        runtimeRevision: currentRuntimeRevision,
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

        expect(await port.execute(input, currentAuthority(), runIdentity)).toEqual({
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
            protocol: "delivery.production.v1",
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

    test("does not deploy a later unrelated main commit after an exact merge", () => {
        const input = payload();
        let pullRequestReads = 0;
        let gitSyncCalls = 0;
        let launchCalls = 0;
        const port = createDeliveryProductionExecutionPort({
            authority: {
                read: () => Promise.reject(new Error("must not read authority")),
                readExact: () => Promise.reject(new Error("must not read authority")),
                readForOperation: () =>
                    Promise.reject(new Error("must not read authority")),
            },
            control: {
                clear: () => Promise.reject(new Error("unused")),
                inspect: () => Promise.resolve({ state: "missing", transitionId: runId }),
                inspectActive: () => Promise.resolve({ state: "missing" }),
                prepare: () => Promise.reject(new Error("must not prepare")),
            },
            executorReleaseId: currentReleaseId,
            executorRuntimeRevision: currentRuntimeRevision,
            github: {
                createNativeStack: () => Promise.reject(new Error("unused")),
                findNativeStack: () => Promise.resolve(undefined),
                getPullRequest: () => {
                    pullRequestReads += 1;
                    return Promise.resolve(
                        pullRequestReads === 1
                            ? pullRequest("OPEN")
                            : pullRequest("MERGED", mergedMainHead)
                    );
                },
                listOpenPullRequests: () => Promise.resolve([]),
                mergeNativeStack: () => Promise.reject(new Error("unused")),
                mergePullRequest: () =>
                    Promise.resolve({
                        mainHeadSha: mergedMainHead,
                        outcome: "completed",
                    }),
                readMainRef: () => Promise.resolve(laterMainHead),
                rejectPullRequest: () => Promise.reject(new Error("unused")),
                supportsNativeStacks: () => Promise.resolve(true),
                updatePullRequestBranch: () => Promise.reject(new Error("unused")),
            },
            launch: () => {
                launchCalls += 1;
                return Promise.resolve();
            },
            mainGit: {
                inspect: () => Promise.reject(new Error("must not inspect")),
                syncMainToExactRef: () => {
                    gitSyncCalls += 1;
                    return Promise.resolve({
                        headSha: laterMainHead,
                        outcome: "completed",
                    });
                },
            },
            projectRoot: "/srv/mira-dashboard",
            readinessUrl: "http://127.0.0.1/api/health/ready",
        });

        expect(port.execute(input, currentAuthority(), identity(input))).resolves.toEqual(
            {
                operation: "merge-pull-request",
                outcome: "completed-with-warnings",
                warnings: ["deployment-not-started", "main-sync-failed"],
            }
        );
        expect({ gitSyncCalls, launchCalls }).toEqual({
            gitSyncCalls: 0,
            launchCalls: 0,
        });
    });

    test("fails closed when an all-merged retry lacks an authoritative merge commit", () => {
        const input = payload();
        const port = createDeliveryProductionExecutionPort({
            authority: {
                read: () => Promise.reject(new Error("unused")),
                readExact: () => Promise.reject(new Error("unused")),
                readForOperation: () => Promise.reject(new Error("unused")),
            },
            control: {
                clear: () => Promise.reject(new Error("unused")),
                inspect: () => Promise.resolve({ state: "missing", transitionId: runId }),
                inspectActive: () => Promise.resolve({ state: "missing" }),
                prepare: () => Promise.reject(new Error("unused")),
            },
            executorReleaseId: currentReleaseId,
            executorRuntimeRevision: currentRuntimeRevision,
            github: {
                createNativeStack: () => Promise.reject(new Error("unused")),
                findNativeStack: () => Promise.resolve(undefined),
                getPullRequest: () => Promise.resolve(pullRequest("MERGED")),
                listOpenPullRequests: () => Promise.resolve([]),
                mergeNativeStack: () => Promise.reject(new Error("unused")),
                mergePullRequest: () => Promise.reject(new Error("unused")),
                readMainRef: () => Promise.reject(new Error("must not read main")),
                rejectPullRequest: () => Promise.reject(new Error("unused")),
                supportsNativeStacks: () => Promise.resolve(true),
                updatePullRequestBranch: () => Promise.reject(new Error("unused")),
            },
            mainGit: {
                inspect: () => Promise.reject(new Error("unused")),
                syncMainToExactRef: () => Promise.reject(new Error("unused")),
            },
            projectRoot: "/srv/mira-dashboard",
            readinessUrl: "http://127.0.0.1/api/health/ready",
        });

        expect(port.execute(input, currentAuthority(), identity(input))).resolves.toEqual(
            {
                operation: "merge-pull-request",
                outcome: "unknown-outcome",
            }
        );
    });

    test("recovers an all-merged retry only at the selected PR merge commit", async () => {
        const input = payload();
        const synchronized: Array<{ local?: string; remote: string }> = [];
        let mergeCalls = 0;
        const port = createDeliveryProductionExecutionPort({
            authority: {
                read: () => Promise.reject(new Error("unused")),
                readExact: () => Promise.reject(new Error("stop after exact sync")),
                readForOperation: () => Promise.reject(new Error("unused")),
            },
            control: {
                clear: () => Promise.reject(new Error("unused")),
                inspect: () => Promise.resolve({ state: "missing", transitionId: runId }),
                inspectActive: () => Promise.resolve({ state: "missing" }),
                prepare: () => Promise.reject(new Error("unused")),
            },
            executorReleaseId: currentReleaseId,
            executorRuntimeRevision: currentRuntimeRevision,
            github: {
                createNativeStack: () => Promise.reject(new Error("unused")),
                findNativeStack: () => Promise.resolve(undefined),
                getPullRequest: () =>
                    Promise.resolve(pullRequest("MERGED", mergedMainHead)),
                listOpenPullRequests: () => Promise.resolve([]),
                mergeNativeStack: () => {
                    mergeCalls += 1;
                    return Promise.reject(new Error("must not merge again"));
                },
                mergePullRequest: () => {
                    mergeCalls += 1;
                    return Promise.reject(new Error("must not merge again"));
                },
                readMainRef: () => Promise.resolve(mergedMainHead),
                rejectPullRequest: () => Promise.reject(new Error("unused")),
                supportsNativeStacks: () => Promise.resolve(true),
                updatePullRequestBranch: () => Promise.reject(new Error("unused")),
            },
            mainGit: {
                inspect: () => Promise.resolve({ headSha: currentReleaseId, safe: true }),
                syncMainToExactRef: (remote, local) => {
                    synchronized.push({
                        ...(local === undefined ? {} : { local }),
                        remote,
                    });
                    return Promise.resolve({ headSha: remote, outcome: "completed" });
                },
            },
            projectRoot: "/srv/mira-dashboard",
            readinessUrl: "http://127.0.0.1/api/health/ready",
        });

        const error = await port
            .execute(input, currentAuthority(), identity(input))
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain("stop after exact sync");
        expect(mergeCalls).toBe(0);
        expect(synchronized).toEqual([
            { local: currentReleaseId, remote: mergedMainHead },
        ]);
    });
});
