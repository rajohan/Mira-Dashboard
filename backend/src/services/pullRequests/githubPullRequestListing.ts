import type {
    GitHubPullRequestState,
    PullRequestSummary,
} from "../../../../contracts/delivery/pullRequests.ts";
import {
    parseGitHubPullRequestState,
    parsePullRequestSummary,
} from "../../../../contracts/delivery/pullRequests.ts";
import { DASHBOARD_REPO } from "./config.ts";
import { configuredGithubReadToken, runGhJson } from "./githubCommandClient.ts";
import { listPublicDashboardPullRequests } from "./githubPublicPullRequestListing.ts";
import {
    listDashboardPullRequestGraphqlRows,
    supportsPullRequestStackGraphqlMetadata,
} from "./githubPullRequestGraphql.ts";
import {
    applyPullRequestPreviewEligibility,
    hasPullRequestChecksPassed,
    isPullRequestReviewApproved,
    normalizePullRequest,
} from "./reviewPolicy.ts";

/**
 * Lists open pull requests for the dashboard repository.
 * @returns Promise resolving to the list dashboard pull requests result.
 */
export async function listDashboardPullRequests(): Promise<PullRequestSummary[]> {
    if (
        process.env.NODE_ENV !== "production" &&
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE === "1" &&
        !configuredGithubReadToken()
    ) {
        return listPublicDashboardPullRequests();
    }
    const pullRequests = await listDashboardPullRequestGraphqlRows(
        await supportsPullRequestStackGraphqlMetadata()
    );

    const refreshedPullRequests = await Promise.all(
        pullRequests.map(async (pr) => {
            if (!shouldRefreshBlockedMergeState(pr)) {
                return normalizePullRequest(pr);
            }

            try {
                return normalizePullRequest({
                    ...(await getPullRequest(pr.number)),
                    stack: pr.stack,
                });
            } catch {
                return normalizePullRequest(pr);
            }
        })
    );

    return applyPullRequestPreviewEligibility(refreshedPullRequests).toSorted((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
    );
}

/**
 * Returns whether a blocked list state should be verified with fresh PR details.
 * @returns Whether a blocked list state should be verified with fresh PR details.
 */
function shouldRefreshBlockedMergeState(pr: PullRequestSummary): boolean {
    const mergeable = String(pr.mergeable).toUpperCase();
    return (
        pr.mergeStateStatus?.toUpperCase() === "BLOCKED" &&
        (mergeable === "MERGEABLE" || mergeable === "DIRTY") &&
        isPullRequestReviewApproved(pr) &&
        !pr.isDraft &&
        hasPullRequestChecksPassed(pr.statusCheckRollup)
    );
}

/**
 * Returns the current GitHub metadata for one pull request.
 * @param number Number value.
 * @param signal Signal used to cancel the operation.
 * @returns the current GitHub metadata for one pull request.
 */
export async function getPullRequest(
    number: number,
    signal?: AbortSignal
): Promise<PullRequestSummary> {
    return normalizePullRequest(
        await runGhJson(
            [
                "pr",
                "view",
                String(number),
                "--repo",
                DASHBOARD_REPO,
                "--json",
                [
                    "number",
                    "title",
                    "body",
                    "url",
                    "headRefName",
                    "headRefOid",
                    "isCrossRepository",
                    "baseRefName",
                    "author",
                    "createdAt",
                    "updatedAt",
                    "isDraft",
                    "mergeable",
                    "mergeStateStatus",
                    "reviewDecision",
                    "reviews",
                    "statusCheckRollup",
                    "additions",
                    "deletions",
                    "changedFiles",
                ].join(","),
            ],
            parsePullRequestSummary,
            signal
        )
    );
}

export async function getPullRequestState(
    number: number,
    signal?: AbortSignal
): Promise<GitHubPullRequestState> {
    return runGhJson(
        [
            "pr",
            "view",
            String(number),
            "--repo",
            DASHBOARD_REPO,
            "--json",
            "state,headRefOid",
        ],
        parseGitHubPullRequestState,
        signal
    );
}

/**
 * Checks the PR lifecycle without filtering by its current base branch.
 * @param number Number value.
 * @param signal Signal used to cancel the operation.
 * @returns Whether the Dashboard pull request remains open.
 */
export async function isDashboardPullRequestOpen(
    number: number,
    signal?: AbortSignal
): Promise<boolean> {
    const result = await getPullRequestState(number, signal);
    return result.state === "OPEN";
}

/**
 * Validates pr number.
 * @param value Value to process.
 * @returns Validation result for pr number.
 */
export function validatePrNumber(value: unknown): number {
    if (typeof value !== "string" || !/^\d+$/u.test(value)) {
        throw new Error("Invalid pull request number");
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error("Invalid pull request number");
    }
    return number;
}
