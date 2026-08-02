import type {
    GitHubPullRequestState,
    PullRequestSummary,
} from "../../../../contracts/delivery.ts";
import {
    parseGitHubPullRequestState,
    parsePublicGitHubPullRequests,
    parsePullRequestSummary,
} from "../../../../contracts/delivery.ts";
import { byteStreamReader } from "../../lib/byteStreams.ts";
import { errorMessage } from "../../lib/errors.ts";
import { DASHBOARD_REPO } from "./config.ts";
import {
    configuredGithubReadToken,
    MAX_BUFFER,
    parseRepoParts,
    runGhJson,
    runGhJsonLines,
} from "./githubCommandClient.ts";
import {
    applyPullRequestPreviewEligibility,
    hasPullRequestChecksPassed,
    isPullRequestReviewApproved,
    normalizePullRequest,
} from "./reviewPolicy.ts";
import {
    isRecord,
    MAX_PULL_REQUEST_BODY_LENGTH,
    pullRequestLogger as logger,
} from "./support.ts";

const PR_LIST_TIMEOUT_MS = 180_000;
const PULL_REQUEST_PAGE_SIZE = 100;
const MAX_DASHBOARD_PULL_REQUESTS = 500;
const MAX_DASHBOARD_PULL_REQUEST_PAGES = Math.ceil(
    MAX_DASHBOARD_PULL_REQUESTS / PULL_REQUEST_PAGE_SIZE
);
const STACK_GRAPHQL_CAPABILITY_CACHE_MS = 60_000;
const PUBLIC_PR_CACHE_MS = 2 * 60 * 1000;
const PUBLIC_PR_FAILURE_CACHE_MS = 30_000;
const PUBLIC_GITHUB_API_TIMEOUT_MS = 15_000;

const publicPullRequestCache: {
    failure?: { expiresAt: number; message: string };
    value?: { expiresAt: number; pullRequests: PullRequestSummary[] };
} = {};
let stackGraphqlCapabilityCache:
    | {
          expiresAt: number;
          key: string;
          result: Promise<boolean>;
      }
    | undefined;

export function parsePublicGithubPullRequests(value: unknown): PullRequestSummary[] {
    return applyPullRequestPreviewEligibility(
        parsePublicGitHubPullRequests(value).map((pullRequest) => {
            return normalizePullRequest({
                author: { login: pullRequest.user.login },
                baseRefName: pullRequest.base.ref,
                body: pullRequest.body ?? undefined,
                createdAt: pullRequest.created_at,
                headRefName: pullRequest.head.ref,
                headRefOid: pullRequest.head.sha,
                isDraft: pullRequest.draft,
                number: Number(pullRequest.number),
                stack: pullRequest.stack
                    ? {
                          baseRefName: pullRequest.stack.base.ref,
                          number: pullRequest.stack.number,
                          position: pullRequest.stack.position,
                          size: pullRequest.stack.size,
                      }
                    : undefined,
                statusCheckRollup: [],
                title: pullRequest.title,
                updatedAt: pullRequest.updated_at,
                url: pullRequest.html_url,
            });
        })
    );
}

async function readBoundedJsonResponse(
    response: Response,
    maximumBytes: number
): Promise<unknown> {
    if (!response.body) {
        throw new Error("GitHub public pull request response was empty");
    }
    const reader = byteStreamReader(response.body);
    if (!reader) {
        throw new Error("GitHub public pull request response was empty");
    }
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedBytes += value.byteLength;
            if (receivedBytes > maximumBytes) {
                await reader.cancel();
                throw new Error("GitHub public pull request response was too large");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const body = Buffer.concat(chunks, receivedBytes).toString("utf8");
    return JSON.parse(body) as unknown;
}

async function listPublicDashboardPullRequests(): Promise<PullRequestSummary[]> {
    const now = Date.now();
    const cachedPullRequests = publicPullRequestCache.value;
    if (cachedPullRequests && cachedPullRequests.expiresAt > now) {
        return cachedPullRequests.pullRequests;
    }
    const cachedFailure = publicPullRequestCache.failure;
    if (cachedFailure && cachedFailure.expiresAt > now) {
        throw new Error(cachedFailure.message);
    }
    try {
        const response = await fetch(
            `https://api.github.com/repos/${DASHBOARD_REPO}/pulls?state=open&per_page=100`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    "User-Agent": "Mira-Dashboard-development-preview",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                signal: AbortSignal.timeout(PUBLIC_GITHUB_API_TIMEOUT_MS),
            }
        );
        if (!response.ok) {
            throw new Error(
                `GitHub public pull request request failed with status ${response.status}`
            );
        }
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > MAX_BUFFER) {
            throw new Error("GitHub public pull request response was too large");
        }
        const pullRequests = parsePublicGithubPullRequests(
            await readBoundedJsonResponse(response, MAX_BUFFER)
        );
        publicPullRequestCache.value = {
            expiresAt: now + PUBLIC_PR_CACHE_MS,
            pullRequests,
        };
        publicPullRequestCache.failure = undefined;
        return pullRequests;
    } catch (error) {
        if (cachedPullRequests) {
            cachedPullRequests.expiresAt = now + PUBLIC_PR_FAILURE_CACHE_MS;
            return cachedPullRequests.pullRequests;
        }
        const message = errorMessage(error, "GitHub public pull request request failed");
        publicPullRequestCache.failure = {
            expiresAt: now + PUBLIC_PR_FAILURE_CACHE_MS,
            message,
        };
        throw new Error(message, { cause: error });
    }
}

