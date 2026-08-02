import type {
    GitHubAsyncPullRequestMergeResult,
    GitHubPullRequestStackResource,
    PullRequestStack,
    PullRequestSummary,
} from "../../../../contracts/delivery/pullRequests.ts";
import {
    parseGitHubAsyncPullRequestMergeResult,
    parseGitHubPullRequestStackResource,
    parseGitHubPullRequestStacks,
} from "../../../../contracts/delivery/pullRequests.ts";
import { DASHBOARD_REPO, DEFAULT_BASE } from "./config.ts";
import {
    GitHubRestApiError,
    parseRepoParts,
    pullRequestStacksEndpoint,
    runGhJson,
    runGhJsonWithResultBody,
    runGhRestJson,
} from "./githubCommandClient.ts";
import { listDashboardPullRequests } from "./githubPullRequestListing.ts";
import { validateDashboardStackMembership } from "./reviewPolicy.ts";
import { FULL_COMMIT_SHA_PATTERN, isRecord } from "./support.ts";

const STACK_MERGE_POLL_INTERVAL_MS = 1000;
const STACK_MERGE_TIMEOUT_MS = 5 * 60 * 1000;
export const STACK_MERGE_JOB_TIMEOUT_MS = STACK_MERGE_TIMEOUT_MS * 2 + 2 * 60 * 1000;

