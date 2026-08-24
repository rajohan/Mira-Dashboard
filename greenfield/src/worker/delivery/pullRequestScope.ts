import {
    deliveryGitHubBaseBranch,
    deliveryGitHubReviewerLogin,
    type DeliveryGitHubExpectedHead,
    type DeliveryGitHubPullRequest,
} from "../../contracts/deliveryGithub.ts";
import { DeliveryGitHubError } from "./githubHttpTransport.ts";

const passingChecks = new Set(["SUCCESS", "SUCCESSFUL", "NEUTRAL", "SKIPPED"]);
const failedChecks = new Set([
    "ACTION_REQUIRED",
    "ERROR",
    "FAILURE",
    "FAILED",
    "STARTUP_FAILURE",
    "TIMED_OUT",
]);
const runningChecks = new Set([
    "EXPECTED",
    "IN_PROGRESS",
    "PENDING",
    "QUEUED",
    "REQUESTED",
    "WAITING",
]);
const attentionChecks = new Set(["CANCELLED", "STALE"]);
const opinionatedReviews = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

export type DeliveryPullRequestChecksState =
    | "attention"
    | "failed"
    | "none"
    | "passed"
    | "running"
    | "skipped"
    | "unknown";

export type DeliveryPullRequestReviewState =
    | "approved"
    | "changes-requested"
    | "pending"
    | "required";

export type DeliveryPullRequestScope = Readonly<{
    kind: "inferred" | "native" | "ordinary";
    members: readonly DeliveryGitHubPullRequest[];
}>;

function normalized(value: string | undefined): string {
    return value?.trim().toUpperCase() ?? "";
}

function checkTimestamp(check: DeliveryGitHubPullRequest["checks"][number]): number {
    for (const value of [check.completedAt, check.startedAt, check.createdAt]) {
        if (value !== undefined) {
            const timestamp = Date.parse(value);
            if (Number.isFinite(timestamp)) return timestamp;
        }
    }
    return 0;
}

export function resolvePullRequestChecksState(
    pullRequest: DeliveryGitHubPullRequest
): DeliveryPullRequestChecksState {
    if (!pullRequest.checksComplete) return "unknown";
    const latest = new Map<string, DeliveryGitHubPullRequest["checks"][number]>();
    for (const check of pullRequest.checks) {
        const previous = latest.get(check.identity);
        if (previous === undefined || checkTimestamp(check) >= checkTimestamp(previous)) {
            latest.set(check.identity, check);
        }
    }
    if (latest.size === 0) return "none";
    let attention = false;
    let failed = false;
    let running = false;
    let skipped = true;
    let unknown = false;
    for (const check of latest.values()) {
        const value = normalized(check.conclusion) || normalized(check.status);
        if (failedChecks.has(value)) {
            failed = true;
            continue;
        }
        if (runningChecks.has(value)) {
            running = true;
            continue;
        }
        if (attentionChecks.has(value)) {
            attention = true;
            continue;
        }
        if (!passingChecks.has(value)) {
            unknown = true;
            continue;
        }
        if (value !== "NEUTRAL" && value !== "SKIPPED") skipped = false;
    }
    if (failed) return "failed";
    if (running) return "running";
    if (attention) return "attention";
    if (unknown) return "unknown";
    return skipped ? "skipped" : "passed";
}

function latestReviewerOpinion(
    pullRequest: DeliveryGitHubPullRequest
): DeliveryGitHubPullRequest["reviews"][number] | undefined {
    return pullRequest.reviews
        .filter(
            (review) =>
                review.authorLogin === deliveryGitHubReviewerLogin &&
                opinionatedReviews.has(normalized(review.state))
        )
        .toSorted((left, right) =>
            (right.submittedAt ?? "").localeCompare(left.submittedAt ?? "")
        )[0];
}

export function hasReviewerApproval(pullRequest: DeliveryGitHubPullRequest): boolean {
    return normalized(latestReviewerOpinion(pullRequest)?.state) === "APPROVED";
}

export function resolvePullRequestReviewState(
    pullRequest: DeliveryGitHubPullRequest
): DeliveryPullRequestReviewState {
    if (hasReviewerApproval(pullRequest)) return "approved";
    if (normalized(latestReviewerOpinion(pullRequest)?.state) === "CHANGES_REQUESTED") {
        return "changes-requested";
    }
    return pullRequest.reviewDecision === undefined ? "pending" : "required";
}

function openPullRequests(
    pullRequests: readonly DeliveryGitHubPullRequest[]
): readonly DeliveryGitHubPullRequest[] {
    return pullRequests.filter(({ state }) => state === "OPEN");
}

