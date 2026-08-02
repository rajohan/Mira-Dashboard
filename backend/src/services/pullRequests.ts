import type {
    DeploymentJob,
    GitHubAsyncPullRequestMergeResult,
    GitHubPullRequestStackResource,
    PullRequestExpectedHead,
    PullRequestPreviewCleanupResult,
    PullRequestSummary,
    WorktreeCleanupResult,
} from "../../../contracts/delivery.ts";
import { parseGitHubAsyncPullRequestMergeResult } from "../../../contracts/delivery.ts";
import type { ScheduledJob } from "../../../contracts/jobs.ts";
import { errorMessage } from "../lib/errors.ts";
import { enqueueJobExecution, type JobExecutionRecord } from "./jobExecutionQueue.ts";
import { cleanupClosedPullRequestPreview } from "./pullRequestPreviews/host.ts";
import {
    isPullRequestPreviewAuthorAllowed,
    resolvePullRequestPreviewAllowedAuthors,
} from "./pullRequestPreviews/policy.ts";
import { DASHBOARD_REPO, DEFAULT_BASE } from "./pullRequests/config.ts";
import {
    acquireDeploymentLock,
    refreshDeploymentLockOwner,
    registerPullRequestJobLifecycleHandlers,
    releaseDeploymentLock,
} from "./pullRequests/deploymentRepository.ts";
import {
    registerDeploymentExecutionActions,
    startDeployLatest,
} from "./pullRequests/deploymentService.ts";
import {
    FULL_COMMIT_SHA_PATTERN,
    isRecord,
    pullRequestLogger as logger,
} from "./pullRequests/support.ts";
import {
    cleanupPullRequestWorktree,
    ensureProductionCheckout,
    syncMain,
} from "./pullRequests/worktreeManager.ts";

export {
    ensureProductionCheckout,
    ensureProductionReadyForDeploy,
    getProductionCheckoutStatus,
} from "./pullRequests/worktreeManager.ts";
export {
    prepareAndStartDeployLatest,
    prepareAndStartRollback,
    startDeployLatest,
} from "./pullRequests/deploymentService.ts";
import {
    buildReviewCommandEnvironment,
    createPullRequestStack,
    findPullRequestStackForGuard,
    getPullRequest,
    getPullRequestState,
    listDashboardPullRequests,
    parseRepoParts,
    pullRequestStackMetadata,
    requirePullRequestStack,
    requireStandalonePullRequest,
    runCommand,
    runGhJson,
    runGhJsonWithResultBody,
    validatePrNumber,
} from "./pullRequests/githubClient.ts";

export {
    createPullRequestStack,
    isDashboardPullRequestOpen,
    listDashboardPullRequests,
    parsePublicGithubPullRequests,
    validatePrNumber,
    validatePullRequestPreviewScope,
} from "./pullRequests/githubClient.ts";
import {
    applyPullRequestPreviewEligibility,
    normalizePullRequest,
    pullRequestPreviewScope,
    validateDashboardPr,
    validateDashboardPrForApproval,
    validateDashboardPrForBranchUpdate,
    validateDashboardPrForReviewApproval,
    validateDashboardStackPr,
    validateDashboardStackPrForApproval,
} from "./pullRequests/reviewPolicy.ts";

export { pullRequestPreviewScope } from "./pullRequests/reviewPolicy.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "./queuedJobExecution.ts";

export { getResolvedRoots } from "./pullRequests/config.ts";
export {
    getDashboardReleaseStatus,
    readDeploymentJobs,
    registerPullRequestJobLifecycleHandlers,
} from "./pullRequests/deploymentRepository.ts";

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

import {
    registerScheduledJobAction,
    type ScheduledJobActionContext,
    ScheduledJobActionError,
} from "./scheduledJobs.ts";

