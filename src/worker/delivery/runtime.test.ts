import { describe, expect, test } from "bun:test";

import type { DeliveryReleases } from "../../contracts/delivery.ts";
import type {
    DeliveryDashboardMainGitSyncPort,
    DeliveryGitHubPullRequest,
    DeliveryGitHubPullRequestMutationPort,
    DeliveryGitHubPullRequestReadPort,
} from "../../contracts/deliveryGithub.ts";
import { publishedReleaseAuthority } from "../../testSupport/publishedReleaseAuthority.ts";
import type { DeliveryOverviewCollector } from "./overviewCollector.ts";
import { projectDeliveryOperationAuthority } from "./overviewProjection.ts";
import {
    createDeliveryRuntime,
    DeliveryRuntimeError,
    type DeliveryPreviewExecutionPort,
} from "./runtime.ts";

const nowMs = Date.parse("2026-08-13T12:00:00.000Z");
const mainHead = "e".repeat(40);
const productionRunIdentity = Object.freeze({
    actionKey: "delivery.production.v1",
    enqueueAuditEventId: "018f6f50-6a9e-7000-8000-000000000002",
    enqueueAuthenticatorId: "018f6f50-6a9e-7000-8000-000000000003",
    enqueueRequestId: "request-1",
    enqueueSha256: "a".repeat(64),
    idempotencyKey: "A".repeat(43),
    payloadSha256: "b".repeat(64),
    queuedAtMs: nowMs,
    requestedById: "018f6f50-6a9e-7000-8000-000000000004",
    requestedByKind: "user" as const,
    runId: "018f6f50-6a9e-7000-8000-000000000005",
});

function pullRequest(
    number: number,
    overrides: Partial<DeliveryGitHubPullRequest> = {}
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
        headRefName: `mira/branch-${number}`,
        headSha: number.toString(16).padStart(40, "0"),
        isCrossRepository: false,
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        number,
        reviews: [
            {
                authorLogin: "rajohan",
                state: "APPROVED",
                submittedAt: "2026-08-13T11:00:00.000Z",
            },
        ],
        state: "OPEN",
        title: `PR ${number}`,
        updatedAt: "2026-08-13T11:30:00.000Z",
        url: `https://github.com/rajohan/Mira-Dashboard/pull/${number}`,
        ...overrides,
    };
}

function releases(candidateReleaseId = mainHead): DeliveryReleases {
    return {
        activationRevision: "a".repeat(64),
        candidate: publishedReleaseAuthority(candidateReleaseId),
        current: {
            builtAtMs: nowMs - 10_000,
            commitTitle: "Current",
            commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${"a".repeat(40)}`,
            releaseId: "a".repeat(40),
            runtimeRevision: "b".repeat(40),
            schemaTarget: 1,
        },
        previous: {
            builtAtMs: nowMs - 20_000,
            commitTitle: "Previous",
            commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${"c".repeat(40)}`,
            releaseId: "c".repeat(40),
            runtimeRevision: "d".repeat(40),
            schemaTarget: 1,
        },
        rollback: {
            actor: "mira",
            available: true,
            target: {
                databaseSnapshotTransitionId: "01917d36-2e64-7c89-9abc-1234567890ab",
                releaseId: "c".repeat(40),
                runtimeRevision: "d".repeat(40),
            },
        },
    };
}

function overview(
    pullRequests: readonly DeliveryGitHubPullRequest[],
    remoteHead = mainHead
) {
    return projectDeliveryOperationAuthority({
        checkoutInspection: { headSha: mainHead, safe: true },
        mainHeadSha: remoteHead,
        observedAtMs: nowMs,
        previewStatus: { status: "stopped", updatedAtMs: nowMs },
        production: { actionActive: false, releases: releases(remoteHead) },
        pullRequests,
        reviewer: { state: "available" },
        supportsNativeStacks: true,
    });
}

function collector(current: ReturnType<typeof overview>): DeliveryOverviewCollector {
    return {
        collectForOperation: () => Promise.resolve(current),
        collectSections: () => Promise.resolve([]),
    };
}

