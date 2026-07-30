import type { PullRequestSummary } from "../../../../../contracts/delivery";

export interface PullRequestStackCandidate {
    baseRefName: string;
    pullRequests: PullRequestSummary[];
}

export interface PullRequestStackCandidateEntry {
    candidate: PullRequestStackCandidate;
    position: number;
}

export interface PullRequestStackGroup {
    number: number;
    pullRequests: PullRequestSummary[];
}

/**
 * Finds unregistered linear pull request chains that GitHub can turn into stacks.
 * @param pullRequests Current open pull requests.
 * @param baseRefName Required stack base.
 * @returns Linear candidates ordered independently from bottom to top.
 */
export function derivePullRequestStackCandidates(
    pullRequests: PullRequestSummary[],
    baseRefName: string
): PullRequestStackCandidate[] {
    const unstackedPullRequests = pullRequests.filter(
        (pullRequest) => pullRequest.stack === undefined
    );
    const childrenByBase = new Map<string, PullRequestSummary[]>();
    for (const pullRequest of unstackedPullRequests) {
        const children = childrenByBase.get(pullRequest.baseRefName) ?? [];
        children.push(pullRequest);
        childrenByBase.set(pullRequest.baseRefName, children);
    }

    const candidates: PullRequestStackCandidate[] = [];
    for (const bottomPullRequest of unstackedPullRequests) {
        if (bottomPullRequest.baseRefName !== baseRefName) continue;

        const pullRequestChain = [bottomPullRequest];
        const numbers = new Set([bottomPullRequest.number]);
        let currentPullRequest = bottomPullRequest;
        let isAmbiguous = false;
        while (true) {
            const children = childrenByBase.get(currentPullRequest.headRefName) ?? [];
            if (children.length === 0) break;
            if (children.length > 1) {
                isAmbiguous = true;
                break;
            }

            const child = children[0];
            if (!child || numbers.has(child.number)) {
                isAmbiguous = true;
                break;
            }
            pullRequestChain.push(child);
            numbers.add(child.number);
            currentPullRequest = child;
        }

        if (!isAmbiguous && pullRequestChain.length >= 2) {
            candidates.push({
                baseRefName,
                pullRequests: pullRequestChain,
            });
        }
    }
    return candidates;
}

/**
 * Indexes candidate membership by pull request number.
 * @param candidates Linear stack candidates.
 * @returns Candidate entry lookup.
 */
export function indexPullRequestStackCandidates(
    candidates: PullRequestStackCandidate[]
): Map<number, PullRequestStackCandidateEntry> {
    const entries = new Map<number, PullRequestStackCandidateEntry>();
    for (const candidate of candidates) {
        for (const [index, pullRequest] of candidate.pullRequests.entries()) {
            entries.set(pullRequest.number, {
                candidate,
                position: index + 1,
            });
        }
    }
    return entries;
}

/**
 * Returns the open native stack members merged with a selected pull request.
 * @param selectedPullRequest Highest pull request selected for merge.
 * @param pullRequests Current open pull requests.
 * @returns Open members ordered from bottom through the selected pull request.
 */
export function pullRequestStackMergeGroup(
    selectedPullRequest: PullRequestSummary,
    pullRequests: PullRequestSummary[]
): PullRequestSummary[] {
    const stack = selectedPullRequest.stack;
    if (!stack) return [selectedPullRequest];
    return pullRequests
        .filter(
            (pullRequest) =>
                pullRequest.stack?.number === stack.number &&
                pullRequest.stack.position <= stack.position
        )
        .toSorted(
            (left, right) => (left.stack?.position ?? 0) - (right.stack?.position ?? 0)
        );
}

function latestUpdatedAt(pullRequestGroup: PullRequestSummary[]): string {
    let latest = "";
    for (const pullRequest of pullRequestGroup) {
        if (pullRequest.updatedAt > latest) latest = pullRequest.updatedAt;
    }
    return latest;
}

/**
 * Groups native GitHub stack members and orders each stack from bottom to top.
 * @param pullRequests Current open pull requests.
 * @returns Native stack groups ordered by their most recently updated member.
 */
export function groupNativePullRequestStacks(
    pullRequests: PullRequestSummary[]
): PullRequestStackGroup[] {
    const pullRequestsByStack = new Map<number, PullRequestSummary[]>();
    for (const pullRequest of pullRequests) {
        const stackNumber = pullRequest.stack?.number;
        if (stackNumber === undefined) continue;
        const members = pullRequestsByStack.get(stackNumber) ?? [];
        members.push(pullRequest);
        pullRequestsByStack.set(stackNumber, members);
    }

    return [...pullRequestsByStack]
        .map(([number, members]) => ({
            number,
            pullRequests: members.toSorted(
                (left, right) =>
                    (left.stack?.position ?? 0) - (right.stack?.position ?? 0)
            ),
        }))
        .toSorted((left, right) => {
            const leftUpdatedAt = latestUpdatedAt(left.pullRequests);
            const rightUpdatedAt = latestUpdatedAt(right.pullRequests);
            return rightUpdatedAt.localeCompare(leftUpdatedAt);
        });
}
