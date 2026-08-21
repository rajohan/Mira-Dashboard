import { describe, expect, test } from "bun:test";

import type {
    DeliveryCheckout,
    DeliveryPreview,
    DeliveryPullRequest,
    DeliveryPullRequestActionCapability,
    DeliveryPullRequestGroup,
    DeliveryReleases,
} from "../../contracts/delivery.ts";
import {
    deployMainPrompt,
    deliveryOperationIsCurrent,
    pullRequestOperationPrompt,
    rollbackReleasePrompt,
    stopPreviewPrompt,
} from "./deliveryOperations.ts";

const sha = "a".repeat(40);
const secondSha = "b".repeat(40);
const sourceRevision = "c".repeat(64);
const resourceRevision = "d".repeat(64);
const secondResourceRevision = "e".repeat(64);

const pullRequest = {
    actions: [],
    additions: 5,
    author: "mira-2026",
    baseRef: "main",
    changedFiles: 2,
    checksState: "passed",
    createdAtMs: 1_800_000_000_000,
    deletions: 1,
    headRef: "feature",
    headSha: sha,
    isCrossRepository: false,
    isDraft: false,
    mergeState: "CLEAN",
    mergeability: "mergeable",
    number: 424,
    reviewState: "approved",
    title: "Delivery parity",
    updatedAtMs: 1_800_000_001_000,
    url: "https://github.com/rajohan/Mira-Dashboard/pull/424",
} as const satisfies DeliveryPullRequest;

const checkout = {
    branch: "main",
    condition: "ready",
    expectedBranch: "main",
    headSha: secondSha,
    remoteHeadSha: secondSha,
    revision: resourceRevision,
    safeForDeploy: true,
    upstream: "origin/main",
} as const satisfies DeliveryCheckout;

const preview = {
    controlsAvailable: true,
    headSha: sha,
    number: 424,
    revision: resourceRevision,
    startedAtMs: 1_800_000_000_000,
    status: "running",
    updatedAtMs: 1_800_000_001_000,
    url: "https://preview.example.test/",
} as const satisfies DeliveryPreview;

const releases = {
    activationRevision: secondResourceRevision,
    current: {
        builtAtMs: 1_800_000_000_000,
        commitTitle: "Current",
        commitUrl: "https://github.com/rajohan/Mira-Dashboard/commit/" + sha,
        releaseId: sha,
        runtimeRevision: sha,
        schemaTarget: 1,
    },
    previous: {
        builtAtMs: 1_799_000_000_000,
        commitTitle: "Previous",
        commitUrl: "https://github.com/rajohan/Mira-Dashboard/commit/" + secondSha,
        releaseId: secondSha,
        runtimeRevision: secondSha,
        schemaTarget: 1,
    },
    rollback: {
        actor: "mira",
        available: true,
        target: {
            databaseSnapshotTransitionId: "019fdf70-0000-7000-8000-000000000001",
            releaseId: secondSha,
            runtimeRevision: secondSha,
        },
    },
} as const satisfies DeliveryReleases;

function capability(
    action: DeliveryPullRequestActionCapability["action"],
    actor: DeliveryPullRequestActionCapability["actor"] = "mira"
): DeliveryPullRequestActionCapability {
    let scope: DeliveryPullRequestActionCapability["scope"] = "prefix";
    if (
        action === "approve-review" ||
        action === "reject" ||
        action === "update-branch"
    ) {
        scope = "self";
    }
    if (action === "create-stack") scope = "group";
    return {
        action,
        actor,
        available: true,
        scope,
    };
}

const standaloneGroup = {
    id: "1".repeat(64),
    kind: "standalone-mira",
    members: [pullRequest],
} as const satisfies DeliveryPullRequestGroup;

const stackBottom = {
    ...pullRequest,
    headRef: "stack-bottom",
    headSha: secondSha,
    number: 423,
    url: "https://github.com/rajohan/Mira-Dashboard/pull/423",
} as const satisfies DeliveryPullRequest;

const stackGroup = {
    id: "2".repeat(64),
    kind: "native-stack",
    members: [stackBottom, pullRequest],
} as const satisfies DeliveryPullRequestGroup;

