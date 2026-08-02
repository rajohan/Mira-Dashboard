import type { PullRequestSummary } from "../../../../contracts/delivery/pullRequests.ts";
import { parsePullRequestSummary } from "../../../../contracts/delivery/pullRequests.ts";
import { DASHBOARD_REPO } from "./config.ts";
import {
    configuredGithubReadToken,
    parseRepoParts,
    runGhJson,
    runGhJsonLines,
} from "./githubCommandClient.ts";
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

let stackGraphqlCapabilityCache:
    | {
          expiresAt: number;
          key: string;
          result: Promise<boolean>;
      }
    | undefined;

/**
 * Lists open pull requests through GitHub GraphQL.
 * @param includeStackMetadata Whether private-preview stack fields should be selected.
 * @returns Raw pull request summaries.
 */
export async function listDashboardPullRequestGraphqlRows(
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

export async function supportsPullRequestStackGraphqlMetadata(): Promise<boolean> {
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
