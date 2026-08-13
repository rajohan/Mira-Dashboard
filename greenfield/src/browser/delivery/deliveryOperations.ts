import type {
    DeliveryCheckout,
    DeliveryExpectedHead,
    DeliveryPreview,
    DeliveryPullRequest,
    DeliveryPullRequestActionCapability,
    DeliveryPullRequestGroup,
    DeliveryReleases,
    DeliveryRequestOperationInput,
} from "../../contracts/delivery.ts";

export interface DeliveryOperationPrompt {
    readonly confirmLabel: string;
    readonly danger: boolean;
    readonly description: string;
    readonly input: DeliveryRequestOperationInput;
    readonly title: string;
}

export interface DeliveryAuthoritySnapshot {
    readonly checkout?: DeliveryCheckout;
    readonly checkoutFresh?: boolean;
    readonly checkoutSourceRevision?: string;
    readonly preview?: DeliveryPreview;
    readonly previewActionActive?: boolean;
    readonly previewFresh?: boolean;
    readonly previewSourceRevision?: string;
    readonly pullRequestsFresh?: boolean;
    readonly pullRequestSourceRevision?: string;
    readonly releases?: DeliveryReleases;
    readonly releasesActionActive?: boolean;
    readonly releasesFresh?: boolean;
    readonly releasesSourceRevision?: string;
    readonly reviewerRevision?: string;
}