describe("Delivery operation intents", () => {
    test("builds each remaining Mira prompt from the exact server-owned scope", () => {
        const cases = [
            {
                action: capability("create-stack"),
                expectedOperation: "create-pull-request-stack",
                group: stackGroup,
                pullRequest,
            },
            {
                action: capability("preview-start"),
                expectedOperation: "start-preview",
                group: standaloneGroup,
                preview,
                pullRequest,
            },
            {
                action: capability("reject"),
                expectedOperation: "reject-pull-request",
                group: standaloneGroup,
                pullRequest,
            },
            {
                action: capability("update-branch"),
                expectedOperation: "update-branch",
                group: standaloneGroup,
                pullRequest,
            },
        ] as const;

        for (const value of cases) {
            const prompt = pullRequestOperationPrompt({
                action: value.action,
                group: value.group,
                preview: "preview" in value ? value.preview : undefined,
                pullRequest: value.pullRequest,
                sourceRevision,
            });
            expect(prompt?.description).toContain("Mira (mira-2026)");
            expect(prompt?.input.operation).toBe(value.expectedOperation);
        }
        expect(
            pullRequestOperationPrompt({
                action: capability("create-stack"),
                group: stackGroup,
                pullRequest: { ...pullRequest, number: 999 },
                sourceRevision,
            })
        ).toBeUndefined();
        expect(
            pullRequestOperationPrompt({
                action: capability("approve-review", "raymond"),
                group: standaloneGroup,
                pullRequest,
                sourceRevision,
            })
        ).toBeUndefined();
        expect(
            pullRequestOperationPrompt({
                action: capability("merge"),
                group: standaloneGroup,
                pullRequest,
                sourceRevision,
            })
        ).toBeUndefined();
        expect(
            pullRequestOperationPrompt({
                action: capability("preview-start"),
                group: standaloneGroup,
                pullRequest,
                sourceRevision,
            })
        ).toBeUndefined();
        expect(stopPreviewPrompt({ ...preview, number: undefined }, sourceRevision)).toBe(
            undefined
        );
        expect(
            rollbackReleasePrompt(
                {
                    ...releases,
                    rollback: {
                        actor: "mira",
                        available: false,
                        reason: "no-previous-release",
                    },
                },
                sourceRevision
            )
        ).toBeUndefined();
    });

    test("invalidates every operation class when its exact authority drifts", () => {
        const approval = pullRequestOperationPrompt({
            action: capability("approve-review", "raymond"),
            group: standaloneGroup,
            pullRequest,
            reviewerRevision: resourceRevision,
            sourceRevision,
        })!;
        expect(
            deliveryOperationIsCurrent(approval.input, {
                pullRequestsFresh: true,
                pullRequestSourceRevision: sourceRevision,
                reviewerRevision: resourceRevision,
            })
        ).toBeTrue();
        expect(
            deliveryOperationIsCurrent(approval.input, {
                pullRequestsFresh: true,
                pullRequestSourceRevision: sourceRevision,
                reviewerRevision: secondResourceRevision,
            })
        ).toBeFalse();

        const update = pullRequestOperationPrompt({
            action: capability("update-branch"),
            group: standaloneGroup,
            pullRequest,
            sourceRevision,
        })!;
        expect(
            deliveryOperationIsCurrent(update.input, {
                pullRequestsFresh: true,
                pullRequestSourceRevision: sourceRevision,
            })
        ).toBeTrue();
        expect(
            deliveryOperationIsCurrent(update.input, {
                pullRequestsFresh: false,
                pullRequestSourceRevision: sourceRevision,
            })
        ).toBeFalse();

        const start = pullRequestOperationPrompt({
            action: capability("preview-start"),
            group: standaloneGroup,
            preview,
            pullRequest,
            sourceRevision,
        })!;
        expect(
            deliveryOperationIsCurrent(start.input, {
                preview,
                previewActionActive: false,
                previewFresh: true,
                pullRequestsFresh: true,
                pullRequestSourceRevision: sourceRevision,
            })
        ).toBeTrue();
        expect(
            deliveryOperationIsCurrent(start.input, {
                preview,
                previewActionActive: true,
                previewFresh: true,
                pullRequestsFresh: true,
                pullRequestSourceRevision: sourceRevision,
            })
        ).toBeFalse();

        const merge = pullRequestOperationPrompt({
            action: capability("merge"),
            checkout,
            group: standaloneGroup,
            pullRequest,
            sourceRevision,
        })!;
        expect(
            deliveryOperationIsCurrent(merge.input, {
                checkout,
                checkoutFresh: true,
                pullRequestsFresh: true,
                pullRequestSourceRevision: sourceRevision,
            })
        ).toBeTrue();
        expect(
            deliveryOperationIsCurrent(merge.input, {
                checkout: { ...checkout, revision: secondResourceRevision },
                checkoutFresh: true,
                pullRequestsFresh: true,
                pullRequestSourceRevision: sourceRevision,
            })
        ).toBeFalse();
    });

    test("uses Raymond only for exact-head review approval", () => {
        const prompt = pullRequestOperationPrompt({
            action: capability("approve-review", "raymond"),
            group: standaloneGroup,
            pullRequest,
            reviewerRevision: resourceRevision,
            sourceRevision,
        });
        expect(prompt?.description).toContain("Raymond (rajohan)");
        expect(prompt?.description).toContain("does not merge or deploy");
        expect(prompt?.input).toMatchObject({
            expectedHeadSha: sha,
            number: 424,
            operation: "approve-review",
            reviewerRevision: resourceRevision,
            sourceRevision,
        });
    });

    test("captures full ordered stack heads for Mira merge and deploy", () => {
        const action = {
            ...capability("merge-and-deploy"),
            scope: "prefix",
        } satisfies DeliveryPullRequestActionCapability;
        const prompt = pullRequestOperationPrompt({
            action,
            checkout,
            group: stackGroup,
            pullRequest,
            releases,
            sourceRevision,
        });
        expect(prompt?.description).toContain("Mira (mira-2026)");
        expect(prompt?.input).toMatchObject({
            activationRevision: secondResourceRevision,
            checkoutRevision: resourceRevision,
            deploy: true,
            expectedHeads: [
                { headSha: secondSha, number: 423 },
                { headSha: sha, number: 424 },
            ],
            mergeStack: true,
            operation: "merge-pull-request",
        });
    });

    test("keeps native stack authority when only one open layer remains", () => {
        const oneLayerStack = {
            ...stackGroup,
            members: [pullRequest],
        } as const satisfies DeliveryPullRequestGroup;
        const prompt = pullRequestOperationPrompt({
            action: capability("merge"),
            checkout,
            group: oneLayerStack,
            pullRequest,
            sourceRevision,
        });

        expect(prompt?.input).toMatchObject({
            expectedHeads: [{ headSha: sha, number: 424 }],
            mergeStack: true,
            operation: "merge-pull-request",
        });
        expect(prompt?.description).toContain("stack prefix");
    });

    test("retains one exact preview-stop intent and rejects later revision drift", () => {
        const prompt = stopPreviewPrompt(preview, sourceRevision);
        expect(prompt).toBeDefined();
        expect(
            deliveryOperationIsCurrent(prompt!.input, {
                preview,
                previewActionActive: false,
                previewFresh: true,
                previewSourceRevision: sourceRevision,
            })
        ).toBeTrue();
        expect(
            deliveryOperationIsCurrent(prompt!.input, {
                preview,
                previewActionActive: false,
                previewFresh: false,
                previewSourceRevision: sourceRevision,
            })
        ).toBeFalse();
        expect(
            deliveryOperationIsCurrent(prompt!.input, {
                preview: { ...preview, revision: secondResourceRevision },
                previewActionActive: false,
                previewFresh: true,
                previewSourceRevision: sourceRevision,
            })
        ).toBeFalse();
        expect(
            deliveryOperationIsCurrent(prompt!.input, {
                preview,
                previewActionActive: true,
                previewFresh: true,
                previewSourceRevision: sourceRevision,
            })
        ).toBeFalse();
    });

    test("binds rollback to the complete authoritative previous tuple", () => {
        const prompt = rollbackReleasePrompt(releases, sourceRevision);
        expect(prompt?.input).toMatchObject({
            activationRevision: secondResourceRevision,
            operation: "rollback-release",
            sourceRevision,
            target: releases.rollback.target,
        });
        expect(
            deliveryOperationIsCurrent(prompt!.input, {
                releases,
                releasesActionActive: false,
                releasesFresh: true,
                releasesSourceRevision: sourceRevision,
            })
        ).toBeTrue();
        expect(
            deliveryOperationIsCurrent(prompt!.input, {
                releases: {
                    ...releases,
                    rollback: {
                        ...releases.rollback,
                        target: { ...releases.rollback.target, releaseId: sha },
                    },
                },
                releasesActionActive: false,
                releasesFresh: true,
                releasesSourceRevision: sourceRevision,
            })
        ).toBeFalse();
        expect(
            deliveryOperationIsCurrent(prompt!.input, {
                releases,
                releasesActionActive: true,
                releasesFresh: true,
                releasesSourceRevision: sourceRevision,
            })
        ).toBeFalse();
    });

    test("binds deploy to remote main while the clean checkout is behind", () => {
        const remoteHeadSha = "f".repeat(40);
        const behindCheckout = { ...checkout, remoteHeadSha };
        const prompt = deployMainPrompt(behindCheckout, sourceRevision, releases);

        expect(prompt.description).toContain(remoteHeadSha);
        expect(prompt.input).toMatchObject({ expectedMainHeadSha: remoteHeadSha });
        expect(
            deliveryOperationIsCurrent(prompt.input, {
                checkout: behindCheckout,
                checkoutFresh: true,
                checkoutSourceRevision: sourceRevision,
                releases,
                releasesActionActive: false,
                releasesFresh: true,
            })
        ).toBeTrue();
    });
});
