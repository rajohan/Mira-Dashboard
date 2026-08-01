import path from "node:path";

import type {
    GitHubPullRequestState,
    GitHubPullRequestStackResource,
    PullRequestStack,
    PullRequestSummary,
} from "../../../../contracts/delivery.ts";
import {
    parseGitHubPullRequestState,
    parseGitHubPullRequestStackResource,
    parseGitHubPullRequestStacks,
    parsePublicGitHubPullRequests,
    parsePullRequestSummary,
} from "../../../../contracts/delivery.ts";
import type { ContractParser } from "../../../../contracts/runtime.ts";
import { byteStreamReader } from "../../lib/byteStreams.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
    killProcessGroup,
    pipeProcessOutput,
    runProcess,
    spawnProcess,
} from "../../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import { DASHBOARD_REPO, DEFAULT_BASE, getDashboardRoot } from "./config.ts";
import {
    applyPullRequestPreviewEligibility,
    hasPullRequestChecksPassed,
    isPullRequestReviewApproved,
    normalizePullRequest,
    validateDashboardStackMembership,
} from "./reviewPolicy.ts";
import {
    isRecord,
    MAX_PULL_REQUEST_BODY_LENGTH,
    pullRequestLogger as logger,
} from "./support.ts";

interface CommandResult {
    stdout: string;
    stderr: string;
}

const MAX_BUFFER = 20 * 1024 * 1024;
const MAX_JSON_LINE_LENGTH = 1024 * 1024;
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

export function trimOutput(value: string): string {
    return value.slice(-20_000);
}

/**
 * Splits an owner/name GitHub repository identifier.
 * @param repo Repo value.
 * @returns Parsed repo parts.
 */
export function parseRepoParts(repo: string): { owner: string; name: string } {
    const parts = repo.split("/");
    const [owner, name] = parts;
    if (!owner || !name || parts.length !== 2) {
        throw new Error("Dashboard repository must be configured as owner/name");
    }
    return { owner, name };
}

export function pullRequestStacksEndpoint(): string {
    const repo = parseRepoParts(DASHBOARD_REPO);
    return `repos/${repo.owner}/${repo.name}/stacks`;
}

/**
 * Builds GitHub command environment for one token.
 * @param githubToken Github token value.
 * @returns Built GitHub command environment for one token.
 */
function buildGithubCommandEnvironment(githubToken: string): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
        if (
            key === "MIRA_GITHUB_TOKEN" ||
            key === "RAJOHAN_GITHUB_TOKEN" ||
            key.startsWith("MIRA_GITHUB_TOKEN_") ||
            key.startsWith("RAJOHAN_GITHUB_TOKEN_")
        ) {
            delete environment[key];
        }
    }
    delete environment.GITHUB_TOKEN;
    if (githubToken) {
        environment.GH_TOKEN = githubToken;
    } else {
        delete environment.GH_TOKEN;
    }
    return environment;
}

/**
 * Builds command environment.
 * @returns Built command environment.
 */
export function buildCommandEnvironment(): NodeJS.ProcessEnv {
    const githubToken = configuredGithubReadToken();
    const environment = buildGithubCommandEnvironment(githubToken);
    const bunBinDirectory = path.join(
        nonEmptyEnvironmentFallback("HOME", "/home/ubuntu"),
        ".bun",
        "bin"
    );
    environment.PATH = [environment.PATH, bunBinDirectory]
        .filter(Boolean)
        .join(path.delimiter);
    return environment;
}

export function configuredGithubReadToken(): string {
    return (
        process.env.MIRA_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim() ||
        ""
    );
}

/**
 * Builds reviewer command environment.
 * @returns Built reviewer command environment.
 */