export function createDeliveryIdempotencyKey(): string {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function shortSha(sha: string): string {
    return sha.slice(0, 12);
}

function scopeDescription(scope: readonly DeliveryExpectedHead[]): string {
    return scope
        .map(({ headSha, number }) => `#${number} @ ${shortSha(headSha)}`)
        .join(" → ");
}

function actionExpectedHeads(
    group: DeliveryPullRequestGroup,
    pullRequest: DeliveryPullRequest,
    action: DeliveryPullRequestActionCapability
): DeliveryExpectedHead[] | undefined {
    const index = group.members.findIndex(({ number }) => number === pullRequest.number);
    if (index === -1) return undefined;
    let members: readonly DeliveryPullRequest[] = [pullRequest];
    if (action.scope === "group") members = group.members;
    if (action.scope === "prefix") members = group.members.slice(0, index + 1);
    return members.map(({ headSha, number }) => ({ headSha, number }));
}

export function pullRequestOperationPrompt(input: {
    readonly action: DeliveryPullRequestActionCapability;
    readonly checkout?: DeliveryCheckout;
    readonly group: DeliveryPullRequestGroup;
    readonly preview?: DeliveryPreview;
    readonly pullRequest: DeliveryPullRequest;
    readonly releases?: DeliveryReleases;
    readonly reviewerRevision?: string;
    readonly sourceRevision: string;
}): DeliveryOperationPrompt | undefined {
    const { action, pullRequest, sourceRevision } = input;
    const expectedHeads = actionExpectedHeads(input.group, pullRequest, action);
    if (expectedHeads === undefined) return undefined;
    const idempotencyKey = createDeliveryIdempotencyKey();
    switch (action.action) {
        case "approve-review": {
            if (input.reviewerRevision === undefined) return undefined;
            return {
                confirmLabel: "Queue approval",
                danger: false,
                description: `Raymond (rajohan) will approve only the review for #${pullRequest.number} at exact head ${pullRequest.headSha}. This does not merge or deploy.`,
                input: {
                    confirmation: "approve-delivery-review",
                    expectedHeadSha: pullRequest.headSha,
                    idempotencyKey,
                    number: pullRequest.number,
                    operation: "approve-review",
                    reviewerRevision: input.reviewerRevision,
                    sourceRevision,
                },
                title: "Approve pull request review?",
            };
        }
        case "create-stack": {
            return {
                confirmLabel: "Queue stack creation",
                danger: false,
                description: `Mira (mira-2026) will create one native GitHub stack in this exact bottom-to-top order: ${scopeDescription(expectedHeads)}. Commits and reviews are unchanged.`,
                input: {
                    confirmation: "create-delivery-stack",
                    expectedHeads,
                    idempotencyKey,
                    operation: "create-pull-request-stack",
                    sourceRevision,
                },
                title: "Create native pull request stack?",
            };
        }
        case "merge":
        case "merge-and-deploy": {
            if (input.checkout === undefined) return undefined;
            const deploy = action.action === "merge-and-deploy";
            if (deploy && input.releases === undefined) return undefined;
            // A partially merged native stack can legitimately have one open layer
            // left. Stack authority comes from the server-owned group kind, never
            // from the remaining prefix cardinality.
            const mergeStack = input.group.kind === "native-stack";
            const description = mergeStack
                ? `Mira (mira-2026) will squash-merge the exact stack prefix bottom-to-top: ${scopeDescription(expectedHeads)}. Branch cleanup happens only after every included layer is confirmed merged.`
                : `Mira (mira-2026) will squash-merge #${pullRequest.number} at exact head ${pullRequest.headSha} and request safe remote-branch cleanup.`;
            return {
                confirmLabel: deploy ? "Queue merge and deploy" : "Queue merge",
                danger: deploy,
                description: deploy
                    ? `${description} After confirmed merge, main is synced to the exact remote head, an immutable release is built and verified, and failure restores the prior paired release.`
                    : `${description} Production is not deployed.`,
                input: deploy
                    ? {
                          activationRevision: input.releases!.activationRevision,
                          checkoutRevision: input.checkout.revision,
                          confirmation: "merge-and-deploy-delivery-pull-request",
                          deploy: true,
                          expectedHeads,
                          idempotencyKey,
                          mergeStack,
                          number: pullRequest.number,
                          operation: "merge-pull-request",
                          sourceRevision,
                      }
                    : {
                          checkoutRevision: input.checkout.revision,
                          confirmation: "merge-delivery-pull-request",
                          deploy: false,
                          expectedHeads,
                          idempotencyKey,
                          mergeStack,
                          number: pullRequest.number,
                          operation: "merge-pull-request",
                          sourceRevision,
                      },
                title: deploy ? "Merge and deploy?" : "Merge pull request?",
            };
        }
        case "preview-start": {
            if (input.preview === undefined) return undefined;
            return {
                confirmLabel:
                    input.preview.number === pullRequest.number
                        ? "Queue rebuild"
                        : "Queue preview",
                danger: false,
                description: `Mira (mira-2026) will run isolated preview code for this exact scope: ${scopeDescription(expectedHeads)}. It uses one global slot, no source watchers, and automatically stops after four hours.`,
                input: {
                    confirmation: "start-delivery-preview",
                    expectedHeads,
                    idempotencyKey,
                    number: pullRequest.number,
                    operation: "start-preview",
                    previewRevision: input.preview.revision,
                    sourceRevision,
                },
                title:
                    input.preview.number === pullRequest.number
                        ? "Rebuild pull request preview?"
                        : "Start pull request preview?",
            };
        }
        case "reject": {
            return {
                confirmLabel: "Queue rejection",
                danger: true,
                description: `Mira (mira-2026) will close #${pullRequest.number} at exact head ${pullRequest.headSha} with the fixed Dashboard comment. The remote branch is not deleted.`,
                input: {
                    confirmation: "reject-delivery-pull-request",
                    expectedHeadSha: pullRequest.headSha,
                    idempotencyKey,
                    number: pullRequest.number,
                    operation: "reject-pull-request",
                    sourceRevision,
                },
                title: "Reject pull request?",
            };
        }
        case "update-branch": {
            return {
                confirmLabel: "Queue branch update",
                danger: false,
                description: `Mira (mira-2026) will ask GitHub to update #${pullRequest.number} from its base using exact head ${pullRequest.headSha}.`,
                input: {
                    confirmation: "update-delivery-pull-request-branch",
                    expectedHeadSha: pullRequest.headSha,
                    idempotencyKey,
                    number: pullRequest.number,
                    operation: "update-branch",
                    sourceRevision,
                },
                title: "Update pull request branch?",
            };
        }
    }
}

export function stopPreviewPrompt(
    preview: DeliveryPreview,
    sourceRevision: string
): DeliveryOperationPrompt | undefined {
    if (preview.number === undefined) return undefined;
    return {
        confirmLabel: "Queue preview stop",
        danger: true,
        description: `Mira (mira-2026) will stop the global preview owned by #${preview.number}. Its managed checkout and isolated state remain available while the pull request stays open.`,
        input: {
            confirmation: "stop-delivery-preview",
            idempotencyKey: createDeliveryIdempotencyKey(),
            number: preview.number,
            operation: "stop-preview",
            previewRevision: preview.revision,
            sourceRevision,
        },
        title: "Stop pull request preview?",
    };
}

export function deployMainPrompt(
    checkout: DeliveryCheckout,
    checkoutSourceRevision: string,
    releases: DeliveryReleases
): DeliveryOperationPrompt {
    return {
        confirmLabel: "Queue deploy",
        danger: true,
        description: `Mira (mira-2026) will deploy exact main head ${checkout.remoteHeadSha}. The immutable release is atomically activated and verified; a failed cutover restores the prior paired release and database snapshot.`,
        input: {
            activationRevision: releases.activationRevision,
            checkoutRevision: checkout.revision,
            confirmation: "deploy-delivery-main",
            expectedMainHeadSha: checkout.remoteHeadSha,
            idempotencyKey: createDeliveryIdempotencyKey(),
            operation: "deploy",
            sourceRevision: checkoutSourceRevision,
        },
        title: "Deploy latest main?",
    };
}

export function rollbackReleasePrompt(
    releases: DeliveryReleases,
    sourceRevision: string
): DeliveryOperationPrompt | undefined {
    if (!releases.rollback.available) return undefined;
    return {
        confirmLabel: "Queue rollback",
        danger: true,
        description: `Mira (mira-2026) will restore exact previous release ${releases.rollback.target.releaseId} with its paired database snapshot, then verify the target. If target verification fails, the current release is restored.`,
        input: {
            activationRevision: releases.activationRevision,
            confirmation: "rollback-delivery-release",
            idempotencyKey: createDeliveryIdempotencyKey(),
            operation: "rollback-release",
            sourceRevision,
            target: releases.rollback.target,
        },
        title: "Rollback production release?",
    };
}

export function deliveryOperationIsCurrent(
    input: DeliveryRequestOperationInput,
    current: DeliveryAuthoritySnapshot
): boolean {
    switch (input.operation) {
        case "approve-review": {
            return (
                current.pullRequestsFresh === true &&
                input.sourceRevision === current.pullRequestSourceRevision &&
                input.reviewerRevision === current.reviewerRevision
            );
        }
        case "create-pull-request-stack":
        case "reject-pull-request":
        case "update-branch": {
            return (
                current.pullRequestsFresh === true &&
                input.sourceRevision === current.pullRequestSourceRevision
            );
        }
        case "merge-pull-request": {
            return (
                current.pullRequestsFresh === true &&
                current.checkoutFresh === true &&
                input.sourceRevision === current.pullRequestSourceRevision &&
                input.checkoutRevision === current.checkout?.revision &&
                (!input.deploy ||
                    (current.releasesFresh === true &&
                        current.releasesActionActive === false &&
                        input.activationRevision ===
                            current.releases?.activationRevision))
            );
        }
        case "start-preview": {
            return (
                current.pullRequestsFresh === true &&
                current.previewFresh === true &&
                current.previewActionActive === false &&
                input.sourceRevision === current.pullRequestSourceRevision &&
                input.previewRevision === current.preview?.revision
            );
        }
        case "stop-preview": {
            return (
                current.previewFresh === true &&
                current.previewActionActive === false &&
                input.sourceRevision === current.previewSourceRevision &&
                input.previewRevision === current.preview?.revision &&
                input.number === current.preview.number
            );
        }
        case "deploy": {
            return (
                current.checkoutFresh === true &&
                current.releasesFresh === true &&
                current.releasesActionActive === false &&
                input.sourceRevision === current.checkoutSourceRevision &&
                input.checkoutRevision === current.checkout?.revision &&
                input.activationRevision === current.releases?.activationRevision &&
                input.expectedMainHeadSha === current.checkout.remoteHeadSha
            );
        }
        case "rollback-release": {
            const rollback = current.releases?.rollback;
            return (
                current.releasesFresh === true &&
                current.releasesActionActive === false &&
                input.sourceRevision === current.releasesSourceRevision &&
                input.activationRevision === current.releases?.activationRevision &&
                rollback?.available === true &&
                input.target.releaseId === rollback.target.releaseId &&
                input.target.runtimeRevision === rollback.target.runtimeRevision &&
                input.target.databaseSnapshotTransitionId ===
                    rollback.target.databaseSnapshotTransitionId
            );
        }
    }
}
