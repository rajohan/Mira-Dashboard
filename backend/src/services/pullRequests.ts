import { rm } from "node:fs/promises";
import path from "node:path";

import { database, miraDatabasePath } from "../database.ts";
import { errorMessage } from "../lib/errors.ts";
import { pipeProcessOutput, runProcess, spawnProcess } from "../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../lib/values.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

function resolveConfiguredRoot(environmentName: string, fallback: string): string {
    const rawValue = nonEmptyEnvironmentFallback(environmentName, fallback).trim();
    if (!path.isAbsolute(rawValue)) {
        throw new Error(`${environmentName} must be an absolute non-root path`);
    }
    const value = path.resolve(rawValue);
    if (value === path.parse(value).root) {
        throw new Error(`${environmentName} must be an absolute non-root path`);
    }
    return value;
}

const DASHBOARD_REPO = "rajohan/Mira-Dashboard";
const DASHBOARD_SERVICE = "mira-dashboard.service";
const DEFAULT_REVIEWER_AUTHOR = "rajohan";
const DEFAULT_BASE = "main";
const DEPLOYMENT_LOCK_STALE_MS = 30 * 60 * 1000;
const RECENT_DEPLOYMENTS_LIMIT = 10;
const MAX_BUFFER = 20 * 1024 * 1024;
const MAX_JSON_LINE_LENGTH = 1024 * 1024;
const PR_LIST_TIMEOUT_MS = 180_000;
const PASSING_CHECK_VALUES = new Set(["success", "successful", "neutral", "skipped"]);
const OPINIONATED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const ACTIVE_DEPLOYMENT_STATUSES = new Set(["building", "restart-scheduled"]);
const BUN_EXECUTABLE = process.env.BUN_BINARY || "bun";

function resolveExecutableFromPath(executable: string): string | null {
    if (path.isAbsolute(executable)) {
        return executable;
    }
    if (executable.includes(path.sep)) {
        return path.resolve(executable);
    }

    return Bun.which(executable);
}

function resolveBunExecutable(): string {
    const resolved = resolveExecutableFromPath(BUN_EXECUTABLE);
    if (resolved) {
        return resolved;
    }
    return BUN_EXECUTABLE === "bun" ? process.execPath : BUN_EXECUTABLE;
}

export function getResolvedRoots() {
    return {
        dashboardRoot: getDashboardRoot(),
        dashboardWorktreeRoot: getDashboardWorktreeRoot(),
    };
}

function getDashboardRoot(): string {
    return resolveConfiguredRoot(
        "MIRA_DASHBOARD_ROOT",
        "/home/ubuntu/projects/mira-dashboard"
    );
}

function getDashboardWorktreeRoot(): string {
    return resolveConfiguredRoot(
        "MIRA_DASHBOARD_WORKTREE_ROOT",
        "/home/ubuntu/projects/mira-dashboard-worktrees"
    );
}

/** Represents command result. */
interface CommandResult {
    stdout: string;
    stderr: string;
}

/** Represents pull request author. */
interface PullRequestAuthor {
    login?: string;
    name?: string;
}

/** Represents pull request summary. */
interface PullRequestSummary {
    number: number;
    title: string;
    body?: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    author: PullRequestAuthor;
    createdAt: string;
    updatedAt: string;
    isDraft: boolean;
    headRefOid?: string;
    mergeable?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    reviewerApproved?: boolean;
    canReviewerApprove?: boolean;
    latestOpinionatedReviews?: PullRequestReviewConnection;
    reviews?: PullRequestReview[];
    statusCheckRollup?: unknown[];
    additions?: number;
    deletions?: number;
    changedFiles?: number;
}

/** Represents a pull request review. */
interface PullRequestReview {
    state?: string;
    submittedAt?: string;
    author?: PullRequestAuthor;
}

/** Represents a pull request review connection. */
interface PullRequestReviewConnection {
    nodes?: PullRequestReview[];
}

/** Represents deployment job. */
interface DeploymentJob {
    id: string;
    status: "building" | "restart-scheduled" | "isOk" | "failed";
    startedAt: string;
    updatedAt: string;
    commit?: string;
    commitTitle?: string;
    commitUrl?: string;
    note?: string;
    stdout?: string;
    stderr?: string;
}

/** Represents production checkout status. */
interface ProductionCheckoutStatus {
    root: string;
    expectedRoot: string;
    worktreeRoot: string;
    branch: string;
    expectedBranch: string;
    head: string;
    upstream?: string;
    isClean: boolean;
    isProductionRoot: boolean;
    isSafeForDeploy: boolean;
    statusShort?: string;
}