/** Submits an exact-head native stack merge and waits for GitHub's terminal result. */
export async function mergePullRequestStack(
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
    // Keep both the local refetch in the merge service and GitHub's request-side
    // SHA precondition. A command failure is intentionally not reconciled from
    // PR state alone because it cannot be attributed to this exact-head request.
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

/** Validates that a selected pull request belongs to the requested preview scope. */
export async function validatePullRequestPreviewScope(
    pullRequest: PullRequestSummary,
    scope: readonly PullRequestSummary[],
    signal?: AbortSignal
): Promise<void> {
    if (!pullRequest.stack) return;
    const stack = await requirePullRequestStack(pullRequest.number, signal);
    validateDashboardStackMembership(pullRequest, stack);
    const selectedIndex = stack.pull_requests.findIndex(
        (candidate) => candidate.number === pullRequest.number
    );
    if (selectedIndex === -1) {
        throw Object.assign(
            new Error(`PR #${pullRequest.number} is no longer in its GitHub stack`),
            { statusCode: 409 }
        );
    }
    const scopeByNumber = new Map(
        scope.map((candidate) => [candidate.number, candidate])
    );
    for (const stackPullRequest of stack.pull_requests.slice(0, selectedIndex + 1)) {
        if (stackPullRequest.merged_at !== null) continue;
        if (stackPullRequest.state !== "open") {
            throw Object.assign(
                new Error(
                    `PR #${stackPullRequest.number} is closed and blocks this stack preview`
                ),
                { statusCode: 409 }
            );
        }
        const scopedPullRequest = scopeByNumber.get(stackPullRequest.number);
        if (
            !scopedPullRequest ||
            scopedPullRequest.headRefOid !== stackPullRequest.head.sha
        ) {
            throw Object.assign(
                new Error(
                    `PR #${stackPullRequest.number} changed while Delivery loaded the stack preview`
                ),
                { statusCode: 409 }
            );
        }
    }
}

/**
 * Returns the native GitHub stack containing one pull request.
 * @param number Pull request number.
 * @param signal Signal used to cancel the operation.
 * @returns The native stack, when the pull request is stacked.
 */
export async function findPullRequestStack(
    number: number,
    signal?: AbortSignal
): Promise<GitHubPullRequestStackResource | undefined> {
    const endpoint = `${pullRequestStacksEndpoint()}?pull_request=${number}&per_page=2`;
    const stacks = await runGhRestJson(
        ["api", endpoint, "--include"],
        endpoint,
        parseGitHubPullRequestStacks,
        signal
    );
    if (stacks.length > 1) {
        throw new Error(`GitHub returned multiple stacks for PR #${number}`);
    }
    return stacks[0];
}

/**
 * Requires one pull request to belong to a native GitHub stack.
 * @param number Pull request number.
 * @param signal Signal used to cancel the operation.
 * @returns The pull request's native stack.
 */
export async function requirePullRequestStack(
    number: number,
    signal?: AbortSignal
): Promise<GitHubPullRequestStackResource> {
    const stack = await findPullRequestStack(number, signal);
    if (!stack) {
        throw Object.assign(
            new Error(
                `PR #${number} is not registered as a GitHub stack. Create the stack before merging it`
            ),
            { statusCode: 409 }
        );
    }
    return stack;
}

export function isGitHubStackApiUnavailable(error: unknown): boolean {
    const endpoint = pullRequestStacksEndpoint();
    return (
        error instanceof GitHubRestApiError &&
        error.statusCode === 404 &&
        (error.endpoint === endpoint || error.endpoint.startsWith(`${endpoint}?`))
    );
}

/**
 * Finds stack membership for ordinary PR mutation guards without breaking
 * repositories where the private-preview stack API is unavailable.
 * @param number Pull request number.
 * @param signal Signal used to cancel the operation.
 * @returns Native stack membership, when visible and present.
 */
export async function findPullRequestStackForGuard(
    number: number,
    signal?: AbortSignal
): Promise<GitHubPullRequestStackResource | undefined> {
    try {
        return await findPullRequestStack(number, signal);
    } catch (error) {
        if (isGitHubStackApiUnavailable(error)) return undefined;
        throw error;
    }
}

function parsePullRequestNumberRows(value: unknown): number[] {
    if (!Array.isArray(value) || value.length > 2) {
        throw new TypeError("GitHub returned an invalid dependent pull request list");
    }
    const rows: unknown[] = value;
    return rows.map((row) => {
        if (
            !isRecord(row) ||
            typeof row.number !== "number" ||
            !Number.isSafeInteger(row.number) ||
            row.number <= 0
        ) {
            throw new TypeError("GitHub returned an invalid dependent pull request");
        }
        return row.number;
    });
}

/**
 * Prevents ordinary single-PR mutations from breaking a native or candidate stack.
 * @param pullRequest Pull request being mutated.
 * @param action User-facing action description.
 * @param signal Signal used to cancel the operation.
 */
export async function requireStandalonePullRequest(
    pullRequest: PullRequestSummary,
    action: string,
    signal?: AbortSignal
): Promise<void> {
    const stack = await findPullRequestStackForGuard(pullRequest.number, signal);
    if (stack) {
        throw Object.assign(
            new Error(
                `PR #${pullRequest.number} belongs to GitHub stack #${stack.number}. Use the stack-aware ${action} flow`
            ),
            { statusCode: 409 }
        );
    }
    if (
        pullRequest.isCrossRepository === true ||
        pullRequest.headRefName === DEFAULT_BASE
    ) {
        return;
    }

    const dependentPullRequestNumbers = await runGhJson(
        [
            "pr",
            "list",
            "--repo",
            DASHBOARD_REPO,
            "--state",
            "open",
            "--base",
            pullRequest.headRefName,
            "--limit",
            "2",
            "--json",
            "number",
        ],
        parsePullRequestNumberRows,
        signal
    );
    if (
        dependentPullRequestNumbers.some(
            (dependentPullRequestNumber) =>
                dependentPullRequestNumber !== pullRequest.number
        )
    ) {
        throw Object.assign(
            new Error(
                `PR #${pullRequest.number} has an open dependent pull request. Create or restructure the stack before ${action}`
            ),
            { statusCode: 409 }
        );
    }
}

/**
 * Maps one native stack resource to the summary metadata for a member.
 * @param stack Native GitHub stack.
 * @param number Pull request number.
 * @returns Dashboard stack metadata for the pull request.
 */
export function pullRequestStackMetadata(
    stack: GitHubPullRequestStackResource,
    number: number
): PullRequestStack | undefined {
    const index = stack.pull_requests.findIndex(
        (pullRequest) => pullRequest.number === number
    );
    if (index === -1) return undefined;
    return {
        baseRefName: stack.base.ref,
        number: stack.number,
        position: index + 1,
        size: stack.pull_requests.length,
    };
}

/**
 * Validates an ordered list of existing pull requests as one linear stack.
 * @param numbers Pull request numbers ordered from bottom to top.
 * @param pullRequests Current open pull requests.
 * @returns The validated pull requests ordered from bottom to top.
 */
function validatePullRequestStackCandidate(
    numbers: number[],
    pullRequests: PullRequestSummary[]
): PullRequestSummary[] {
    if (new Set(numbers).size !== numbers.length) {
        throw Object.assign(new Error("A stack cannot contain duplicate pull requests"), {
            statusCode: 400,
        });
    }

    const pullRequestsByNumber = new Map(
        pullRequests.map((pullRequest) => [pullRequest.number, pullRequest])
    );
    const orderedPullRequests = numbers.map((number) => {
        const pullRequest = pullRequestsByNumber.get(number);
        if (!pullRequest) {
            throw Object.assign(
                new Error(`PR #${number} is not an open pull request in this repository`),
                { statusCode: 409 }
            );
        }
        if (pullRequest.stack) {
            throw Object.assign(
                new Error(
                    `PR #${number} already belongs to GitHub stack #${pullRequest.stack.number}`
                ),
                { statusCode: 409 }
            );
        }
        if (pullRequest.isCrossRepository === true) {
            throw Object.assign(
                new Error(
                    `PR #${number} is cross-repository and cannot join a GitHub stack`
                ),
                { statusCode: 409 }
            );
        }
        return pullRequest;
    });

    const bottomPullRequest = orderedPullRequests[0];
    if (!bottomPullRequest || bottomPullRequest.baseRefName !== DEFAULT_BASE) {
        throw Object.assign(
            new Error(`The bottom pull request must target ${DEFAULT_BASE}`),
            { statusCode: 409 }
        );
    }

    for (let index = 1; index < orderedPullRequests.length; index += 1) {
        const previousPullRequest = orderedPullRequests[index - 1];
        const pullRequest = orderedPullRequests[index];
        if (
            !previousPullRequest ||
            !pullRequest ||
            pullRequest.baseRefName !== previousPullRequest.headRefName
        ) {
            throw Object.assign(
                new Error(
                    `PR #${pullRequest?.number ?? numbers[index]} must target ${
                        previousPullRequest?.headRefName ?? "the branch below it"
                    }`
                ),
                { statusCode: 409 }
            );
        }
    }

    const candidatePullRequests = pullRequests.filter(
        (pullRequest) =>
            pullRequest.stack === undefined && pullRequest.isCrossRepository !== true
    );
    const childrenByBase = new Map<string, PullRequestSummary[]>();
    for (const pullRequest of candidatePullRequests) {
        const children = childrenByBase.get(pullRequest.baseRefName) ?? [];
        children.push(pullRequest);
        childrenByBase.set(pullRequest.baseRefName, children);
    }

    for (const [index, pullRequest] of orderedPullRequests.entries()) {
        const expectedChild = orderedPullRequests[index + 1];
        const children = childrenByBase.get(pullRequest.headRefName) ?? [];
        if (children.length > 1) {
            throw Object.assign(
                new Error(
                    `PR #${pullRequest.number} has multiple open dependent pull requests; only a complete linear chain can become a GitHub stack`
                ),
                { statusCode: 409 }
            );
        }
        const child = children[0];
        if (expectedChild && child?.number !== expectedChild.number) {
            throw Object.assign(
                new Error(
                    `PR #${expectedChild.number} is not the current dependent of PR #${pullRequest.number}`
                ),
                { statusCode: 409 }
            );
        }
        if (!expectedChild && child) {
            throw Object.assign(
                new Error(
                    `PR #${child.number} depends on PR #${pullRequest.number} and must be included in the GitHub stack`
                ),
                { statusCode: 409 }
            );
        }
    }

    return orderedPullRequests;
}

/**
 * Creates a native GitHub stack from existing linear pull requests.
 * @param numbers Pull request numbers ordered from bottom to top.
 * @param signal Signal used to cancel the operation.
 * @returns Pull request action response.
 */
export async function createPullRequestStack(numbers: number[], signal?: AbortSignal) {
    const pullRequests = validatePullRequestStackCandidate(
        numbers,
        await listDashboardPullRequests()
    );
    const endpoint = pullRequestStacksEndpoint();
    const arguments_ = ["api", "-X", "POST", endpoint];
    for (const pullRequest of pullRequests) {
        arguments_.push("-F", `pull_requests[]=${pullRequest.number}`);
    }
    arguments_.push("--include");
    let stack: GitHubPullRequestStackResource;
    try {
        stack = await runGhRestJson(
            arguments_,
            endpoint,
            parseGitHubPullRequestStackResource,
            signal
        );
    } catch (error) {
        if (isGitHubStackApiUnavailable(error)) {
            throw Object.assign(
                new Error("GitHub stacks are not enabled for this repository or token"),
                { statusCode: 409 }
            );
        }
        throw error;
    }
    return {
        isOk: true,
        message: `GitHub stack #${stack.number} created with ${stack.pull_requests.length} PRs`,
    };
}
