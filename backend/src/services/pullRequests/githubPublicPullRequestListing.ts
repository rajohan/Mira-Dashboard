import type { PullRequestSummary } from "../../../../contracts/delivery/pullRequests.ts";
import { parsePublicGitHubPullRequests } from "../../../../contracts/delivery/pullRequests.ts";
import { byteStreamReader } from "../../lib/byteStreams.ts";
import { errorMessage } from "../../lib/errors.ts";
import { DASHBOARD_REPO } from "./config.ts";
import { MAX_BUFFER } from "./githubCommandClient.ts";
import {
    applyPullRequestPreviewEligibility,
    normalizePullRequest,
} from "./reviewPolicy.ts";

const PUBLIC_PR_CACHE_MS = 2 * 60 * 1000;
const PUBLIC_PR_FAILURE_CACHE_MS = 30_000;
const PUBLIC_GITHUB_API_TIMEOUT_MS = 15_000;

const publicPullRequestCache: {
    failure?: { expiresAt: number; message: string };
    value?: { expiresAt: number; pullRequests: PullRequestSummary[] };
} = {};

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

export async function listPublicDashboardPullRequests(): Promise<PullRequestSummary[]> {
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
