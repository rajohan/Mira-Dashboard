import type { DeploymentJob } from "../../../../contracts/delivery/deployments.ts";
import type {
    PullRequestPreviewCleanupResult,
    WorktreeCleanupResult,
} from "../../../../contracts/delivery/previews.ts";
import type {
    GitHubPullRequestStackResource,
    PullRequestExpectedHead,
} from "../../../../contracts/delivery/pullRequests.ts";
import { errorMessage } from "../../lib/errors.ts";
import { cleanupClosedPullRequestPreview } from "../pullRequestPreviews/host.ts";
import {
    isPullRequestPreviewAuthorAllowed,
    resolvePullRequestPreviewAllowedAuthors,
} from "../pullRequestPreviews/policy.ts";
import { DASHBOARD_REPO } from "./config.ts";
import {
    acquireDeploymentLock,
    refreshDeploymentLockOwner,
    releaseDeploymentLock,
} from "./deploymentLock.ts";
import { startDeployLatest } from "./deploymentService.ts";
import { runCommand } from "./githubCommandClient.ts";
import { getPullRequest, getPullRequestState } from "./githubPullRequestListing.ts";
import {
    mergePullRequestStack,
    requirePullRequestStack,
    requireStandalonePullRequest,
} from "./githubStackClient.ts";
import {
    validateDashboardPrForApproval,
    validateDashboardStackPr,
    validateDashboardStackPrForApproval,
} from "./reviewPolicy.ts";
import {
    FULL_COMMIT_SHA_PATTERN,
    isRecord,
    pullRequestLogger as logger,
} from "./support.ts";
import {
    cleanupPullRequestWorktree,
    ensureProductionCheckout,
    syncMain,
} from "./worktreeManager.ts";

/**
 * Describes the outcome of merging a pull request and starting deployment.
 *
 * @param number - Pull request number.
 * @param willDeploy - Whether deployment was requested.
 * @param syncError - Production checkout synchronization error, when present.
 * @param deployError - Deployment startup error, when present.
 * @returns User-facing merge result message.
 */
function pullRequestMergeMessage(
    number: number,
    willDeploy: boolean,
    syncError: string | undefined,
    deployError: string | undefined
): string {
    if (syncError) {
        return `PR #${number} merged. Production sync failed`;
    }
    if (deployError) {
        return `PR #${number} merged. Deploy failed to start`;
    }
    return willDeploy ? `PR #${number} merged. Deploy started` : `PR #${number} merged`;
}

/**
 * Describes the outcome of atomically merging a native pull request stack.
 * @param stackNumber GitHub stack number.
 * @param number Highest pull request included in the merge.
 * @param pullRequestCount Number of open pull requests merged.
 * @param willDeploy Whether deployment was requested.
 * @param syncError Production checkout synchronization error, when present.
 * @param deployError Deployment startup error, when present.
 * @returns User-facing stack merge result message.
 */
function pullRequestStackMergeMessage(
    stackNumber: number,
    number: number,
    pullRequestCount: number,
    willDeploy: boolean,
    syncError: string | undefined,
    deployError: string | undefined
): string {
    const merged = `Stack #${stackNumber} merged through PR #${number} (${pullRequestCount} PR${pullRequestCount === 1 ? "" : "s"})`;
    if (syncError) return `${merged}. Production sync failed`;
    if (deployError) return `${merged}. Deploy failed to start`;
    return willDeploy ? `${merged}. Deploy started` : merged;
}

/**
 * Describes a native stack accepted by GitHub's merge queue.
 * @param stackNumber GitHub stack number.
 * @param number Highest pull request included in the queue group.
 * @param pullRequestCount Number of open pull requests added to the queue.
 * @param willDeploy Whether deployment was requested.
 * @returns User-facing queued stack result message.
 */
function pullRequestStackQueuedMessage(
    stackNumber: number,
    number: number,
    pullRequestCount: number,
    willDeploy: boolean
): string {
    const queued = `Stack #${stackNumber} queued through PR #${number} (${pullRequestCount} PR${pullRequestCount === 1 ? "" : "s"})`;
    return willDeploy
        ? `${queued}. Delivery retained every worktree and will not auto-deploy; deploy latest main after GitHub finishes the queue`
        : `${queued}. Delivery retained every worktree because GitHub has not confirmed the PRs merged`;
}