/**
 * Lists open pull requests through GitHub GraphQL.
 * @param includeStackMetadata Whether private-preview stack fields should be selected.
 * @returns Raw pull request summaries.
 */
async function listDashboardPullRequestGraphqlRows(
    includeStackMetadata: boolean
): Promise<PullRequestSummary[]> {
    const repo = parseRepoParts(DASHBOARD_REPO);
    const stackSelection = includeStackMetadata
        ? `
                        stack {
                            baseRefName
                            number
                            size
                        }
                        stackEntry {
                            position
                        }`
        : "";
    const jqParts = [
        "$connection.nodes[]",
        `| .body = ((.body // "")[0:${MAX_PULL_REQUEST_BODY_LENGTH}])`,
        "| .statusCheckRollup = (if .statusCheckRollup.state then [{status: .statusCheckRollup.state}] else [] end)",
    ];
    if (includeStackMetadata) {
        jqParts.push(
            "| .stack = (if (.stack and .stackEntry) then {baseRefName: .stack.baseRefName, number: .stack.number, position: .stackEntry.position, size: .stack.size} else null end)",
            "| del(.stackEntry)"
        );
    }
    const pullRequests: PullRequestSummary[] = [];
    const seenCursors = new Set<string>();
    let endCursor: string | undefined;
    let pagesRead = 0;
    while (
        pagesRead < MAX_DASHBOARD_PULL_REQUEST_PAGES &&
        pullRequests.length < MAX_DASHBOARD_PULL_REQUESTS
    ) {
        pagesRead += 1;
        const arguments_ = [
            "api",
            "graphql",
            "-F",
            `owner=${repo.owner}`,
            "-F",
            `name=${repo.name}`,
            "-F",
            `limit=${PULL_REQUEST_PAGE_SIZE}`,
            ...(endCursor ? ["-F", `endCursor=${endCursor}`] : []),
            "-f",
            `query=query($owner: String!, $name: String!, $limit: Int!, $endCursor: String) {
            repository(owner: $owner, name: $name) {
                pullRequests(
                    first: $limit
                    after: $endCursor
                    states: OPEN
                    orderBy: { field: UPDATED_AT, direction: DESC }
                ) {
                    nodes {
                        number
                        title
                        body
                        url
                        headRefName
                        headRefOid
                        isCrossRepository
                        baseRefName
                        author {
                            login
                        }
                        createdAt
                        updatedAt
                        isDraft
                        mergeable
                        mergeStateStatus
                        reviewDecision
                        ${stackSelection}
                        latestOpinionatedReviews(first: 20) {
                            nodes {
                                state
                                submittedAt
                                author {
                                    login
                                }
                            }
                        }
                        additions
                        deletions
                        changedFiles
                        statusCheckRollup {
                            state
                        }
                    }
                    pageInfo {
                        endCursor
                        hasNextPage
                    }
                }
            }
            }`,
            "--jq",
            `.data.repository.pullRequests as $connection | ((${jqParts.join(" ")}), {__miraPageInfo: $connection.pageInfo})`,
        ];
        const rows = await runGhJsonLines(arguments_, parsePullRequestGraphqlOutput, {
            timeoutMs: PR_LIST_TIMEOUT_MS,
        });
        const pagePullRequests = rows.flatMap((row) =>
            row.pullRequest ? [row.pullRequest] : []
        );
        pullRequests.push(
            ...pagePullRequests.slice(
                0,
                MAX_DASHBOARD_PULL_REQUESTS - pullRequests.length
            )
        );
        const pageInfoRows = rows.flatMap((row) => (row.pageInfo ? [row.pageInfo] : []));
        if (pageInfoRows.length > 1) {
            throw new Error("GitHub returned duplicate pull request page metadata");
        }
        const pageInfo = pageInfoRows[0];
        if (!pageInfo?.hasNextPage) break;
        if (!pageInfo.endCursor || seenCursors.has(pageInfo.endCursor)) {
            throw new Error("GitHub returned an invalid pull request page cursor");
        }
        if (
            pullRequests.length >= MAX_DASHBOARD_PULL_REQUESTS ||
            pagesRead >= MAX_DASHBOARD_PULL_REQUEST_PAGES
        ) {
            logger.warn("github.pull_request_list_truncated", {
                limit: MAX_DASHBOARD_PULL_REQUESTS,
            });
            break;
        }
        seenCursors.add(pageInfo.endCursor);
        endCursor = pageInfo.endCursor;
    }
    return pullRequests;
}

