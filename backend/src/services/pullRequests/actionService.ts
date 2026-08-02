import type {
    GitHubPullRequestStackResource,
    PullRequestSummary,
} from "../../../../contracts/delivery/pullRequests.ts";
import { cleanupClosedPullRequestPreview } from "../pullRequestPreviews/host.ts";
import { DASHBOARD_REPO, DEFAULT_BASE } from "./config.ts";
import {
    buildReviewCommandEnvironment,
    parseRepoParts,
    runCommand,
} from "./githubCommandClient.ts";
import { getPullRequest, listDashboardPullRequests } from "./githubPullRequestListing.ts";
import {
    findPullRequestStackForGuard,
    pullRequestStackMetadata,
    requireStandalonePullRequest,
} from "./githubStackClient.ts";
import {
    applyPullRequestPreviewEligibility,
    normalizePullRequest,
    pullRequestPreviewScope,
    validateDashboardPr,
    validateDashboardPrForBranchUpdate,
    validateDashboardPrForReviewApproval,
} from "./reviewPolicy.ts";
import { cleanupPullRequestWorktree } from "./worktreeManager.ts";

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