export interface PullRequestApprovalExecutionOptions {
    expectedHeadSha: string;
    expectedStackHeads?: PullRequestExpectedHead[];
    lockHeldBy?: string;
    mergeStack?: boolean;
    signal?: AbortSignal;
}

export function requireExpectedStackHeads(
    value: unknown,
    mergeStack: boolean
): PullRequestExpectedHead[] | undefined {
    if (!mergeStack) {
        if (value !== undefined) {
            throw Object.assign(
                new TypeError(
                    "Expected stack heads are valid only for a native stack merge"
                ),
                { statusCode: 400 }
            );
        }
        return undefined;
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
        throw Object.assign(
            new TypeError(
                "Native stack merge requires the expected head of every included pull request"
            ),
            { statusCode: 400 }
        );
    }

    const seenNumbers = new Set<number>();
    const entries: unknown[] = value;
    return entries.map((entry) => {
        if (
            !isRecord(entry) ||
            Object.keys(entry).some((key) => key !== "headSha" && key !== "number") ||
            typeof entry.headSha !== "string" ||
            !FULL_COMMIT_SHA_PATTERN.test(entry.headSha) ||
            typeof entry.number !== "number" ||
            !Number.isSafeInteger(entry.number) ||
            entry.number <= 0 ||
            seenNumbers.has(entry.number)
        ) {
            throw Object.assign(
                new TypeError("Expected native stack pull request heads are invalid"),
                { statusCode: 400 }
            );
        }
        seenNumbers.add(entry.number);
        return {
            headSha: entry.headSha,
            number: entry.number,
        };
    });
}

/**
 * Performs approve pull request.
 * @param number Number value.
 * @param willDeploy Whether will deploy.
 * @param options Operation options.
 * @returns Approve pull request result.
 */