export function buildReviewCommandEnvironment(): NodeJS.ProcessEnv {
    const githubToken = process.env.RAJOHAN_GITHUB_TOKEN?.trim() || "";
    if (!githubToken) {
        throw new Error("Rajohan GitHub review token is not configured");
    }
    return buildGithubCommandEnvironment(githubToken);
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
 * Performs run command.
 * @param command Command value.
 * @param arguments_ Arguments value.
 * @param options Operation options.
 * @returns Run command result.
 */
export async function runCommand(
    command: string,
    arguments_: string[],
    options: {
        cwd?: string;
        environment?: NodeJS.ProcessEnv;
        signal?: AbortSignal;
        timeoutMs?: number;
    } = {}
): Promise<CommandResult> {
    const { code, stderr, stdout } = await runProcess(command, arguments_, {
        cwd: options.cwd || getDashboardRoot(),
        env: options.environment || buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal: options.signal,
        timeoutMs: options.timeoutMs || 120_000,
    });
    if (code !== 0) {
        throw new Error(
            `${command} ${arguments_.join(" ")} failed with exit code ${code}: ${
                stderr.trim() || stdout.trim()
            }`
        );
    }

    return {
        stdout: trimOutput(String(stdout || "")),
        stderr: trimOutput(String(stderr || "")),
    };
}

/**
 * Runs a GitHub CLI command and parses its JSON output.
 * @param arguments_ Arguments value.
 * @param parser Runtime value parser.
 * @param signal Signal used to cancel the operation.
 * @param timeoutMs Maximum command runtime.
 * @returns Promise resolving to the run gh json result.
 */
export async function runGhJson<T>(
    arguments_: string[],
    parser: ContractParser<T>,
    signal?: AbortSignal,
    timeoutMs = 60_000
): Promise<T> {
    const { code, stderr, stdout } = await runProcess("gh", arguments_, {
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal,
        timeoutMs,
    });
    if (code !== 0) {
        throw new Error(
            `gh ${arguments_.join(" ")} failed with exit code ${code}: ${
                stderr.trim() || stdout.trim()
            }`
        );
    }
    const output = stdout.trim();
    if (!output) {
        throw new Error("GitHub CLI returned an empty JSON response");
    }
    return parser(JSON.parse(output));
}

class GitHubRestApiError extends Error {
    readonly endpoint: string;
    readonly statusCode: number | undefined;

    constructor(endpoint: string, statusCode: number | undefined, message: string) {
        super(message);
        this.name = "GitHubRestApiError";
        this.endpoint = endpoint;
        this.statusCode = statusCode;
    }
}

function parseIncludedGitHubResponse(output: string): {
    body: string;
    statusCode?: number;
} {
    const normalizedOutput = output.replaceAll("\r\n", "\n").trim();
    const statusMatch = /^HTTP\/\S+\s+(\d{3})[^\n]*\n/u.exec(normalizedOutput);
    if (!statusMatch) return { body: normalizedOutput };
    const bodySeparator = normalizedOutput.indexOf("\n\n", statusMatch[0].length);
    if (bodySeparator === -1) {
        throw new Error("GitHub CLI included response was missing its body separator");
    }
    return {
        body: normalizedOutput.slice(bodySeparator + 2).trim(),
        statusCode: Number(statusMatch[1]),
    };
}

/**
 * Runs one REST API request with `gh --include` so capability decisions use the
 * HTTP status line rather than mutable CLI error prose.
 * @param arguments_ GitHub CLI arguments, including `--include`.
 * @param endpoint REST endpoint used to scope capability errors.
 * @param parser Runtime value parser.
 * @param signal Signal used to cancel the operation.
 * @returns Parsed GitHub REST response.
 */
export async function runGhRestJson<T>(
    arguments_: string[],
    endpoint: string,
    parser: ContractParser<T>,
    signal?: AbortSignal
): Promise<T> {
    const { code, stderr, stdout } = await runProcess("gh", arguments_, {
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal,
        timeoutMs: 60_000,
    });
    const response = parseIncludedGitHubResponse(stdout);
    if (code !== 0 || (response.statusCode !== undefined && response.statusCode >= 400)) {
        throw new GitHubRestApiError(
            endpoint,
            response.statusCode,
            `GitHub API ${endpoint} failed${
                response.statusCode === undefined
                    ? ` with exit code ${code}`
                    : ` with status ${response.statusCode}`
            }: ${stderr.trim() || response.body || "GitHub CLI returned no result"}`
        );
    }
    if (!response.body) {
        throw new Error("GitHub CLI returned an empty JSON response");
    }
    return parser(JSON.parse(response.body));
}

/**
 * Runs a GitHub API command whose documented terminal error states use JSON bodies.
 * @param arguments_ GitHub CLI arguments.
 * @param parser Runtime value parser.
 * @param signal Signal used to cancel the operation.
 * @param timeoutMs Maximum command runtime.
 * @returns Parsed GitHub response, including a documented non-2xx result body.
 */
export async function runGhJsonWithResultBody<T>(
    arguments_: string[],
    parser: ContractParser<T>,
    signal?: AbortSignal,
    timeoutMs = 60_000
): Promise<T> {
    const { code, stderr, stdout } = await runProcess("gh", arguments_, {
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal,
        timeoutMs,
    });
    const output = stdout.trim();
    if (output) {
        try {
            return parser(JSON.parse(output));
        } catch (error) {
            if (code === 0) throw error;
        }
    }
    throw new Error(
        `gh ${arguments_.join(" ")} failed with exit code ${code}: ${
            stderr.trim() || output || "GitHub CLI returned no result"
        }`
    );
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
 * Appends one GitHub JSON-lines output row after size and blank-line validation.
 * @param line Line value.
 * @param rows Rows value.
 * @param parser Runtime value parser.
 */
function parseGhJsonLine<T>(line: string, rows: T[], parser: ContractParser<T>): void {
    if (!line.trim()) {
        return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_LENGTH) {
        throw new Error("GitHub CLI JSON line was too large");
    }
    rows.push(parser(JSON.parse(line)));
}

function toGhJsonParseError(error: unknown): Error {
    return error instanceof Error
        ? error
        : new Error(errorMessage(error, "Failed to parse GitHub CLI output"));
}

function clearForceKillTimerIfAllowed(
    forceKillTimer: NodeJS.Timeout | undefined,
    options: { keepForceKillTimer?: boolean },
    shouldPreserveForceKillTimer: boolean,
    clearTimer: (timer: NodeJS.Timeout) => void = clearTimeout
): NodeJS.Timeout | undefined {
    if (!forceKillTimer || shouldPreserveForceKillTimer || options.keepForceKillTimer) {
        return forceKillTimer;
    }
    clearTimer(forceKillTimer);
    return undefined;
}

/**
 * Streams newline-delimited JSON values from a GitHub CLI command.
 * @param arguments_ Arguments value.
 * @param parser Runtime value parser.
 * @param options Operation options.
 * @returns Promise resolving to the run gh json lines result.
 */
async function runGhJsonLines<T>(
    arguments_: string[],
    parser: ContractParser<T>,
    options: { timeoutMs?: number } = {}
): Promise<T[]> {
    return new Promise((resolve, reject) => {
        const child = spawnProcess("gh", arguments_, {
            cwd: getDashboardRoot(),
            env: buildCommandEnvironment(),
        });
        const rows: T[] = [];
        let stdoutBuffer = "";
        let stderr = "";
        let isSettled = false;
        let forceKillTimer: NodeJS.Timeout | undefined;
        let isPreserveForceKillTimer = false;
        const terminateGhProcess = (signal: NodeJS.Signals) => {
            try {
                killProcessGroup(child, signal);
            } catch {
                // The process may already have exited or the process group may be gone.
            }
        };
        const armForceKillTimer = () => {
            if (forceKillTimer) {
                return;
            }

            forceKillTimer = setTimeout(() => {
                terminateGhProcess("SIGKILL");
            }, 5000);
            forceKillTimer.unref();
        };
        const timeout = setTimeout(() => {
            terminateGhProcess("SIGTERM");
            armForceKillTimer();
            isPreserveForceKillTimer = true;
            settle(() => reject(new Error("GitHub CLI command timed out")), {
                keepForceKillTimer: true,
            });
        }, options.timeoutMs || 60_000);

        const settle = (
            callback: () => void,
            options: { keepForceKillTimer?: boolean } = {}
        ) => {
            if (isSettled) {
                isPreserveForceKillTimer ||= Boolean(options.keepForceKillTimer);
                forceKillTimer = clearForceKillTimerIfAllowed(
                    forceKillTimer,
                    options,
                    isPreserveForceKillTimer
                );
                return;
            }
            isSettled = true;
            clearTimeout(timeout);
            isPreserveForceKillTimer ||= Boolean(options.keepForceKillTimer);
            forceKillTimer = clearForceKillTimerIfAllowed(
                forceKillTimer,
                options,
                isPreserveForceKillTimer
            );
            callback();
        };

        const stdoutDone = pipeProcessOutput(
            child.stdout as ReadableStream<Uint8Array> | undefined,
            (chunk) => {
                if (isSettled) return;
                stdoutBuffer += chunk;

                const lines = stdoutBuffer.split("\n");
                stdoutBuffer = lines.pop() || "";
                if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSON_LINE_LENGTH) {
                    terminateGhProcess("SIGTERM");
                    armForceKillTimer();
                    settle(
                        () => reject(new Error("GitHub CLI JSON line was too large")),
                        {
                            keepForceKillTimer: true,
                        }
                    );
                    return;
                }
                try {
                    for (const line of lines) {
                        if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_LENGTH) {
                            terminateGhProcess("SIGTERM");
                            armForceKillTimer();
                            settle(
                                () =>
                                    reject(
                                        new Error("GitHub CLI JSON line was too large")
                                    ),
                                {
                                    keepForceKillTimer: true,
                                }
                            );
                            return;
                        }
                        parseGhJsonLine(line, rows, parser);
                    }
                } catch (error) {
                    terminateGhProcess("SIGTERM");
                    armForceKillTimer();
                    settle(() => reject(toGhJsonParseError(error)), {
                        keepForceKillTimer: true,
                    });
                }
            }
        );

        const stderrDone = pipeProcessOutput(
            child.stderr as ReadableStream<Uint8Array> | undefined,
            (chunk) => {
                if (isSettled) return;
                stderr = trimOutput(stderr + chunk);
            }
        );

        void (async () => {
            try {
                const code = await child.exited;
                await Promise.all([stdoutDone, stderrDone]);
                isPreserveForceKillTimer = false;
                forceKillTimer = clearForceKillTimerIfAllowed(forceKillTimer, {}, false);
                settle(() => {
                    if (code !== 0) {
                        reject(
                            new Error(stderr || `GitHub CLI exited with code ${code}`)
                        );
                        return;
                    }
                    try {
                        parseGhJsonLine(stdoutBuffer, rows, parser);
                        resolve(rows);
                    } catch (error) {
                        reject(toGhJsonParseError(error));
                    }
                });
            } catch (error) {
                isPreserveForceKillTimer = false;
                forceKillTimer = clearForceKillTimerIfAllowed(forceKillTimer, {}, false);
                settle(() =>
                    reject(
                        error instanceof Error
                            ? error
                            : new Error("GitHub CLI request failed", { cause: error })
                    )
                );
            }
        })();
    });
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

/**
 * Parses Git worktrees.
 * @param output Output value.
 * @returns Parsed Git worktrees.
 */