/** Represents Git worktree. */
interface GitWorktree {
    path: string;
    branch?: string;
    head?: string;
}

/** Represents worktree cleanup result. */
interface WorktreeCleanupResult {
    status: "removed" | "skipped" | "warning";
    branch: string;
    path?: string;
    message: string;
}

/** Performs write deployment job. */
function writeDeploymentJob(job: DeploymentJob): void {
    database
        .prepare(
            `
        INSERT INTO deployment_jobs (
            id,
            status,
            started_at,
            updated_at,
            commit_sha,
            commit_title,
            note,
            stdout,
            stderr
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            started_at = excluded.started_at,
            updated_at = excluded.updated_at,
            commit_sha = excluded.commit_sha,
            commit_title = excluded.commit_title,
            note = excluded.note,
            stdout = excluded.stdout,
            stderr = excluded.stderr
        `
        )
        .run(
            job.id,
            job.status,
            job.startedAt,
            job.updatedAt,
            job.commit ?? null,
            job.commitTitle ?? null,
            job.note ?? null,
            job.stdout ?? null,
            job.stderr ?? null
        );
}

interface DeploymentJobRow {
    id: string;
    status: DeploymentJob["status"];
    started_at: string;
    updated_at: string;
    commit_sha: string | null;
    commit_title: string | null;
    note: string | null;
    stdout: string | null;
    stderr: string | null;
}

function mapDeploymentJob(row: DeploymentJobRow): DeploymentJob {
    const commit = row.commit_sha ?? undefined;
    return {
        id: row.id,
        status: row.status,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        commit,
        commitTitle: row.commit_title ?? undefined,
        commitUrl: commit
            ? `https://github.com/${DASHBOARD_REPO}/commit/${encodeURIComponent(commit)}`
            : undefined,
        note: row.note ?? undefined,
        stdout: row.stdout ?? undefined,
        stderr: row.stderr ?? undefined,
    };
}

/** Reads one deployment job. */
function readDeploymentJob(jobId: string): DeploymentJob | undefined {
    const row = database
        .prepare(
            `
            SELECT
                id,
                status,
                started_at,
                updated_at,
                commit_sha,
                commit_title,
                note,
                stdout,
                stderr
            FROM deployment_jobs
            WHERE id = ?
            `
        )
        .get(jobId) as DeploymentJobRow | undefined;
    return row ? mapDeploymentJob(row) : undefined;
}

/** Checks whether an active deployment lock is stale enough to replace. */
function isDeploymentJobStale(job: DeploymentJob, now = Date.now()): boolean {
    const updatedAt = Date.parse(job.updatedAt || job.startedAt);
    if (!Number.isFinite(updatedAt)) {
        return true;
    }
    return now - updatedAt > DEPLOYMENT_LOCK_STALE_MS;
}

interface DeploymentLockRow {
    job_id: string;
    updated_at: string;
}

/** Checks whether an active deployment lock row is stale enough to replace. */
function isDeploymentLockStale(lock: DeploymentLockRow, now = Date.now()): boolean {
    const updatedAt = Date.parse(lock.updated_at);
    if (!Number.isFinite(updatedAt)) {
        return true;
    }
    return now - updatedAt > DEPLOYMENT_LOCK_STALE_MS;
}

/** Reads the active deployment lock. */
function readDeploymentLockRow(): DeploymentLockRow | undefined {
    return database
        .prepare("SELECT job_id, updated_at FROM deployment_lock WHERE id = 1")
        .get() as DeploymentLockRow | undefined;
}

/** Releases the active deploy lock if it still belongs to the given job. */
function releaseDeploymentLock(jobId: string): void {
    try {
        database
            .prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?")
            .run(jobId);
    } catch {
        // Best-effort cleanup; stale locks are validated before starting deploys.
    }
}

/** Ensures no active deploy owns the production checkout. */
function ensureNoActiveDeployment(): void {
    const activeLock = readDeploymentLockRow();
    const activeJobId = activeLock?.job_id;
    if (activeJobId) {
        const activeJob = readDeploymentJob(activeJobId);
        if (!activeJob) {
            if (!isDeploymentLockStale(activeLock)) {
                throw new Error(`Dashboard deploy already in progress (${activeJobId})`);
            }
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
        } else if (
            ACTIVE_DEPLOYMENT_STATUSES.has(activeJob.status) &&
            !isDeploymentJobStale(activeJob)
        ) {
            throw new Error(`Dashboard deploy already in progress (${activeJob.id})`);
        } else {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
        }
    }
}