export async function approvePullRequest(
    number: number,
    willDeploy: boolean,
    options: PullRequestApprovalExecutionOptions
) {
    const expectedStackHeads = requireExpectedStackHeads(
        options.expectedStackHeads,
        options.mergeStack === true
    );
    const lockId = options.lockHeldBy ?? `approve-${Bun.randomUUIDv7()}`;
    let isReleaseLock = options.lockHeldBy !== undefined;

    let syncError: string | undefined;
    let deployError: string | undefined;
    let deployment: DeploymentJob | undefined;
    let cleanup: WorktreeCleanupResult | undefined;
    let cleanups: WorktreeCleanupResult[] | undefined;
    let previewCleanup: PullRequestPreviewCleanupResult | undefined;
    let previewCleanups: PullRequestPreviewCleanupResult[] | undefined;
    let stack: GitHubPullRequestStackResource | undefined;
    let stackPullRequests: GitHubPullRequestStackResource["pull_requests"] = [];
    let mergeStatus: "enqueued" | "merged" | undefined;

    try {
        if (options.lockHeldBy) {
            refreshDeploymentLockOwner(lockId);
        }
        await ensureProductionCheckout(options.signal);
        const pr = await getPullRequest(number, options.signal);
        if (
            !FULL_COMMIT_SHA_PATTERN.test(options.expectedHeadSha) ||
            pr.headRefOid !== options.expectedHeadSha
        ) {
            throw Object.assign(
                new Error(
                    `PR #${number} changed after the Delivery page loaded. Refresh before merging`
                ),
                { statusCode: 409 }
            );
        }
        if (options.mergeStack) {
            stack = await requirePullRequestStack(number, options.signal);
            validateDashboardStackPr(pr, stack);
            const selectedIndex = stack.pull_requests.findIndex(
                (pullRequest) => pullRequest.number === number
            );
            if (selectedIndex === -1) {
                throw Object.assign(
                    new Error(`PR #${number} is not in GitHub stack #${stack.number}`),
                    { statusCode: 409 }
                );
            }
            const selectedPullRequest = stack.pull_requests[selectedIndex];
            if (!selectedPullRequest) {
                throw new Error(
                    `GitHub stack #${stack.number} has no entry at position ${selectedIndex + 1}`
                );
            }
            if (
                selectedPullRequest.state !== "open" ||
                selectedPullRequest.merged_at !== null
            ) {
                throw Object.assign(
                    new Error(`PR #${number} is not open for stack merge`),
                    { statusCode: 409 }
                );
            }
            if (selectedPullRequest.head.sha !== options.expectedHeadSha) {
                throw Object.assign(
                    new Error(
                        `PR #${number} changed after the Delivery page loaded. Refresh before merging the stack`
                    ),
                    { statusCode: 409 }
                );
            }
            stackPullRequests = [];
            for (const pullRequest of stack.pull_requests.slice(0, selectedIndex + 1)) {
                if (pullRequest.merged_at !== null) continue;
                if (pullRequest.state !== "open") {
                    throw Object.assign(
                        new Error(
                            `PR #${pullRequest.number} is closed and blocks merging through PR #${number}`
                        ),
                        { statusCode: 409 }
                    );
                }
                if (pullRequest.draft) {
                    throw Object.assign(
                        new Error(
                            `PR #${pullRequest.number} is a draft and blocks merging through PR #${number}`
                        ),
                        { statusCode: 409 }
                    );
                }
                stackPullRequests.push(pullRequest);
            }
            if (expectedStackHeads?.length !== stackPullRequests.length) {
                throw Object.assign(
                    new Error(
                        `GitHub stack #${stack.number} membership changed after the Delivery confirmation. Refresh before merging`
                    ),
                    { statusCode: 409 }
                );
            }
            for (const [index, stackPullRequest] of stackPullRequests.entries()) {
                const expectedHead = expectedStackHeads[index];
                if (!expectedHead || expectedHead.number !== stackPullRequest.number) {
                    throw Object.assign(
                        new Error(
                            `GitHub stack #${stack.number} order changed after the Delivery confirmation. Refresh before merging`
                        ),
                        { statusCode: 409 }
                    );
                }
                if (expectedHead.headSha !== stackPullRequest.head.sha) {
                    throw Object.assign(
                        new Error(
                            `PR #${stackPullRequest.number} changed after the Delivery confirmation. Refresh before merging the stack`
                        ),
                        { statusCode: 409 }
                    );
                }
            }
            const currentPullRequests = await Promise.all(
                stackPullRequests.map((pullRequest) =>
                    pullRequest.number === pr.number
                        ? Promise.resolve(pr)
                        : getPullRequest(pullRequest.number, options.signal)
                )
            );
            const trustedStackAuthors = resolvePullRequestPreviewAllowedAuthors();
            for (const [index, currentPullRequest] of currentPullRequests.entries()) {
                const stackPullRequest = stackPullRequests[index];
                const expectedHead = expectedStackHeads[index];
                if (!stackPullRequest || !expectedHead) continue;
                if (currentPullRequest.headRefOid !== expectedHead.headSha) {
                    throw Object.assign(
                        new Error(
                            `PR #${currentPullRequest.number} changed after the Delivery confirmation. Refresh before merging the stack`
                        ),
                        { statusCode: 409 }
                    );
                }
                if (
                    !isPullRequestPreviewAuthorAllowed(
                        currentPullRequest.author?.login,
                        trustedStackAuthors
                    )
                ) {
                    throw Object.assign(
                        new Error(
                            `PR #${currentPullRequest.number} is not authored by a trusted stack contributor and cannot be merged through the stack endpoint`
                        ),
                        { statusCode: 409 }
                    );
                }
                try {
                    validateDashboardStackPrForApproval(currentPullRequest, stack);
                } catch (error) {
                    throw Object.assign(
                        new Error(
                            `PR #${currentPullRequest.number}: ${errorMessage(
                                error,
                                "Stack member is not ready to merge"
                            )}`
                        ),
                        { statusCode: 409 }
                    );
                }
            }
        } else {
            validateDashboardPrForApproval(pr);
            await requireStandalonePullRequest(pr, "merge", options.signal);
        }
        if (!options.lockHeldBy) {
            acquireDeploymentLock(lockId);
            isReleaseLock = true;
        }
        if (stack) {
            const stackMergeResult = await mergePullRequestStack(
                number,
                options.expectedHeadSha,
                options.signal
            );
            if (stackMergeResult.status === "enqueued") {
                mergeStatus = "enqueued";
                return {
                    isOk: true,
                    mergeStatus,
                    message: pullRequestStackQueuedMessage(
                        stack.number,
                        number,
                        stackPullRequests.length,
                        willDeploy
                    ),
                };
            }
            if (stackMergeResult.status !== "merged") {
                throw new Error(
                    `GitHub stack merge returned unexpected status ${stackMergeResult.status}`
                );
            }
            const unconfirmedPullRequests: number[] = [];
            for (const [index, pullRequest] of stackPullRequests.entries()) {
                const state = await getPullRequestState(
                    pullRequest.number,
                    options.signal
                );
                if (
                    state.state !== "MERGED" ||
                    state.headRefOid !== expectedStackHeads?.[index]?.headSha
                ) {
                    unconfirmedPullRequests.push(pullRequest.number);
                }
            }
            if (unconfirmedPullRequests.length > 0) {
                logger.error("github.stack_merge_unconfirmed", {
                    affectedPullRequests: unconfirmedPullRequests,
                    number,
                    recoveryAction:
                        "Verify the GitHub stack state, then run syncMain before deploying",
                    stackNumber: stack.number,
                    worktreesRetained: true,
                });
                throw Object.assign(
                    new Error(
                        `GitHub reported the stack merged, but ${unconfirmedPullRequests
                            .map((pullRequestNumber) => `PR #${pullRequestNumber}`)
                            .join(
                                ", "
                            )} did not confirm as merged. Worktrees were retained; verify GitHub, then run production sync before deploying`
                    ),
                    { statusCode: 409 }
                );
            }
            mergeStatus = "merged";
            cleanups = [];
            previewCleanups = [];
            for (const pullRequest of stackPullRequests) {
                cleanups.push(
                    await cleanupPullRequestWorktree(pullRequest.head.ref, options.signal)
                );
                // Stack merges and preview lifecycle actions share the exclusive worker.
                previewCleanups.push(
                    await cleanupClosedPullRequestPreview(pullRequest.number)
                );
            }
        } else {
            const mergeArguments = [
                "pr",
                "merge",
                String(number),
                "--squash",
                "--delete-branch",
                "--repo",
                DASHBOARD_REPO,
                "--match-head-commit",
                options.expectedHeadSha,
            ];
            await runCommand("gh", mergeArguments, {
                signal: options.signal,
                timeoutMs: 120_000,
            });
            cleanup = await cleanupPullRequestWorktree(pr.headRefName, options.signal);
            // The production entry point runs this inside the exclusive github.merge job,
            // which shares the single-capacity worker with every preview lifecycle action.
            previewCleanup = await cleanupClosedPullRequestPreview(number);
        }

        try {
            await syncMain(options.signal);
        } catch (error) {
            syncError = errorMessage(error, "Failed to sync main after merge");
        }

        if (willDeploy && !syncError) {
            try {
                deployment = startDeployLatest(lockId);
                isReleaseLock = false;
            } catch (error) {
                deployError = errorMessage(error, "Deploy failed to start");
            }
        }
    } finally {
        if (isReleaseLock) {
            releaseDeploymentLock(lockId);
        }
    }

    return {
        isOk: true,
        message: stack
            ? pullRequestStackMergeMessage(
                  stack.number,
                  number,
                  stackPullRequests.length,
                  willDeploy,
                  syncError,
                  deployError
              )
            : pullRequestMergeMessage(number, willDeploy, syncError, deployError),
        deployment,
        deployError,
        cleanup,
        cleanups,
        mergeStatus,
        previewCleanup,
        previewCleanups,
        syncError,
    };
}