function nativeScope(
    selected: DeliveryGitHubPullRequest,
    pullRequests: readonly DeliveryGitHubPullRequest[]
): DeliveryPullRequestScope | undefined {
    if (selected.stack === undefined) return undefined;
    if (selected.stack.baseRefName !== deliveryGitHubBaseBranch) return undefined;
    const members = openPullRequests(pullRequests)
        .filter(({ stack }) => stack?.number === selected.stack?.number)
        .toSorted(
            (left, right) =>
                (left.stack?.position ?? Number.MAX_SAFE_INTEGER) -
                (right.stack?.position ?? Number.MAX_SAFE_INTEGER)
        );
    if (
        members.length === 0 ||
        members.some(
            (member, index) =>
                member.stack === undefined ||
                member.stack.size !== selected.stack?.size ||
                (index > 0 &&
                    (members[index - 1]?.stack?.position ?? 0) >= member.stack.position)
        )
    ) {
        return undefined;
    }
    const selectedIndex = members.findIndex(({ number }) => number === selected.number);
    if (selectedIndex === -1) return undefined;
    return Object.freeze({
        kind: "native",
        members: Object.freeze(members.slice(0, selectedIndex + 1)),
    });
}

function inferredScope(
    selected: DeliveryGitHubPullRequest,
    pullRequests: readonly DeliveryGitHubPullRequest[]
): DeliveryPullRequestScope | undefined {
    const candidates = openPullRequests(pullRequests).filter(
        ({ isCrossRepository, stack }) => !isCrossRepository && stack === undefined
    );
    const byHead = new Map<string, DeliveryGitHubPullRequest[]>();
    for (const candidate of candidates) {
        const rows = byHead.get(candidate.headRefName) ?? [];
        rows.push(candidate);
        byHead.set(candidate.headRefName, rows);
    }
    const ancestors: DeliveryGitHubPullRequest[] = [selected];
    const seen = new Set([selected.number]);
    let current = selected;
    while (current.baseRefName !== deliveryGitHubBaseBranch) {
        const parents = byHead.get(current.baseRefName) ?? [];
        if (parents.length !== 1) return undefined;
        const parent = parents[0];
        if (parent === undefined || seen.has(parent.number)) return undefined;
        ancestors.unshift(parent);
        seen.add(parent.number);
        current = parent;
    }
    if (ancestors.length === 1) {
        const children = candidates.filter(
            ({ baseRefName }) => baseRefName === selected.headRefName
        );
        return children.length === 0
            ? Object.freeze({ kind: "ordinary", members: Object.freeze(ancestors) })
            : undefined;
    }
    for (let index = 1; index < ancestors.length; index += 1) {
        if (ancestors[index]?.baseRefName !== ancestors[index - 1]?.headRefName) {
            return undefined;
        }
    }
    for (let index = 0; index < ancestors.length; index += 1) {
        const member = ancestors[index];
        const expectedChild = ancestors[index + 1];
        const children = candidates.filter(
            ({ baseRefName }) => baseRefName === member?.headRefName
        );
        if (
            children.length !== (expectedChild === undefined ? 0 : 1) ||
            (expectedChild !== undefined && children[0]?.number !== expectedChild.number)
        ) {
            return undefined;
        }
    }
    return Object.freeze({ kind: "inferred", members: Object.freeze(ancestors) });
}

export function resolvePullRequestScope(
    selectedNumber: number,
    pullRequests: readonly DeliveryGitHubPullRequest[]
): DeliveryPullRequestScope | undefined {
    const selected = openPullRequests(pullRequests).find(
        ({ number }) => number === selectedNumber
    );
    if (selected === undefined) return undefined;
    return nativeScope(selected, pullRequests) ?? inferredScope(selected, pullRequests);
}

export function hasOpenDependentPullRequest(
    pullRequest: DeliveryGitHubPullRequest,
    pullRequests: readonly DeliveryGitHubPullRequest[]
): boolean {
    return openPullRequests(pullRequests).some(
        (candidate) =>
            candidate.number !== pullRequest.number &&
            !candidate.isCrossRepository &&
            candidate.baseRefName === pullRequest.headRefName
    );
}

export function assertExpectedPullRequestScope(
    scope: DeliveryPullRequestScope,
    expectedHeads: readonly DeliveryGitHubExpectedHead[]
): void {
    if (
        scope.members.length !== expectedHeads.length ||
        scope.members.some(
            (member, index) =>
                member.number !== expectedHeads[index]?.number ||
                member.headSha !== expectedHeads[index]?.headSha
        )
    ) {
        throw new DeliveryGitHubError("conflict");
    }
}

export function canReviewerApprove(pullRequest: DeliveryGitHubPullRequest): boolean {
    return (
        pullRequest.authorLogin !== deliveryGitHubReviewerLogin &&
        !pullRequest.isDraft &&
        !hasReviewerApproval(pullRequest)
    );
}

export function assertPullRequestMergeEligible(
    pullRequest: DeliveryGitHubPullRequest
): void {
    if (
        pullRequest.state !== "OPEN" ||
        pullRequest.isDraft ||
        resolvePullRequestChecksState(pullRequest) !== "passed" ||
        !hasReviewerApproval(pullRequest) ||
        ["CONFLICTING", "DIRTY"].includes(normalized(pullRequest.mergeable)) ||
        ["BLOCKED", "DIRTY"].includes(normalized(pullRequest.mergeStateStatus))
    ) {
        throw new DeliveryGitHubError("conflict");
    }
}