/** Acquires the active deploy lock for a new deployment job. */
function acquireDeploymentLock(jobId: string): void {
    ensureNoActiveDeployment();
    try {
        database
            .prepare(
                "INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)"
            )
            .run(jobId, dateToISOString(new Date()));
    } catch (error) {
        if (error instanceof Error && /constraint/i.test(error.message)) {
            throw new Error("Dashboard deploy already in progress", {
                cause: error,
            });
        }
        throw error;
    }
}

/** Refreshes the active deploy heartbeat while long-running work continues. */
function refreshDeploymentHeartbeat(job: DeploymentJob): DeploymentJob {
    const updatedJob = { ...job, updatedAt: dateToISOString(new Date()) };
    writeDeploymentJob(updatedJob);
    database
        .prepare("UPDATE deployment_lock SET updated_at = ? WHERE id = 1 AND job_id = ?")
        .run(updatedJob.updatedAt, updatedJob.id);
    return updatedJob;
}

/** Performs read deployment jobs. */
export function readDeploymentJobs(): DeploymentJob[] {
    return (
        database
            .prepare(
                `
                SELECT
                    id,
                    status,
                    started_at,
                    updated_at,
                    commit_sha,
                    commit_title,
                    note,
                    stdout,
                    stderr
                FROM deployment_jobs
                ORDER BY updated_at DESC
                LIMIT ?
                `
            )
            .all(RECENT_DEPLOYMENTS_LIMIT) as unknown as DeploymentJobRow[]
    ).map(mapDeploymentJob);
}

/** Performs trim output. */
function trimOutput(value: string): string {
    return value.slice(-20_000);
}

/** Splits an owner/name GitHub repository identifier. */
function parseRepoParts(repo: string): { owner: string; name: string } {
    const parts = repo.split("/");
    const [owner, name] = parts;
    if (parts.length !== 2 || !owner || !name) {
        throw new Error("Dashboard repository must be configured as owner/name");
    }
    return { owner, name };
}

