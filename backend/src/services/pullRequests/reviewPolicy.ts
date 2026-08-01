import type {
    GitHubPullRequestStackResource,
    PullRequestSummary,
} from "../../../../contracts/delivery.ts";
import {
    isPullRequestPreviewAuthorAllowed,
    resolvePullRequestPreviewAllowedAuthors,
} from "../pullRequestPreviewPolicy.ts";
import { DEFAULT_BASE, DEFAULT_REVIEWER_AUTHOR } from "./config.ts";
import { FULL_COMMIT_SHA_PATTERN, MAX_PULL_REQUEST_BODY_LENGTH } from "./support.ts";

const PASSING_CHECK_VALUES = new Set(["success", "successful", "neutral", "skipped"]);
const OPINIONATED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

export function hasReviewerApproval(pr: PullRequestSummary): boolean {
    const author = DEFAULT_REVIEWER_AUTHOR;
    const reviews = (
        pr.latestOpinionatedReviews?.nodes?.length
            ? pr.latestOpinionatedReviews.nodes
            : pr.reviews || []
    ).filter(
        (review) =>
            review.author?.login === author &&
            OPINIONATED_REVIEW_STATES.has(review.state?.toUpperCase() || "")
    );
    const latestReview = reviews.toSorted((a, b) =>
        String(b.submittedAt || "").localeCompare(String(a.submittedAt || ""))
    )[0];
    return latestReview?.state?.toUpperCase() === "APPROVED";
}

/**
 * Returns whether the pull request has a dashboard-accepted review approval.
 * @returns Whether the pull request has a dashboard-accepted review approval.
 */
export function isPullRequestReviewApproved(pr: PullRequestSummary): boolean {
    return (
        pr.reviewDecision?.toUpperCase() === "APPROVED" ||
        pr.reviewerApproved === true ||
        hasReviewerApproval(pr)
    );
}

/**
 * Returns whether the configured reviewer can approve the pull request.
 * @returns Whether the configured reviewer can approve the pull request.
 */
export function canReviewerApprove(pr: PullRequestSummary): boolean {
    return (
        pr.author?.login !== DEFAULT_REVIEWER_AUTHOR &&
        !pr.isDraft &&
        !isPullRequestReviewApproved(pr)
    );
}

/**
 * Normalizes pull request metadata for the dashboard API.
 * @returns Normalized pull request metadata for the dashboard API.
 */
export function normalizePullRequest(pr: PullRequestSummary): PullRequestSummary {
    const rest = { ...pr };
    delete rest.latestOpinionatedReviews;
    delete rest.reviews;

    return {
        ...rest,
        body: rest.body?.slice(0, MAX_PULL_REQUEST_BODY_LENGTH),
        reviewerApproved: isPullRequestReviewApproved(pr),
    };
}

interface PullRequestPreviewScopeIndex {
    candidateScopes: Map<number, PullRequestSummary[]>;
    nativeStackMembers: Map<number, PullRequestSummary[]>;
}

function buildPullRequestPreviewScopeIndex(
    pullRequests: readonly PullRequestSummary[]
): PullRequestPreviewScopeIndex {
    const candidateScopes = new Map<number, PullRequestSummary[]>();
    const nativeStackMembers = new Map<number, PullRequestSummary[]>();
    const unstackedPullRequests: PullRequestSummary[] = [];

    for (const pullRequest of pullRequests) {
        if (pullRequest.stack) {
            const members = nativeStackMembers.get(pullRequest.stack.number) ?? [];
            members.push(pullRequest);
            nativeStackMembers.set(pullRequest.stack.number, members);
            continue;
        }
        if (pullRequest.isCrossRepository === true) {
            continue;
        }
        unstackedPullRequests.push(pullRequest);
        if (pullRequest.baseRefName === DEFAULT_BASE) {
            candidateScopes.set(pullRequest.number, [pullRequest]);
        }
    }

    for (const members of nativeStackMembers.values()) {
        members.sort(
            (left, right) => (left.stack?.position ?? 0) - (right.stack?.position ?? 0)
        );
    }

    const childrenByBase = new Map<string, PullRequestSummary[]>();
    for (const candidate of unstackedPullRequests) {
        const children = childrenByBase.get(candidate.baseRefName) ?? [];
        children.push(candidate);
        childrenByBase.set(candidate.baseRefName, children);
    }

    for (const bottomPullRequest of unstackedPullRequests) {
        if (bottomPullRequest.baseRefName !== DEFAULT_BASE) continue;
        const members = [bottomPullRequest];
        const seenNumbers = new Set([bottomPullRequest.number]);
        let currentPullRequest = bottomPullRequest;
        let isLinear = true;
        while (true) {
            const children = childrenByBase.get(currentPullRequest.headRefName) ?? [];
            if (children.length === 0) break;
            if (children.length !== 1) {
                isLinear = false;
                break;
            }
            const child = children[0];
            if (!child || seenNumbers.has(child.number)) {
                isLinear = false;
                break;
            }
            members.push(child);
            seenNumbers.add(child.number);
            currentPullRequest = child;
        }
        if (!isLinear) continue;
        for (let memberIndex = 1; memberIndex < members.length; memberIndex += 1) {
            const member = members[memberIndex];
            if (member) {
                candidateScopes.set(member.number, members.slice(0, memberIndex + 1));
            }
        }
    }

    return { candidateScopes, nativeStackMembers };
}