const STACK_MERGE_POLL_INTERVAL_MS = 1000;
const STACK_MERGE_TIMEOUT_MS = 5 * 60 * 1000;
const STACK_MERGE_JOB_TIMEOUT_MS = STACK_MERGE_TIMEOUT_MS * 2 + 2 * 60 * 1000;

async function mergePullRequestStack(
    number: number,
    expectedHeadSha: string,
    signal?: AbortSignal
): Promise<GitHubAsyncPullRequestMergeResult> {
    if (!FULL_COMMIT_SHA_PATTERN.test(expectedHeadSha)) {
        throw Object.assign(
            new TypeError("Stack merge requires a full lowercase pull request head SHA"),
            { statusCode: 400 }
        );
    }
    const repo = parseRepoParts(DASHBOARD_REPO);
    // Keep both the local refetch and GitHub's request-side SHA precondition:
    // neither a stale Delivery page nor a push in the final request window may
    // merge a different selected head than the one the user confirmed.
    // A command failure is intentionally not reconciled from PR state alone:
    // without a successful response, Delivery cannot attribute an external
    // merge to this exact-head request and must retain worktrees/deploy state.
    let result = await runGhJsonWithResultBody(
        [
            "api",
            "-X",
            "PUT",
            `repos/${repo.owner}/${repo.name}/pulls/${number}/merge-async`,
            "-F",
            "merge_method=squash",
            "-F",
            "merge_action=default",
            "-f",
            `sha=${expectedHeadSha}`,
        ],
        parseGitHubAsyncPullRequestMergeResult,
        signal,
        STACK_MERGE_TIMEOUT_MS
    );
    if (
        result.details.expected_head_sha &&
        result.details.expected_head_sha !== expectedHeadSha
    ) {
        throw Object.assign(
            new Error(
                `PR #${number} changed while GitHub accepted the stack merge. Verify the stack state before retrying`
            ),
            { statusCode: 409 }
        );
    }
    if (
        result.status === "pending" &&
        (result.details.expected_head_sha !== expectedHeadSha ||
            result.details.merge_action !== "default" ||
            result.details.merge_method !== "squash")
    ) {
        throw Object.assign(
            new Error(
                `PR #${number} already has an incompatible pending stack merge request`
            ),
            { statusCode: 409 }
        );
    }

    const deadline = Date.now() + STACK_MERGE_TIMEOUT_MS;
    while (result.status === "pending") {
        const uuid = result.details.uuid;
        if (!uuid) {
            throw new Error("GitHub stack merge returned pending without a result id");
        }
        const remainingBeforePoll = deadline - Date.now();
        if (remainingBeforePoll <= 0) {
            throw new Error(`GitHub stack merge for PR #${number} timed out`);
        }
        signal?.throwIfAborted();
        await Bun.sleep(Math.min(STACK_MERGE_POLL_INTERVAL_MS, remainingBeforePoll));
        signal?.throwIfAborted();
        const remainingRequestTime = deadline - Date.now();
        if (remainingRequestTime <= 0) {
            throw new Error(`GitHub stack merge for PR #${number} timed out`);
        }
        result = await runGhJson(
            [
                "api",
                `repos/${repo.owner}/${repo.name}/pulls/${number}/merge-async/${uuid}`,
            ],
            parseGitHubAsyncPullRequestMergeResult,
            signal,
            Math.min(60_000, remainingRequestTime)
        );
    }

    if (result.status === "failed") {
        throw Object.assign(new Error(result.details.message), { statusCode: 409 });
    }
    return result;
}

interface PullRequestApprovalExecutionOptions {
    expectedHeadSha: string;
    expectedStackHeads?: PullRequestExpectedHead[];
    lockHeldBy?: string;
    mergeStack?: boolean;
    signal?: AbortSignal;
}