/** Builds GitHub command environment for one token. */
function buildGithubCommandEnvironment(githubToken: string): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
        if (
            key === "MIRA_GITHUB_TOKEN" ||
            key.startsWith("MIRA_GITHUB_TOKEN_") ||
            key === "RAJOHAN_GITHUB_TOKEN" ||
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

/** Builds command environment. */
function buildCommandEnvironment(): NodeJS.ProcessEnv {
    const githubToken =
        process.env.MIRA_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim() ||
        "";
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

/** Builds reviewer command environment. */
function buildReviewCommandEnvironment(): NodeJS.ProcessEnv {
    const githubToken = process.env.RAJOHAN_GITHUB_TOKEN?.trim() || "";
    if (!githubToken) {
        throw new Error("Rajohan GitHub review token is not configured");
    }
    return buildGithubCommandEnvironment(githubToken);
}

/** Returns the configured reviewer author. */
function reviewerAuthor(): string {
    return process.env.RAJOHAN_GITHUB_USERNAME?.trim() || DEFAULT_REVIEWER_AUTHOR;
}

/** Returns whether the configured reviewer has approved the pull request. */
function hasReviewerApproval(pr: PullRequestSummary): boolean {
    const author = reviewerAuthor();
    const reviews = (
        pr.latestOpinionatedReviews?.nodes?.length
            ? pr.latestOpinionatedReviews.nodes
            : pr.reviews || []
    ).filter(
        (review) =>
            review.author?.login === author &&
            OPINIONATED_REVIEW_STATES.has(review.state?.toUpperCase() || "")
    );
    const latestReview = reviews.sort((a, b) =>
        String(b.submittedAt || "").localeCompare(String(a.submittedAt || ""))
    )[0];
    return latestReview?.state?.toUpperCase() === "APPROVED";
}

/** Returns whether the pull request has a dashboard-accepted review approval. */
function isPullRequestReviewApproved(pr: PullRequestSummary): boolean {
    return (
        pr.reviewDecision?.toUpperCase() === "APPROVED" ||
        pr.reviewerApproved === true ||
        hasReviewerApproval(pr)
    );
}

/** Returns whether the configured reviewer can approve the pull request. */
function canReviewerApprove(pr: PullRequestSummary): boolean {
    return (
        pr.author?.login !== reviewerAuthor() &&
        !pr.isDraft &&
        !isPullRequestReviewApproved(pr)
    );
}

/** Normalizes pull request metadata for the dashboard API. */
function normalizePullRequest(pr: PullRequestSummary): PullRequestSummary {
    const rest = { ...pr };
    delete rest.latestOpinionatedReviews;
    delete rest.reviews;

    return {
        ...rest,
        reviewerApproved: isPullRequestReviewApproved(pr),
        canReviewerApprove: canReviewerApprove(pr),
    };
}

/** Performs run command. */
async function runCommand(
    command: string,
    arguments_: string[],
    options: {
        cwd?: string;
        environment?: NodeJS.ProcessEnv;
        timeoutMs?: number;
    } = {}
): Promise<CommandResult> {
    const { stdout, stderr } = await runProcess(command, arguments_, {
        cwd: options.cwd || getDashboardRoot(),
        env: options.environment || buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs || 120_000,
    });

    return {
        stdout: trimOutput(String(stdout || "")),
        stderr: trimOutput(String(stderr || "")),
    };
}

/** Runs a GitHub CLI command and parses its JSON output. */
async function runGhJson<T>(arguments_: string[]): Promise<T> {
    const { stdout } = await runProcess("gh", arguments_, {
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        timeout: 60_000,
    });
    return JSON.parse(String(stdout || "null")) as T;
}

/** Appends one GitHub JSON-lines output row after size and blank-line validation. */
function parseGhJsonLine<T>(line: string, rows: T[]): void {
    if (!line.trim()) {
        return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_LENGTH) {
        throw new Error("GitHub CLI JSON line was too large");
    }
    rows.push(JSON.parse(line) as T);
}

function toGhJsonParseError(error: unknown): Error {
    return error instanceof Error
        ? error
        : new Error(errorMessage(error, "Failed to parse GitHub CLI output"));
}

function clearForceKillTimerIfAllowed(
    forceKillTimer: NodeJS.Timeout | null,
    options: { keepForceKillTimer?: boolean },
    shouldPreserveForceKillTimer: boolean,
    clearTimer: (timer: NodeJS.Timeout) => void = clearTimeout
): NodeJS.Timeout | null {
    if (!forceKillTimer || options.keepForceKillTimer || shouldPreserveForceKillTimer) {
        return forceKillTimer;
    }
    clearTimer(forceKillTimer);
    return null;
}

/** Streams newline-delimited JSON values from a GitHub CLI command. */
async function runGhJsonLines<T>(
    arguments_: string[],
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
        let forceKillTimer: NodeJS.Timeout | null = null;
        let isPreserveForceKillTimer = false;
        const armForceKillTimer = () => {
            if (forceKillTimer) {
                return;
            }

            forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
            forceKillTimer.unref();
        };
        const timeout = setTimeout(() => {
            child.kill("SIGTERM");
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

        void pipeProcessOutput(
            child.stdout as ReadableStream<Uint8Array> | undefined,
            (chunk) => {
                stdoutBuffer += chunk;

                const lines = stdoutBuffer.split("\n");
                stdoutBuffer = lines.pop() || "";
                if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSON_LINE_LENGTH) {
                    child.kill("SIGTERM");
                    armForceKillTimer();
                    settle(
                        () => reject(new Error("GitHub CLI JSON line was too large")),
                        {
                            keepForceKillTimer: true,
                        }
                    );
                } else {
                    try {
                        for (const line of lines) {
                            parseGhJsonLine(line, rows);
                        }
                    } catch (error) {
                        child.kill("SIGTERM");
                        armForceKillTimer();
                        settle(() => reject(toGhJsonParseError(error)), {
                            keepForceKillTimer: true,
                        });
                    }
                }
            }
        );

        void pipeProcessOutput(
            child.stderr as ReadableStream<Uint8Array> | undefined,
            (chunk) => {
                stderr = trimOutput(stderr + chunk);
            }
        );

        void child.exited
            .then((code) => {
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
                        parseGhJsonLine(stdoutBuffer, rows);
                        resolve(rows);
                    } catch (error) {
                        reject(toGhJsonParseError(error));
                    }
                });
            })
            .catch((error: unknown) => {
                isPreserveForceKillTimer = false;
                forceKillTimer = clearForceKillTimerIfAllowed(forceKillTimer, {}, false);
                settle(() => reject(error));
            });
    });
}