function resolvePullRequestPreviewScope(
    pullRequest: PullRequestSummary,
    index: PullRequestPreviewScopeIndex
): PullRequestSummary[] | undefined {
    const selectedStack = pullRequest.stack;
    if (!selectedStack) return index.candidateScopes.get(pullRequest.number);
    if (selectedStack.baseRefName !== DEFAULT_BASE) return undefined;
    const members = (index.nativeStackMembers.get(selectedStack.number) ?? []).filter(
        (candidate) => (candidate.stack?.position ?? 0) <= selectedStack.position
    );
    return members.at(-1)?.number === pullRequest.number ? members : undefined;
}

/**
 * Finds the main-rooted pull requests whose code is included in one PR head.
 * The result is ordered bottom-to-top and excludes already-merged stack layers.
 * @param pullRequest Selected pull request.
 * @param pullRequests Current open pull requests.
 * @returns Included pull requests, or undefined when no trusted linear ancestry exists.
 */
export function pullRequestPreviewScope(
    pullRequest: PullRequestSummary,
    pullRequests: readonly PullRequestSummary[]
): PullRequestSummary[] | undefined {
    return resolvePullRequestPreviewScope(
        pullRequest,
        buildPullRequestPreviewScopeIndex(pullRequests)
    );
}

/**
 * Adds computed review and preview eligibility to pull-request summaries.
 * @param pullRequests Pull requests to evaluate.
 * @returns Pull requests decorated with dashboard eligibility flags.
 */
export function applyPullRequestPreviewEligibility(
    pullRequests: PullRequestSummary[]
): PullRequestSummary[] {
    const allowedAuthors = resolvePullRequestPreviewAllowedAuthors();
    const scopeIndex = buildPullRequestPreviewScopeIndex(pullRequests);
    return pullRequests.map((pullRequest) => {
        const scope = resolvePullRequestPreviewScope(pullRequest, scopeIndex);
        const isReviewApprovalSupported =
            scope !== undefined ||
            (pullRequest.stack === undefined && pullRequest.baseRefName === DEFAULT_BASE);
        const previewEligible =
            scope !== undefined &&
            scope.every(
                (candidate) =>
                    isPullRequestPreviewAuthorAllowed(
                        candidate.author?.login,
                        allowedAuthors
                    ) &&
                    typeof candidate.headRefOid === "string" &&
                    FULL_COMMIT_SHA_PATTERN.test(candidate.headRefOid)
            );
        return {
            ...pullRequest,
            canReviewerApprove:
                isReviewApprovalSupported && canReviewerApprove(pullRequest),
            previewEligible,
        };
    });
}

export function validateDashboardPr(pr: PullRequestSummary): void {
    if (pr.baseRefName !== DEFAULT_BASE) {
        throw new Error(
            `Only ${DEFAULT_BASE}-targeted pull requests can be managed here`
        );
    }

    if (pr.isDraft) {
        throw new Error("Draft pull requests cannot be approved from the dashboard");
    }
}

/** Validates native stack base and membership without imposing merge-only gates. */
export function validateDashboardStackMembership(
    pr: PullRequestSummary,
    stack: GitHubPullRequestStackResource
): void {
    if (stack.base.ref !== DEFAULT_BASE) {
        throw new Error(
            `Only ${DEFAULT_BASE}-targeted pull request stacks can be managed here`
        );
    }
    if (!stack.pull_requests.some((pullRequest) => pullRequest.number === pr.number)) {
        throw new Error(
            `PR #${pr.number} is not a member of GitHub stack #${stack.number}`
        );
    }
}

/** Validates a native stacked pull request can be managed from the dashboard. */
export function validateDashboardStackPr(
    pr: PullRequestSummary,
    stack: GitHubPullRequestStackResource
): void {
    validateDashboardStackMembership(pr, stack);
    if (pr.isDraft) {
        throw new Error("Draft pull requests cannot be approved from the dashboard");
    }
}