function github(
    overrides: {
        getPullRequest?: DeliveryGitHubPullRequestReadPort["getPullRequest"];
        mergeNativeStack?: DeliveryGitHubPullRequestMutationPort["mergeNativeStack"];
        mergePullRequest?: DeliveryGitHubPullRequestMutationPort["mergePullRequest"];
        readMainRef?: DeliveryGitHubPullRequestReadPort["readMainRef"];
    } = {}
): DeliveryGitHubPullRequestReadPort & DeliveryGitHubPullRequestMutationPort {
    return {
        createNativeStack: () => Promise.reject(new Error("unused")),
        findNativeStack: () => Promise.resolve(undefined),
        getPullRequest:
            overrides.getPullRequest ?? (() => Promise.reject(new Error("unused"))),
        listOpenPullRequests: () => Promise.resolve([]),
        mergeNativeStack:
            overrides.mergeNativeStack ?? (() => Promise.reject(new Error("unused"))),
        mergePullRequest:
            overrides.mergePullRequest ?? (() => Promise.reject(new Error("unused"))),
        readMainRef: overrides.readMainRef ?? (() => Promise.resolve(mainHead)),
        rejectPullRequest: () => Promise.reject(new Error("unused")),
        supportsNativeStacks: () => Promise.resolve(true),
        updatePullRequestBranch: () => Promise.reject(new Error("unused")),
    };
}

function preview(overrides: Partial<DeliveryPreviewExecutionPort> = {}) {
    return {
        start: () => Promise.resolve({}),
        status: () => Promise.resolve({ status: "stopped" as const, updatedAtMs: nowMs }),
        stop: () => Promise.resolve({}),
        ...overrides,
    } satisfies DeliveryPreviewExecutionPort;
}

function mainGit(
    sync: DeliveryDashboardMainGitSyncPort["syncMainToExactRef"] = () =>
        Promise.resolve({ headSha: mainHead, outcome: "completed" })
): DeliveryDashboardMainGitSyncPort {
    return {
        inspect: () => Promise.resolve({ headSha: mainHead, safe: true }),
        syncMainToExactRef: sync,
    };
}