function requireExpectedStackHeads(
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

function queuedPullRequestResult<T>(execution: JobExecutionRecord): T {
    if ("result" in execution.output) return execution.output.result as T;
    successfulJobExecutionOutput(execution);
    throw new Error("Pull request result was missing");
}

/**
 * Creates a native GitHub stack through the persistent execution plane.
 * @param pullRequests Pull request numbers ordered from bottom to top.
 * @returns Promise resolving to the stack creation result.
 */
export async function runPullRequestStackCreation(pullRequests: number[]) {
    const execution = enqueueJobExecution({
        actionKey: "github.stack-create",
        displayName: `Create GitHub stack from ${pullRequests.length} PRs`,
        payload: { pullRequests },
        resourceClass: "exclusive",
        timeoutMs: 5 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof createPullRequestStack>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

/**
 * Runs PR merge/deploy through the shared persistent execution plane.
 * @param number Number value.
 * @param willDeploy Whether will deploy.
 * @param options Exact-head and native stack merge options.
 * @returns Promise resolving to the run pull request approval result.
 */
export async function runPullRequestApproval(
    number: number,
    willDeploy: boolean,
    options: {
        expectedHeadSha: string;
        expectedStackHeads?: PullRequestExpectedHead[];
        mergeStack?: boolean;
    }
) {
    registerPullRequestJobLifecycleHandlers();
    const expectedStackHeads = requireExpectedStackHeads(
        options.expectedStackHeads,
        options.mergeStack === true
    );
    const deploymentLockId = `approve-${Bun.randomUUIDv7()}`;
    acquireDeploymentLock(deploymentLockId);
    let timeoutMs = 10 * 60 * 1000;
    if (options.mergeStack) timeoutMs = STACK_MERGE_JOB_TIMEOUT_MS;
    if (willDeploy) timeoutMs = 45 * 60 * 1000;
    let execution: JobExecutionRecord;
    try {
        execution = enqueueJobExecution({
            actionKey: willDeploy ? "github.merge-deploy" : "github.merge",
            displayName: willDeploy
                ? `Merge and deploy ${options.mergeStack ? "stack through " : ""}PR #${number}`
                : `Merge ${options.mergeStack ? "stack through " : ""}PR #${number}`,
            payload: {
                deploymentLockId,
                expectedHeadSha: options.expectedHeadSha,
                expectedStackHeads,
                mergeStack: options.mergeStack === true,
                number,
                willDeploy,
            },
            resourceClass: "exclusive",
            timeoutMs,
        });
    } catch (error) {
        releaseDeploymentLock(deploymentLockId);
        throw error;
    }
    return queuedPullRequestResult<Awaited<ReturnType<typeof approvePullRequest>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 60 * 60 * 1000 })
    );
}

/**
 * Performs approve pull request review.
 * @param number Number value.
 * @param signal Signal used to cancel the operation.
 * @returns Approve pull request review result.
 */
export async function approvePullRequestReview(number: number, signal?: AbortSignal) {
    const pr = await getPullRequest(number, signal);
    let stack: GitHubPullRequestStackResource | undefined;
    let stackCandidatePullRequests: PullRequestSummary[] | undefined;
    if (pr.baseRefName !== DEFAULT_BASE) {
        stack = await findPullRequestStackForGuard(number, signal);
        if (!stack) {
            const pullRequests = await listDashboardPullRequests();
            stackCandidatePullRequests = [
                ...pullRequests.filter((pullRequest) => pullRequest.number !== number),
                pr,
            ];
            if (!pullRequestPreviewScope(pr, stackCandidatePullRequests)) {
                throw Object.assign(
                    new Error(
                        `PR #${number} is not part of a main-rooted linear candidate or GitHub stack`
                    ),
                    { statusCode: 409 }
                );
            }
        }
    }
    validateDashboardPrForReviewApproval(
        pr,
        stack,
        stackCandidatePullRequests !== undefined
    );

    await runCommand(
        "gh",
        ["pr", "review", String(number), "--approve", "--repo", DASHBOARD_REPO],
        {
            environment: buildReviewCommandEnvironment(),
            signal,
            timeoutMs: 60_000,
        }
    );

    const refreshedPullRequest = await getPullRequest(number, signal);
    const stackMetadata = stack ? pullRequestStackMetadata(stack, number) : undefined;
    const pullRequest = normalizePullRequest({
        ...refreshedPullRequest,
        stack: stackMetadata,
    });
    const eligibilityPeers = stack
        ? await listDashboardPullRequests()
        : stackCandidatePullRequests;
    const pullRequestsWithEligibility = applyPullRequestPreviewEligibility(
        eligibilityPeers
            ? [
                  ...eligibilityPeers.filter(
                      (candidate) => candidate.number !== pullRequest.number
                  ),
                  pullRequest,
              ]
            : [pullRequest]
    );

    return {
        isOk: true,
        message: `PR #${number} review approved`,
        pullRequest:
            pullRequestsWithEligibility.find(
                (candidate) => candidate.number === pullRequest.number
            ) ?? pullRequest,
    };
}

/**
 * Updates one pull request branch with the latest base branch.
 * @param number Number value.
 * @param signal Signal used to cancel the operation.
 * @returns Promise resolving to the update pull request branch result.
 */
export async function updatePullRequestBranch(number: number, signal?: AbortSignal) {
    const pr = await getPullRequest(number, signal);
    validateDashboardPrForBranchUpdate(pr);
    await requireStandalonePullRequest(pr, "branch update", signal);
    const repo = parseRepoParts(DASHBOARD_REPO);
    const arguments_ = [
        "api",
        "-X",
        "PUT",
        `repos/${repo.owner}/${repo.name}/pulls/${number}/update-branch`,
    ];
    if (pr.headRefOid) {
        arguments_.push("-f", `expected_head_sha=${pr.headRefOid}`);
    }

    await runCommand("gh", arguments_, { signal, timeoutMs: 60_000 });

    return {
        isOk: true,
        message: `PR #${number} branch update started`,
        pullRequest: applyPullRequestPreviewEligibility([
            await getPullRequest(number, signal),
        ])[0],
    };
}

/**
 * Performs reject pull request.
 * @param number Number value.
 * @param comment Comment value.
 * @param signal Signal used to cancel the operation.
 * @returns Reject pull request result.
 */
export async function rejectPullRequest(
    number: number,
    comment: string,
    signal?: AbortSignal
) {
    const pr = await getPullRequest(number, signal);
    validateDashboardPr(pr);
    await requireStandalonePullRequest(pr, "reject", signal);

    await runCommand(
        "gh",
        ["pr", "close", String(number), "--repo", DASHBOARD_REPO, "--comment", comment],
        { signal, timeoutMs: 60_000 }
    );
    const cleanup = await cleanupPullRequestWorktree(pr.headRefName, signal);
    // The production entry point runs this inside the exclusive github.reject job,
    // which shares the single-capacity worker with every preview lifecycle action.
    const previewCleanup = await cleanupClosedPullRequestPreview(number);

    return {
        isOk: true,
        message: `PR #${number} closed`,
        cleanup,
        previewCleanup,
    };
}

/**
 * Records a GitHub review approval in the shared execution plane.
 * @param number Number value.
 * @returns Promise resolving to the run pull request review approval result.
 */
export async function runPullRequestReviewApproval(number: number) {
    const execution = enqueueJobExecution({
        actionKey: "github.review-approval",
        displayName: `Approve review for PR #${number}`,
        payload: { number },
        resourceClass: "network",
        timeoutMs: 2 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof approvePullRequestReview>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

/**
 * Records a GitHub branch update in the shared execution plane.
 * @param number Number value.
 * @returns Promise resolving to the run pull request branch update result.
 */
export async function runPullRequestBranchUpdate(number: number) {
    const execution = enqueueJobExecution({
        actionKey: "github.update-branch",
        displayName: `Update branch for PR #${number}`,
        payload: { number },
        resourceClass: "network",
        timeoutMs: 2 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof updatePullRequestBranch>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

/**
 * Records a PR close and local worktree cleanup in the execution plane.
 * @param number Number value.
 * @param comment Comment value.
 * @returns Promise resolving to the run pull request rejection result.
 */
export async function runPullRequestRejection(number: number, comment: string) {
    const execution = enqueueJobExecution({
        actionKey: "github.reject",
        displayName: `Reject PR #${number}`,
        payload: { comment, number },
        resourceClass: "exclusive",
        timeoutMs: 5 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof rejectPullRequest>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

function executionPullRequestNumber(payload: Record<string, unknown>): number {
    const number = payload.number;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) {
        return number;
    }
    return validatePrNumber(number);
}

function executionPullRequestStackNumbers(payload: Record<string, unknown>): number[] {
    const pullRequests = payload.pullRequests;
    if (
        !Array.isArray(pullRequests) ||
        pullRequests.length < 2 ||
        pullRequests.length > 100
    ) {
        throw Object.assign(new Error("Pull request stack payload is invalid"), {
            statusCode: 400,
        });
    }
    const numbers: number[] = [];
    for (const value of pullRequests) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
            throw Object.assign(new Error("Pull request stack payload is invalid"), {
                statusCode: 400,
            });
        }
        numbers.push(value);
    }
    return numbers;
}

async function executePullRequestMerge(
    job: ScheduledJob,
    signal: AbortSignal | undefined,
    context: ScheduledJobActionContext
) {
    context.protectFromCancellation();
    const number = executionPullRequestNumber(job.actionPayload);
    const willDeploy = job.actionPayload.willDeploy === true;
    const mergeStack = job.actionPayload.mergeStack === true;
    const expectedHeadSha = job.actionPayload.expectedHeadSha;
    const expectedStackHeads = requireExpectedStackHeads(
        job.actionPayload.expectedStackHeads,
        mergeStack
    );
    if (
        typeof expectedHeadSha !== "string" ||
        !FULL_COMMIT_SHA_PATTERN.test(expectedHeadSha)
    ) {
        throw Object.assign(new Error("Expected pull request head SHA is invalid"), {
            statusCode: 400,
        });
    }
    const deploymentLockId = job.actionPayload.deploymentLockId;
    if (
        deploymentLockId !== undefined &&
        (typeof deploymentLockId !== "string" || deploymentLockId.trim() === "")
    ) {
        throw Object.assign(new Error("Deployment lock id is invalid"), {
            statusCode: 400,
        });
    }
    const result = await approvePullRequest(number, willDeploy, {
        expectedHeadSha,
        expectedStackHeads,
        lockHeldBy: deploymentLockId,
        mergeStack,
        signal,
    });
    const message = result.syncError || result.deployError;
    if (message) {
        throw new ScheduledJobActionError(message, { result });
    }
    return { result };
}

/** Registers every mutating GitHub/release action exclusively in the worker. */
export function registerPullRequestExecutionActions(): void {
    registerDeploymentExecutionActions();
    registerScheduledJobAction("github.merge", executePullRequestMerge);
    registerScheduledJobAction("github.merge-deploy", executePullRequestMerge);
    registerScheduledJobAction("github.stack-create", async (job, signal, context) => {
        const pullRequests = executionPullRequestStackNumbers(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await createPullRequestStack(pullRequests, signal),
        };
    });
    registerScheduledJobAction("github.review-approval", async (job, signal, context) => {
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await approvePullRequestReview(number, signal),
        };
    });
    registerScheduledJobAction("github.update-branch", async (job, signal, context) => {
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await updatePullRequestBranch(number, signal),
        };
    });
    registerScheduledJobAction("github.reject", async (job, signal, context) => {
        const comment = job.actionPayload.comment;
        if (typeof comment !== "string" || comment.trim() === "") {
            throw Object.assign(new Error("Pull request rejection comment is missing"), {
                statusCode: 400,
            });
        }
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await rejectPullRequest(number, comment, signal),
        };
    });
}