/** Lists open pull requests targeting the dashboard production branch. */
export async function listDashboardPullRequests(): Promise<PullRequestSummary[]> {
    const repo = parseRepoParts(DASHBOARD_REPO);
    const pullRequests = await runGhJsonLines<PullRequestSummary>(
        [
            "api",
            "graphql",
            "--paginate",
            "-F",
            `owner=${repo.owner}`,
            "-F",
            `name=${repo.name}`,
            "-f",
            `query=query($owner: String!, $name: String!, $endCursor: String) {
            repository(owner: $owner, name: $name) {
                pullRequests(
                    first: 100
                    after: $endCursor
                    states: OPEN
                    baseRefName: "${DEFAULT_BASE}"
                    orderBy: { field: UPDATED_AT, direction: DESC }
                ) {
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                    nodes {
                        number
                        title
                        body
                        url
                        headRefName
                        headRefOid
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
                }
            }
        }`,
            "--jq",
            [
                ".data.repository.pullRequests.nodes[]",
                "| .statusCheckRollup = (if .statusCheckRollup.state then [{status: .statusCheckRollup.state}] else [] end)",
            ].join(" "),
        ],
        { timeoutMs: PR_LIST_TIMEOUT_MS }
    );

    const refreshedPullRequests = await Promise.all(
        pullRequests.map(async (pr) => {
            if (!shouldRefreshBlockedMergeState(pr)) {
                return normalizePullRequest(pr);
            }

            try {
                return normalizePullRequest(await getPullRequest(pr.number));
            } catch {
                return normalizePullRequest(pr);
            }
        })
    );

    return refreshedPullRequests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Returns whether a blocked list state should be verified with fresh PR details. */
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

/** Returns the current GitHub metadata for one pull request. */
async function getPullRequest(number: number): Promise<PullRequestSummary> {
    return normalizePullRequest(
        await runGhJson<PullRequestSummary>([
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
        ])
    );
}

/** Validates pr number. */
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

/** Parses Git worktrees. */
function parseGitWorktrees(output: string): GitWorktree[] {
    return output
        .trim()
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((block) => {
            const worktree: GitWorktree = { path: "" };
            for (const line of block.split("\n")) {
                if (line.startsWith("worktree ")) {
                    worktree.path = line.slice("worktree ".length);
                }
                if (line.startsWith("HEAD ")) {
                    worktree.head = line.slice("HEAD ".length);
                }
                if (line.startsWith("branch ")) {
                    worktree.branch = line.slice("branch ".length);
                }
            }
            return worktree;
        })
        .filter((worktree) => worktree.path);
}

/** Returns whether a path is strictly inside the configured worktree root. */
function isPathInsideRoot(value: string, root: string): boolean {
    const resolvedValue = path.resolve(value);
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedValue);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Performs find worktree for branch. */
async function findWorktreeForBranch(branch: string): Promise<GitWorktree | null> {
    const { stdout } = await runCommand("git", ["worktree", "list", "--porcelain"], {
        timeoutMs: 30_000,
    });
    const expectedReference = `refs/heads/${branch}`;
    return (
        parseGitWorktrees(stdout).find(
            (worktree) =>
                worktree.branch === expectedReference || worktree.branch === branch
        ) || null
    );
}

/** Performs cleanup pull request worktree. */
async function cleanupPullRequestWorktree(
    branch: string
): Promise<WorktreeCleanupResult> {
    try {
        const worktree = await findWorktreeForBranch(branch);
        if (!worktree) {
            return {
                status: "skipped",
                branch,
                message: `No local worktree found for ${branch}`,
            };
        }

        const worktreePath = path.resolve(worktree.path);
        const dashboardWorktreeRoot = getDashboardWorktreeRoot();
        if (!isPathInsideRoot(worktreePath, dashboardWorktreeRoot)) {
            return {
                status: "warning",
                branch,
                path: worktreePath,
                message: `Skipped cleanup for ${branch}; worktree path is outside ${dashboardWorktreeRoot}`,
            };
        }

        const { stdout: status } = await runCommand(
            "git",
            ["-C", worktreePath, "status", "--short"],
            { timeoutMs: 30_000 }
        );
        if (status.trim()) {
            return {
                status: "warning",
                branch,
                path: worktreePath,
                message: `Skipped cleanup for ${branch}; worktree has local changes`,
            };
        }

        await runCommand("git", ["worktree", "remove", worktreePath], {
            timeoutMs: 60_000,
        });

        return {
            status: "removed",
            branch,
            path: worktreePath,
            message: `Removed local worktree for ${branch}`,
        };
    } catch (error) {
        return {
            status: "warning",
            branch,
            message: `Worktree cleanup warning for ${branch}: ${errorMessage(error, branch)}`,
        };
    }
}

/** Validates a pull request can be managed from the dashboard. */
function validateDashboardPr(pr: PullRequestSummary): void {
    if (pr.baseRefName !== DEFAULT_BASE) {
        throw new Error(
            `Only ${DEFAULT_BASE}-targeted pull requests can be managed here`
        );
    }

    if (pr.isDraft) {
        throw new Error("Draft pull requests cannot be approved from the dashboard");
    }
}

/** Validates a pull request can be updated with the latest base branch. */
function validateDashboardPrForBranchUpdate(pr: PullRequestSummary): void {
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
function validateDashboardPrForApproval(pr: PullRequestSummary): void {
    validateDashboardPr(pr);
    if (!hasPullRequestChecksPassed(pr.statusCheckRollup)) {
        throw new Error("Pull request CI checks must pass before approval");
    }
    if (!isPullRequestReviewApproved(pr)) {
        throw new Error("Pull request review approval is required before merging");
    }
}

/** Validates a pull request can receive Rajohan's review approval. */
function validateDashboardPrForReviewApproval(pr: PullRequestSummary): void {
    validateDashboardPr(pr);
    if (pr.author?.login === reviewerAuthor()) {
        throw new Error("Rajohan cannot approve his own pull request");
    }
    if (isPullRequestReviewApproved(pr)) {
        throw new Error("Pull request is already approved");
    }
}

/** Returns whether pull request checks are conclusively passing. */
function hasPullRequestChecksPassed(checks: unknown[] | undefined): boolean {
    const records = (checks || []).filter(
        (check): check is Record<string, unknown> =>
            Boolean(check) && typeof check === "object" && !Array.isArray(check)
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

/** Normalizes a GitHub check status or conclusion. */
function normalizedCheckValue(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
}

/** Returns production checkout status. */
export async function getProductionCheckoutStatus(): Promise<ProductionCheckoutStatus> {
    const [{ stdout: root }, { stdout: branch }, { stdout: head }, { stdout: status }] =
        await Promise.all([
            runCommand("git", ["rev-parse", "--show-toplevel"], {
                timeoutMs: 30_000,
            }),
            runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                timeoutMs: 30_000,
            }),
            runCommand("git", ["rev-parse", "--short", "HEAD"], {
                timeoutMs: 30_000,
            }),
            runCommand("git", ["status", "--short"], { timeoutMs: 30_000 }),
        ]);

    let upstream: string | undefined;
    try {
        const { stdout } = await runCommand(
            "git",
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            { timeoutMs: 30_000 }
        );
        upstream = stdout.trim() || undefined;
    } catch {
        upstream = undefined;
    }

    const productionRoot = root.trim();
    const dashboardRoot = getDashboardRoot();
    const dashboardWorktreeRoot = getDashboardWorktreeRoot();
    const currentBranch = branch.trim();
    const statusShort = status.trim();
    const isClean = statusShort.length === 0;
    const isProductionRoot = path.resolve(productionRoot) === path.resolve(dashboardRoot);

    return {
        root: productionRoot,
        expectedRoot: dashboardRoot,
        worktreeRoot: dashboardWorktreeRoot,
        branch: currentBranch,
        expectedBranch: DEFAULT_BASE,
        head: head.trim(),
        upstream,
        isClean,
        isProductionRoot,
        isSafeForDeploy: isClean && isProductionRoot && currentBranch === DEFAULT_BASE,
        statusShort: statusShort || undefined,
    };
}

/** Performs ensure production checkout. */
export async function ensureProductionCheckout(): Promise<void> {
    const status = await getProductionCheckoutStatus();

    if (!status.isProductionRoot) {
        throw new Error(
            `Expected production checkout at ${getDashboardRoot()}, got ${status.root}`
        );
    }

    if (!status.isClean) {
        throw new Error("Production checkout has local changes; refusing deploy/merge");
    }
}

/** Performs ensure production ready for deploy. */
export async function ensureProductionReadyForDeploy(): Promise<void> {
    const status = await getProductionCheckoutStatus();

    if (!status.isSafeForDeploy) {
        throw new Error(
            `Production checkout must be clean ${DEFAULT_BASE} before deploy; current branch=${status.branch}, clean=${status.isClean}`
        );
    }
}

/** Performs sync main. */
async function syncMain(): Promise<void> {
    await ensureProductionCheckout();
    await runCommand("git", ["fetch", "--prune", "origin"], { timeoutMs: 120_000 });
    await runCommand("git", ["checkout", DEFAULT_BASE], { timeoutMs: 60_000 });
    await runCommand("git", ["pull", "--ff-only", "origin", DEFAULT_BASE], {
        timeoutMs: 120_000,
    });
    await ensureProductionReadyForDeploy();
}

/** Performs shell quote. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Builds a shell command that records deployment status from a detached process. */
function deploymentJobUpdateCommand(job: DeploymentJob): string {
    const script = `
import { Database } from "bun:sqlite";
const job = JSON.parse(process.env.MIRA_DEPLOYMENT_JOB || "{}");
const database = new Database(process.env.MIRA_DEPLOYMENT_DB);
database.run("PRAGMA foreign_keys = ON");
database.run("PRAGMA busy_timeout = 5000");
try {
    database.run("BEGIN IMMEDIATE");
    database.prepare(\`
    INSERT INTO deployment_jobs (
        id,
        status,
        started_at,
        updated_at,
        commit_sha,
        commit_title,
        note,
        stdout,
        stderr
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        commit_sha = excluded.commit_sha,
        commit_title = excluded.commit_title,
        note = excluded.note,
        stdout = excluded.stdout,
        stderr = excluded.stderr
\`).run(
    job.id,
    job.status,
    job.startedAt,
    job.updatedAt,
    job.commit ?? null,
    job.commitTitle ?? null,
    job.note ?? null,
    job.stdout ?? null,
    job.stderr ?? null
);
    database.prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?").run(job.id);
    database.run("COMMIT");
} catch (error) {
    try {
        database.run("ROLLBACK");
    } catch {}
    throw error;
} finally {
    database.close();
}
`;
    return [
        `MIRA_DEPLOYMENT_DB=${shellQuote(miraDatabasePath)}`,
        `MIRA_DEPLOYMENT_JOB=${shellQuote(JSON.stringify(job))}`,
        shellQuote(resolveBunExecutable()),
        "-e",
        shellQuote(script),
    ].join(" ");
}

/** Performs schedule restart health check. */
async function scheduleRestartHealthCheck(job: DeploymentJob): Promise<CommandResult> {
    const okJob: DeploymentJob = {
        ...job,
        status: "isOk",
        updatedAt: dateToISOString(new Date()),
        note: "Restarted service and health check passed",
    };
    const failedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Restart was triggered, but health check failed",
    };

    const script = [
        "restart_status=0",
        `systemctl --user restart ${DASHBOARD_SERVICE} || restart_status=$?`,
        "sleep 4",
        'if [ "$restart_status" -eq 0 ] && curl -fsS http://127.0.0.1:3100/api/health >/dev/null; then',
        `  ${deploymentJobUpdateCommand(okJob)}`,
        "else",
        `  ${deploymentJobUpdateCommand(failedJob)}`,
        "fi",
    ].join("\n");

    return runCommand(
        "systemd-run",
        [
            "--user",
            `--unit=mira-dashboard-deploy-${job.id}`,
            "--description=Mira Dashboard deploy restart + health check",
            "/bin/bash",
            "-lc",
            script,
        ],
        { timeoutMs: 30_000 }
    );
}

/** Runs deployment work after the API has returned a job to the caller. */
async function runDeploymentJob(job: DeploymentJob): Promise<void> {
    let currentJob = job;
    const dashboardRoot = getDashboardRoot();
    try {
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await syncMain();
        currentJob = refreshDeploymentHeartbeat(currentJob);

        currentJob = refreshDeploymentHeartbeat(currentJob);
        await rm(path.join(dashboardRoot, "node_modules"), {
            force: true,
            recursive: true,
        });
        await runCommand("bun", ["install", "--frozen-lockfile"], {
            timeoutMs: 180_000,
        });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await runCommand("bun", ["run", "build"], { timeoutMs: 180_000 });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await rm(path.join(dashboardRoot, "backend", "node_modules"), {
            force: true,
            recursive: true,
        });
        await runCommand("bun", ["install", "--frozen-lockfile"], {
            cwd: path.join(dashboardRoot, "backend"),
            timeoutMs: 120_000,
        });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await runCommand("bun", ["run", "build"], {
            cwd: path.join(dashboardRoot, "backend"),
            timeoutMs: 120_000,
        });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const { stdout: commit } = await runCommand(
            "git",
            ["rev-parse", "--short", "HEAD"],
            {
                timeoutMs: 30_000,
            }
        );
        const { stdout: commitTitle } = await runCommand(
            "git",
            ["log", "-1", "--pretty=%s"],
            { timeoutMs: 30_000 }
        );
        currentJob = refreshDeploymentHeartbeat(currentJob);

        const restartScheduled: DeploymentJob = {
            ...currentJob,
            status: "restart-scheduled",
            updatedAt: dateToISOString(new Date()),
            commit: commit.trim(),
            commitTitle: commitTitle.trim(),
            note: "Build passed; restart + health check scheduled",
        };
        writeDeploymentJob(restartScheduled);
        await scheduleRestartHealthCheck(restartScheduled);
    } catch (error) {
        const failed: DeploymentJob = {
            ...currentJob,
            status: "failed",
            updatedAt: dateToISOString(new Date()),
            note: errorMessage(error, "Deploy failed"),
        };
        try {
            writeDeploymentJob(failed);
        } finally {
            releaseDeploymentLock(job.id);
        }
    }
}

/** Reports background deployment failures after the API response has returned. */
function reportBackgroundDeploymentError(error: unknown): void {
    console.error(
        "[pullRequestsRoutes] Background deploy failed:",
        errorMessage(error, "Deploy failed")
    );
}

async function runDeploymentJobAndReportErrors(
    job: DeploymentJob,
    runner = runDeploymentJob
): Promise<void> {
    try {
        await runner(job);
    } catch (error) {
        reportBackgroundDeploymentError(error);
    }
}

/** Starts deploy latest in the background. */
export function startDeployLatest(lockHeldBy?: string): DeploymentJob {
    const now = dateToISOString(new Date());
    const job: DeploymentJob = {
        id: Bun.randomUUIDv7(),
        status: "building",
        startedAt: now,
        updatedAt: now,
        note: "Deploy started",
    };
    if (lockHeldBy) {
        const result = database
            .prepare(
                "UPDATE deployment_lock SET job_id = ?, updated_at = ? WHERE id = 1 AND job_id = ?"
            )
            .run(job.id, now, lockHeldBy);
        if (result.changes !== 1) {
            throw new Error("Dashboard deploy lock handoff failed");
        }
    } else {
        acquireDeploymentLock(job.id);
    }
    try {
        writeDeploymentJob(job);
        void runDeploymentJobAndReportErrors(job);
        return job;
    } catch (error) {
        releaseDeploymentLock(job.id);
        if (lockHeldBy) {
            releaseDeploymentLock(lockHeldBy);
        }
        throw error;
    }
}

/** Performs approve pull request. */
export async function approvePullRequest(number: number, willDeploy: boolean) {
    await ensureProductionCheckout();
    const pr = await getPullRequest(number);
    validateDashboardPrForApproval(pr);
    const lockId = `approve-${Bun.randomUUIDv7()}`;
    acquireDeploymentLock(lockId);
    let isReleaseLock = true;

    let syncError: string | undefined;
    let deployError: string | undefined;
    let deployment: DeploymentJob | undefined;
    let cleanup: WorktreeCleanupResult;

    try {
        await runCommand(
            "gh",
            [
                "pr",
                "merge",
                String(number),
                "--squash",
                "--delete-branch",
                "--repo",
                DASHBOARD_REPO,
            ],
            { timeoutMs: 120_000 }
        );
        cleanup = await cleanupPullRequestWorktree(pr.headRefName);

        try {
            await syncMain();
        } catch (error) {
            syncError = errorMessage(error, "Failed to sync main after merge");
        }

        if (willDeploy && !syncError) {
            try {
                deployment = startDeployLatest(lockId);
                isReleaseLock = false;
            } catch (error) {
                deployError = errorMessage(error, "Deploy failed to start");
            }
        }
    } finally {
        if (isReleaseLock) {
            releaseDeploymentLock(lockId);
        }
    }

    return {
        isOk: true,
        message: syncError
            ? `PR #${number} merged; production sync failed`
            : deployError
              ? `PR #${number} merged; deploy failed to start`
              : willDeploy
                ? `PR #${number} merged; deploy started`
                : `PR #${number} merged`,
        deployment,
        deployError,
        cleanup,
        syncError,
    };
}

/** Performs approve pull request review. */
export async function approvePullRequestReview(number: number) {
    const pr = await getPullRequest(number);
    validateDashboardPrForReviewApproval(pr);

    await runCommand(
        "gh",
        ["pr", "review", String(number), "--approve", "--repo", DASHBOARD_REPO],
        { environment: buildReviewCommandEnvironment(), timeoutMs: 60_000 }
    );

    const pullRequest = await getPullRequest(number);

    return {
        isOk: true,
        message: `PR #${number} review approved`,
        pullRequest,
    };
}

/** Updates one pull request branch with the latest base branch. */
export async function updatePullRequestBranch(number: number) {
    const pr = await getPullRequest(number);
    validateDashboardPrForBranchUpdate(pr);
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

    await runCommand("gh", arguments_, { timeoutMs: 60_000 });

    return {
        isOk: true,
        message: `PR #${number} branch update started`,
        pullRequest: await getPullRequest(number),
    };
}

/** Performs reject pull request. */
export async function rejectPullRequest(number: number, comment: string) {
    const pr = await getPullRequest(number);
    validateDashboardPr(pr);

    await runCommand(
        "gh",
        ["pr", "close", String(number), "--repo", DASHBOARD_REPO, "--comment", comment],
        { timeoutMs: 60_000 }
    );
    const cleanup = await cleanupPullRequestWorktree(pr.headRefName);

    return {
        isOk: true,
        message: `PR #${number} closed`,
        cleanup,
    };
}