describe("Delivery worker runtime", () => {
    test("rejects source drift before an external mutation", async () => {
        let mutations = 0;
        const current = overview([pullRequest(1, { mergeStateStatus: "BEHIND" })]);
        const runtime = createDeliveryRuntime({
            collector: collector(current),
            github: {
                ...github(),
                updatePullRequestBranch: () => {
                    mutations += 1;
                    return Promise.resolve({ outcome: "completed" });
                },
            },
            mainGit: mainGit(),
            preview: preview(),
            readPrevious: () => current,
        });

        const failure = await runtime
            .execute({
                expectedHeadSha: "1".padStart(40, "0"),
                number: 1,
                operation: "update-branch",
                sourceRevision: "f".repeat(64),
            })
            .then(
                () => null,
                (error: unknown) => error
            );
        expect(failure).toBeInstanceOf(DeliveryRuntimeError);
        expect(failure).toHaveProperty("reason", "conflict");
        expect(mutations).toBe(0);
    });

    test("merges an exact ordinary PR, syncs main, and cleans retained preview state", () => {
        const pr = pullRequest(1);
        const current = overview([pr]);
        const synchronized: string[] = [];
        const cleaned: number[] = [];
        const runtime = createDeliveryRuntime({
            collector: collector(current),
            github: github({
                mergePullRequest: () =>
                    Promise.resolve({
                        mainHeadSha: "f".repeat(40),
                        outcome: "completed",
                    }),
                readMainRef: () => Promise.resolve("f".repeat(40)),
            }),
            mainGit: mainGit((remote, local) => {
                synchronized.push(`${remote}:${local}`);
                return Promise.resolve({ headSha: remote, outcome: "completed" });
            }),
            newOperationId: () => "01917d36-2e64-7c89-9abc-1234567890ab",
            preview: preview({
                cleanupConfirmed: (input) => {
                    cleaned.push((input as { number: number }).number);
                    return Promise.resolve(true);
                },
            }),
            readPrevious: () => current,
        });

        expect(
            runtime.execute({
                checkoutRevision: current.checkout.revision,
                deploy: false,
                expectedHeads: [{ headSha: pr.headSha, number: pr.number }],
                mergeStack: false,
                number: pr.number,
                operation: "merge-pull-request",
                sourceRevision: current.sourceRevision,
            })
        ).resolves.toEqual({ operation: "merge-pull-request", outcome: "completed" });
        expect(synchronized).toEqual([`${"f".repeat(40)}:${mainHead}`]);
        expect(cleaned).toEqual([1]);
    });

    test("refuses an asynchronous native stack merge without a full-prefix head guard", async () => {
        const bottom = pullRequest(1, {
            stack: { baseRefName: "main", number: 80, position: 1, size: 2 },
        });
        const top = pullRequest(2, {
            baseRefName: bottom.headRefName,
            stack: { baseRefName: "main", number: 80, position: 2, size: 2 },
        });
        const current = overview([bottom, top]);
        let syncCalls = 0;
        let cleanupCalls = 0;
        let mergeCalls = 0;
        const runtime = createDeliveryRuntime({
            collector: collector(current),
            github: github({
                mergeNativeStack: () => {
                    mergeCalls += 1;
                    return Promise.resolve({ outcome: "enqueued" });
                },
            }),
            mainGit: mainGit(() => {
                syncCalls += 1;
                return Promise.resolve({ headSha: mainHead, outcome: "completed" });
            }),
            preview: preview({
                cleanupConfirmed: () => {
                    cleanupCalls += 1;
                    return Promise.resolve(true);
                },
            }),
            readPrevious: () => current,
        });

        const conflict = await runtime
            .execute({
                checkoutRevision: current.checkout.revision,
                deploy: false,
                expectedHeads: [{ headSha: top.headSha, number: top.number }],
                mergeStack: false,
                number: top.number,
                operation: "merge-pull-request",
                sourceRevision: current.sourceRevision,
            })
            .then(
                () => null,
                (error: unknown) => error
            );
        expect(conflict).toBeInstanceOf(DeliveryRuntimeError);
        expect(conflict).toHaveProperty("reason", "conflict");
        expect(mergeCalls).toBe(0);

        expect(
            runtime.execute({
                checkoutRevision: current.checkout.revision,
                deploy: false,
                expectedHeads: [
                    { headSha: bottom.headSha, number: bottom.number },
                    { headSha: top.headSha, number: top.number },
                ],
                mergeStack: true,
                number: top.number,
                operation: "merge-pull-request",
                sourceRevision: current.sourceRevision,
            })
        ).rejects.toMatchObject({ reason: "conflict" });
        expect({ cleanupCalls, mergeCalls, syncCalls }).toEqual({
            cleanupCalls: 0,
            mergeCalls: 0,
            syncCalls: 0,
        });
    });

    test("refuses native merge authority even for one remaining open stack layer", () => {
        const remaining = pullRequest(2, {
            stack: { baseRefName: "main", number: 80, position: 2, size: 2 },
        });
        const current = overview([remaining]);
        let mergeCalls = 0;
        const runtime = createDeliveryRuntime({
            collector: collector(current),
            github: github({
                mergeNativeStack: () => {
                    mergeCalls += 1;
                    return Promise.resolve({ outcome: "enqueued" });
                },
            }),
            mainGit: mainGit(),
            preview: preview(),
            readPrevious: () => current,
        });
        const input = {
            checkoutRevision: current.checkout.revision,
            deploy: false as const,
            expectedHeads: [{ headSha: remaining.headSha, number: remaining.number }],
            mergeStack: true,
            number: remaining.number,
            operation: "merge-pull-request" as const,
            sourceRevision: current.sourceRevision,
        };

        expect(runtime.execute(input)).rejects.toMatchObject({ reason: "conflict" });
        expect(runtime.execute({ ...input, mergeStack: false })).rejects.toMatchObject({
            reason: "conflict",
        });
        expect(mergeCalls).toBe(0);
    });

    test("starts preview with the exact authorized scope and fails closed without production authority", async () => {
        const pr = pullRequest(1);
        const current = overview([pr]);
        const starts: unknown[] = [];
        const runtime = createDeliveryRuntime({
            collector: collector(current),
            github: github(),
            mainGit: mainGit(),
            newOperationId: () => "01917d36-2e64-7c89-9abc-1234567890ab",
            preview: preview({
                start: (input) => {
                    starts.push(input);
                    return Promise.resolve({});
                },
            }),
            readPrevious: () => current,
        });

        expect(
            runtime.execute({
                expectedHeads: [{ headSha: pr.headSha, number: pr.number }],
                number: pr.number,
                operation: "start-preview",
                previewRevision: current.preview.revision,
                sourceRevision: current.sourceRevision,
            })
        ).resolves.toEqual({ operation: "start-preview", outcome: "completed" });
        expect(starts).toEqual([
            {
                expectedHeads: [{ headSha: pr.headSha, number: pr.number }],
                number: 1,
                operationId: "01917d36-2e64-7c89-9abc-1234567890ab",
                previewRevision: current.preview.revision,
                title: "PR 1",
            },
        ]);

        const failure = await runtime
            .execute({
                activationRevision: current.releases.activationRevision,
                checkoutRevision: current.checkout.revision,
                expectedMainHeadSha: current.checkout.remoteHeadSha,
                operation: "deploy",
                release: current.releases.candidate!,
                sourceRevision: current.sourceRevision,
            })
            .then(
                () => null,
                (error: unknown) => error
            );
        expect(failure).toBeInstanceOf(DeliveryRuntimeError);
        expect(failure).toHaveProperty("reason", "production-unavailable");
    });

    test("authorizes deploy against remote main without requiring local main to be current", async () => {
        const remoteHead = "f".repeat(40);
        const current = overview([], remoteHead);
        let executions = 0;
        const runtime = createDeliveryRuntime({
            collector: collector(current),
            github: github(),
            mainGit: mainGit(),
            preview: preview(),
            production: {
                execute: (payload) => {
                    executions += 1;
                    return Promise.resolve({
                        operation: payload.operation,
                        outcome: "completed",
                    });
                },
            },
            readPrevious: () => current,
        });
        const base = {
            activationRevision: current.releases.activationRevision,
            checkoutRevision: current.checkout.revision,
            operation: "deploy" as const,
            release: current.releases.candidate!,
            sourceRevision: current.sourceRevision,
        };

        const conflict = await runtime
            .execute(
                { ...base, expectedMainHeadSha: current.checkout.headSha },
                undefined,
                productionRunIdentity
            )
            .then(
                () => null,
                (error: unknown) => error
            );
        expect(conflict).toBeInstanceOf(DeliveryRuntimeError);
        expect(conflict).toHaveProperty("reason", "conflict");
        expect(executions).toBe(0);

        expect(
            runtime.execute(
                { ...base, expectedMainHeadSha: remoteHead },
                undefined,
                productionRunIdentity
            )
        ).resolves.toEqual({ operation: "deploy", outcome: "completed" });
        expect(executions).toBe(1);
    });

    test("settles an exact mixed native merge scope as unknown without retrying merge or deploy", () => {
        const first = pullRequest(1, { state: "MERGED" });
        const second = pullRequest(2, { state: "OPEN" });
        const current = overview([first, second]);
        let productionExecutions = 0;
        const runtime = createDeliveryRuntime({
            collector: collector(current),
            github: github({
                getPullRequest: (number) =>
                    Promise.resolve(number === first.number ? first : second),
            }),
            mainGit: mainGit(),
            preview: preview(),
            production: {
                execute: () => {
                    productionExecutions += 1;
                    return Promise.reject(new Error("must not execute"));
                },
            },
            readPrevious: () => current,
        });

        expect(
            runtime.execute(
                {
                    activationRevision: current.releases.activationRevision,
                    checkoutRevision: current.checkout.revision,
                    deploy: true,
                    expectedHeads: [
                        { headSha: first.headSha, number: first.number },
                        { headSha: second.headSha, number: second.number },
                    ],
                    mergeStack: true,
                    number: second.number,
                    operation: "merge-pull-request",
                    sourceRevision: "f".repeat(64),
                },
                undefined,
                productionRunIdentity
            )
        ).resolves.toEqual({
            operation: "merge-pull-request",
            outcome: "unknown-outcome",
        });
        expect(productionExecutions).toBe(0);
    });
});