interface PullRequestGraphqlOutput {
    pageInfo?: { endCursor?: string; hasNextPage: boolean };
    pullRequest?: PullRequestSummary;
}

function parsePullRequestGraphqlOutput(value: unknown): PullRequestGraphqlOutput {
    if (isRecord(value) && "__miraPageInfo" in value) {
        const pageInfo = value.__miraPageInfo;
        if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
            throw new TypeError("GitHub pull request page metadata is invalid");
        }
        const endCursor = pageInfo.endCursor;
        if (
            endCursor !== null &&
            endCursor !== undefined &&
            typeof endCursor !== "string"
        ) {
            throw new TypeError("GitHub pull request page cursor is invalid");
        }
        return {
            pageInfo: {
                ...(typeof endCursor === "string" && { endCursor }),
                hasNextPage: pageInfo.hasNextPage,
            },
        };
    }
    return { pullRequest: parsePullRequestSummary(value) };
}

function parseGraphqlPullRequestFieldNames(value: unknown): string[] {
    if (typeof value !== "object" || value === null) {
        throw new TypeError("GitHub GraphQL introspection response is invalid");
    }
    const data = (value as Record<string, unknown>).data;
    const type =
        typeof data === "object" && data !== null
            ? (data as Record<string, unknown>).__type
            : undefined;
    const fields =
        typeof type === "object" && type !== null
            ? (type as Record<string, unknown>).fields
            : undefined;
    if (!Array.isArray(fields)) {
        throw new TypeError("GitHub GraphQL introspection fields are invalid");
    }
    return fields.map((field) => {
        const name =
            typeof field === "object" && field !== null
                ? (field as Record<string, unknown>).name
                : undefined;
        if (typeof name !== "string" || name.trim() === "") {
            throw new TypeError("GitHub GraphQL introspection field name is invalid");
        }
        return name;
    });
}

async function supportsPullRequestStackGraphqlMetadata(): Promise<boolean> {
    const cacheKey = `${process.env.PATH ?? ""}\0${
        configuredGithubReadToken() ? "authenticated" : "anonymous"
    }`;
    const now = Date.now();
    if (
        stackGraphqlCapabilityCache?.key === cacheKey &&
        stackGraphqlCapabilityCache.expiresAt > now
    ) {
        return stackGraphqlCapabilityCache.result;
    }

    const result = (async () => {
        try {
            const fieldNames = await runGhJson(
                [
                    "api",
                    "graphql",
                    "-f",
                    'query=query { __type(name: "PullRequest") { fields { name } } }',
                ],
                parseGraphqlPullRequestFieldNames
            );
            return fieldNames.includes("stack") && fieldNames.includes("stackEntry");
        } catch (error) {
            logger.warn("github.stack_graphql_probe_failed", { error });
            return false;
        }
    })();
    stackGraphqlCapabilityCache = {
        expiresAt: now + STACK_GRAPHQL_CAPABILITY_CACHE_MS,
        key: cacheKey,
        result,
    };
    return result;
}

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