/** Validates a pull request can be updated with the latest base branch. */
export function validateDashboardPrForBranchUpdate(pr: PullRequestSummary): void {
    if (pr.baseRefName !== DEFAULT_BASE) {
        throw new Error(
            `Only ${DEFAULT_BASE}-targeted pull requests can be updated here`
        );
    }

    if (pr.mergeStateStatus?.toUpperCase() !== "BEHIND") {
        throw new Error("Pull request branch is not behind the base branch");
    }

    if (["CONFLICTING", "DIRTY"].includes(pr.mergeable?.toUpperCase() || "")) {
        throw new Error("Pull request branch has merge conflicts");
    }
}

/** Validates mira pr can be approved and merged from the dashboard. */
export function validateDashboardPrForApproval(pr: PullRequestSummary): void {
    validateDashboardPr(pr);
    if (!hasPullRequestChecksPassed(pr.statusCheckRollup)) {
        throw new Error("Pull request CI checks must pass before approval");
    }
    if (!isPullRequestReviewApproved(pr)) {
        throw new Error("Pull request review approval is required before merging");
    }
}

/** Validates a native stacked pull request can be approved and merged. */
export function validateDashboardStackPrForApproval(
    pr: PullRequestSummary,
    stack: GitHubPullRequestStackResource
): void {
    validateDashboardStackPr(pr, stack);
    if (!hasPullRequestChecksPassed(pr.statusCheckRollup)) {
        throw new Error("Pull request CI checks must pass before approval");
    }
    if (!isPullRequestReviewApproved(pr)) {
        throw new Error("Pull request review approval is required before merging");
    }
}

/** Validates a pull request can receive Rajohan's review approval. */
export function validateDashboardPrForReviewApproval(
    pr: PullRequestSummary,
    stack?: GitHubPullRequestStackResource,
    isStackCandidate = false
): void {
    if (stack) {
        validateDashboardStackPr(pr, stack);
    } else if (isStackCandidate) {
        if (pr.isDraft) {
            throw new Error("Draft pull requests cannot be approved from the dashboard");
        }
    } else {
        validateDashboardPr(pr);
    }
    if (pr.author?.login === DEFAULT_REVIEWER_AUTHOR) {
        throw new Error("Rajohan cannot approve his own pull request");
    }
    if (isPullRequestReviewApproved(pr)) {
        throw new Error("Pull request is already approved");
    }
}

/**
 * Returns whether pull request checks are conclusively passing.
 * @param checks Checks value.
 * @returns Whether pull request checks are conclusively passing.
 */
export function hasPullRequestChecksPassed(checks: unknown[] | undefined): boolean {
    const records = latestCheckRecords(
        (checks || []).filter(
            (check): check is Record<string, unknown> =>
                Boolean(check) && typeof check === "object" && !Array.isArray(check)
        )
    );

    if (records.length === 0) {
        return false;
    }

    return records.every((check) => {
        const conclusion = normalizedCheckValue(check.conclusion);
        if (conclusion) {
            return PASSING_CHECK_VALUES.has(conclusion);
        }

        const status = normalizedCheckValue(check.status ?? check.state);
        return PASSING_CHECK_VALUES.has(status);
    });
}

/**
 * Keeps only the latest check entry for each GitHub check name/context.
 * @returns Latest check records result.
 */
function latestCheckRecords(
    checks: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
    const latestByKey = new Map<string, Record<string, unknown>>();
    for (const check of checks) {
        const key = checkKey(check);
        const existing = latestByKey.get(key);
        if (!existing || checkTimestamp(check) >= checkTimestamp(existing)) {
            latestByKey.set(key, check);
        }
    }
    return latestByKey.values().toArray();
}

/**
 * Returns a stable key for a GitHub status or check run.
 * @returns a stable key for a GitHub status or check run.
 */
function checkKey(check: Record<string, unknown>): string {
    for (const key of ["name", "context", "workflowName"]) {
        const value = check[key];
        if (typeof value === "string" && value.trim()) {
            return `${key}:${value.trim()}`;
        }
    }
    return JSON.stringify(check);
}

/**
 * Returns a comparable timestamp for a GitHub status or check run.
 * @returns a comparable timestamp for a GitHub status or check run.
 */
function checkTimestamp(check: Record<string, unknown>): number {
    for (const key of ["completedAt", "startedAt", "createdAt"]) {
        const value = check[key];
        if (typeof value === "string") {
            const timestamp = Date.parse(value);
            if (Number.isFinite(timestamp)) return timestamp;
        }
    }
    return 0;
}

/**
 * Normalizes a GitHub check status or conclusion.
 * @param value Value to process.
 * @returns Normalized a GitHub check status or conclusion.
 */
function normalizedCheckValue(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
}
