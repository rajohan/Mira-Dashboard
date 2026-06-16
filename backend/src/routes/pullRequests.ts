import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";

import { db, miraDbPath } from "../db.js";
import { asyncRoute as baseAsyncRoute, errorMessage } from "../lib/errors.js";
import { nonEmptyEnvFallback } from "../lib/values.js";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const execFileAsync = promisify(execFile);

function resolveConfiguredRoot(envName: string, fallback: string): string {
    const rawValue = nonEmptyEnvFallback(envName, fallback).trim();
    if (!path.isAbsolute(rawValue)) {
        throw new Error(`${envName} must be an absolute non-root path`);
    }
    const value = path.resolve(rawValue);
    if (value === path.parse(value).root) {
        throw new Error(`${envName} must be an absolute non-root path`);
    }
    return value;
}

const DASHBOARD_REPO = "rajohan/Mira-Dashboard";
const DASHBOARD_ROOT = resolveConfiguredRoot(
    "MIRA_DASHBOARD_ROOT",
    "/home/ubuntu/projects/mira-dashboard"
);
const DASHBOARD_WORKTREE_ROOT = resolveConfiguredRoot(
    "MIRA_DASHBOARD_WORKTREE_ROOT",
    "/home/ubuntu/projects/mira-dashboard-worktrees"
);
const DASHBOARD_SERVICE = "mira-dashboard.service";
const MIRA_AUTHOR = "mira-2026";
const DEFAULT_REVIEWER_AUTHOR = "rajohan";
const DEFAULT_BASE = "main";
const DEPLOYMENT_LOCK_STALE_MS = 30 * 60 * 1000;
const MAX_BUFFER = 20 * 1024 * 1024;
const MAX_JSON_LINE_LENGTH = 1024 * 1024;
const PR_LIST_TIMEOUT_MS = 180_000;
const PASSING_CHECK_VALUES = new Set(["success", "successful", "neutral", "skipped"]);
const OPINIONATED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const ACTIVE_DEPLOYMENT_STATUSES = new Set(["building", "restart-scheduled"]);

function getResolvedRoots() {
    return {
        dashboardRoot: DASHBOARD_ROOT,
        dashboardWorktreeRoot: DASHBOARD_WORKTREE_ROOT,
    };
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
    mergeable?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    reviewerApproved?: boolean;
    reviewerCanApprove?: boolean;
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
    status: "building" | "restart-scheduled" | "ok" | "failed";
    startedAt: string;
    updatedAt: string;
    commit?: string;
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

/** Performs async route. */
function asyncRoute(handler: RequestHandler): RequestHandler {
    return baseAsyncRoute(handler, {
        fallback: "Pull request route failed",
        logLabel: "[pullRequestsRoutes]",
    });
}

/** Performs write deployment job. */
function writeDeploymentJob(job: DeploymentJob): void {
    db.prepare(
        `
        INSERT INTO deployment_jobs (
            id,
            status,
            started_at,
            updated_at,
            commit_sha,
            note,
            stdout,
            stderr
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            started_at = excluded.started_at,
            updated_at = excluded.updated_at,
            commit_sha = excluded.commit_sha,
            note = excluded.note,
            stdout = excluded.stdout,
            stderr = excluded.stderr
        `
    ).run(
        job.id,
        job.status,
        job.startedAt,
        job.updatedAt,
        job.commit ?? null,
        job.note ?? null,
        job.stdout ?? null,
        job.stderr ?? null
    );
    db.prepare(
        `
        DELETE FROM deployment_jobs
        WHERE id NOT IN (
            SELECT id
            FROM deployment_jobs
            ORDER BY updated_at DESC
            LIMIT 10
        )
        `
    ).run();
}

interface DeploymentJobRow {
    id: string;
    status: DeploymentJob["status"];
    started_at: string;
    updated_at: string;
    commit_sha: string | null;
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
    const row = db
        .prepare(
            `
            SELECT
                id,
                status,
                started_at,
                updated_at,
                commit_sha,
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
    return db
        .prepare("SELECT job_id, updated_at FROM deployment_lock WHERE id = 1")
        .get() as DeploymentLockRow | undefined;
}

/** Reads the active deployment lock job id. */
function readDeploymentLock(): string | undefined {
    const row = readDeploymentLockRow();
    return row?.job_id;
}

/** Releases the active deploy lock if it still belongs to the given job. */
function releaseDeploymentLock(jobId: string): void {
    try {
        db.prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?").run(jobId);
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
            db.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
        } else if (
            ACTIVE_DEPLOYMENT_STATUSES.has(activeJob.status) &&
            !isDeploymentJobStale(activeJob)
        ) {
            throw new Error(`Dashboard deploy already in progress (${activeJob.id})`);
        } else {
            db.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
        }
    }
}

/** Acquires the active deploy lock for a new deployment job. */
function acquireDeploymentLock(jobId: string): void {
    ensureNoActiveDeployment();
    try {
        db.prepare(
            "INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)"
        ).run(jobId, dateToISOString(new Date()));
    } catch (error) {
        if (error instanceof Error && /constraint/i.test(error.message)) {
            throw new Error("Dashboard deploy already in progress", { cause: error });
        }
        throw error;
    }
}

/** Refreshes the active deploy heartbeat while long-running work continues. */
function refreshDeploymentHeartbeat(job: DeploymentJob): DeploymentJob {
    const updatedJob = { ...job, updatedAt: dateToISOString(new Date()) };
    writeDeploymentJob(updatedJob);
    db.prepare(
        "UPDATE deployment_lock SET updated_at = ? WHERE id = 1 AND job_id = ?"
    ).run(updatedJob.updatedAt, updatedJob.id);
    return updatedJob;
}

/** Performs read deployment jobs. */
function readDeploymentJobs(): DeploymentJob[] {
    return (
        db
            .prepare(
                `
                SELECT
                    id,
                    status,
                    started_at,
                    updated_at,
                    commit_sha,
                    note,
                    stdout,
                    stderr
                FROM deployment_jobs
                ORDER BY updated_at DESC
                LIMIT 10
                `
            )
            .all() as unknown as DeploymentJobRow[]
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

/** Builds GitHub command env for one token. */
function buildGithubCommandEnv(githubToken: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (
            key === "MIRA_GITHUB_TOKEN" ||
            key.startsWith("MIRA_GITHUB_TOKEN_") ||
            key === "RAJOHAN_GITHUB_TOKEN" ||
            key.startsWith("RAJOHAN_GITHUB_TOKEN_")
        ) {
            delete env[key];
        }
    }
    delete env.GITHUB_TOKEN;
    if (githubToken) {
        env.GH_TOKEN = githubToken;
    } else {
        delete env.GH_TOKEN;
    }
    return env;
}

/** Builds command env. */
function buildCommandEnv(): NodeJS.ProcessEnv {
    const githubToken =
        process.env.MIRA_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim() ||
        "";
    return buildGithubCommandEnv(githubToken);
}

/** Builds reviewer command env. */
function buildReviewCommandEnv(): NodeJS.ProcessEnv {
    const githubToken = process.env.RAJOHAN_GITHUB_TOKEN?.trim() || "";
    if (!githubToken) {
        throw new Error("Rajohan GitHub review token is not configured");
    }
    return buildGithubCommandEnv(githubToken);
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
function pullRequestReviewApproved(pr: PullRequestSummary): boolean {
    return (
        pr.reviewDecision?.toUpperCase() === "APPROVED" ||
        pr.reviewerApproved === true ||
        hasReviewerApproval(pr)
    );
}

/** Returns whether the configured reviewer can approve the pull request. */
function reviewerCanApprove(pr: PullRequestSummary): boolean {
    return (
        pr.author?.login !== reviewerAuthor() &&
        !pr.isDraft &&
        !pullRequestReviewApproved(pr)
    );
}

/** Normalizes pull request metadata for the dashboard API. */
function normalizePullRequest(pr: PullRequestSummary): PullRequestSummary {
    const rest = { ...pr };
    delete rest.latestOpinionatedReviews;
    delete rest.reviews;

    return {
        ...rest,
        reviewerApproved: pullRequestReviewApproved(pr),
        reviewerCanApprove: reviewerCanApprove(pr),
    };
}

/** Performs run command. */
async function runCommand(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandResult> {
    const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd || DASHBOARD_ROOT,
        env: options.env || buildCommandEnv(),
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs || 120_000,
    });

    return {
        stdout: trimOutput(String(stdout || "")),
        stderr: trimOutput(String(stderr || "")),
    };
}

/** Runs a GitHub CLI command and parses its JSON output. */
async function runGhJson<T>(args: string[]): Promise<T> {
    const { stdout } = await execFileAsync("gh", args, {
        cwd: DASHBOARD_ROOT,
        env: buildCommandEnv(),
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
    if (Buffer.byteLength(String(line), "utf8") > MAX_JSON_LINE_LENGTH) {
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
    preserveForceKillTimer: boolean,
    clearTimer: (timer: NodeJS.Timeout) => void = clearTimeout
): NodeJS.Timeout | null {
    if (!forceKillTimer || options.keepForceKillTimer || preserveForceKillTimer) {
        return forceKillTimer;
    }
    clearTimer(forceKillTimer);
    return null;
}

/** Streams newline-delimited JSON values from a GitHub CLI command. */
async function runGhJsonLines<T>(
    args: string[],
    options: { timeoutMs?: number } = {}
): Promise<T[]> {
    return new Promise((resolve, reject) => {
        const child = spawn("gh", args, {
            cwd: DASHBOARD_ROOT,
            env: buildCommandEnv(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        const rows: T[] = [];
        let stdoutBuffer = "";
        let stderr = "";
        let settled = false;
        let forceKillTimer: NodeJS.Timeout | null = null;
        let preserveForceKillTimer = false;
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
            preserveForceKillTimer = true;
            settle(() => reject(new Error("GitHub CLI command timed out")), {
                keepForceKillTimer: true,
            });
        }, options.timeoutMs || 60_000);

        const settle = (
            callback: () => void,
            options: { keepForceKillTimer?: boolean } = {}
        ) => {
            if (settled) {
                preserveForceKillTimer =
                    preserveForceKillTimer || Boolean(options.keepForceKillTimer);
                forceKillTimer = clearForceKillTimerIfAllowed(
                    forceKillTimer,
                    options,
                    preserveForceKillTimer
                );
                return;
            }
            settled = true;
            clearTimeout(timeout);
            preserveForceKillTimer =
                preserveForceKillTimer || Boolean(options.keepForceKillTimer);
            forceKillTimer = clearForceKillTimerIfAllowed(
                forceKillTimer,
                options,
                preserveForceKillTimer
            );
            callback();
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdoutBuffer += chunk;

            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() || "";
            if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSON_LINE_LENGTH) {
                child.kill("SIGTERM");
                armForceKillTimer();
                settle(() => reject(new Error("GitHub CLI JSON line was too large")), {
                    keepForceKillTimer: true,
                });
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
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr = trimOutput(stderr + chunk);
        });

        child.on("error", (error) => {
            preserveForceKillTimer = false;
            forceKillTimer = clearForceKillTimerIfAllowed(forceKillTimer, {}, false);
            settle(() => reject(error));
        });

        child.on("close", (code) => {
            preserveForceKillTimer = false;
            forceKillTimer = clearForceKillTimerIfAllowed(forceKillTimer, {}, false);
            settle(() => {
                if (code !== 0) {
                    reject(new Error(stderr || `GitHub CLI exited with code ${code}`));
                    return;
                }
                try {
                    parseGhJsonLine(stdoutBuffer, rows);
                    resolve(rows);
                } catch (error) {
                    reject(toGhJsonParseError(error));
                }
            });
        });
    });
}

/** Lists open pull requests targeting the dashboard production branch. */
async function listDashboardPullRequests(): Promise<PullRequestSummary[]> {
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
        pullRequestReviewApproved(pr) &&
        !pr.isDraft &&
        pullRequestChecksPassed(pr.statusCheckRollup)
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
function validatePrNumber(value: unknown): number {
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
    const expectedRef = `refs/heads/${branch}`;
    return (
        parseGitWorktrees(stdout).find(
            (worktree) => worktree.branch === expectedRef || worktree.branch === branch
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
        if (!isPathInsideRoot(worktreePath, DASHBOARD_WORKTREE_ROOT)) {
            return {
                status: "warning",
                branch,
                path: worktreePath,
                message: `Skipped cleanup for ${branch}; worktree path is outside ${DASHBOARD_WORKTREE_ROOT}`,
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

/** Validates mira pr can be managed from the dashboard. */
function validateMiraPr(pr: PullRequestSummary): void {
    if (pr.author?.login !== MIRA_AUTHOR) {
        throw new Error("Only Mira-authored pull requests can be managed here");
    }

    validateDashboardPr(pr);
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

/** Validates mira pr can be approved and merged from the dashboard. */
function validateDashboardPrForApproval(pr: PullRequestSummary): void {
    validateDashboardPr(pr);
    if (!pullRequestChecksPassed(pr.statusCheckRollup)) {
        throw new Error("Pull request CI checks must pass before approval");
    }
    if (!pullRequestReviewApproved(pr)) {
        throw new Error("Pull request review approval is required before merging");
    }
}

/** Validates a pull request can receive Rajohan's review approval. */
function validateDashboardPrForReviewApproval(pr: PullRequestSummary): void {
    validateDashboardPr(pr);
    if (pr.author?.login === reviewerAuthor()) {
        throw new Error("Rajohan cannot approve his own pull request");
    }
    if (pullRequestReviewApproved(pr)) {
        throw new Error("Pull request is already approved");
    }
}

/** Validates mira pr can be approved and merged from the dashboard. */
function validateMiraPrForApproval(pr: PullRequestSummary): void {
    validateDashboardPrForApproval(pr);
}

/** Returns whether pull request checks are conclusively passing. */
function pullRequestChecksPassed(checks: unknown[] | undefined): boolean {
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
async function getProductionCheckoutStatus(): Promise<ProductionCheckoutStatus> {
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
    const currentBranch = branch.trim();
    const statusShort = status.trim();
    const isClean = statusShort.length === 0;
    const isProductionRoot =
        path.resolve(productionRoot) === path.resolve(DASHBOARD_ROOT);

    return {
        root: productionRoot,
        expectedRoot: DASHBOARD_ROOT,
        worktreeRoot: DASHBOARD_WORKTREE_ROOT,
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
async function ensureProductionCheckout(): Promise<void> {
    const status = await getProductionCheckoutStatus();

    if (!status.isProductionRoot) {
        throw new Error(
            `Expected production checkout at ${DASHBOARD_ROOT}, got ${status.root}`
        );
    }

    if (!status.isClean) {
        throw new Error("Production checkout has local changes; refusing deploy/merge");
    }
}

/** Performs ensure production ready for deploy. */
async function ensureProductionReadyForDeploy(): Promise<void> {
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
const { DatabaseSync } = require("node:sqlite");
const job = JSON.parse(process.env.MIRA_DEPLOYMENT_JOB || "{}");
const db = new DatabaseSync(process.env.MIRA_DEPLOYMENT_DB);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(\`
    INSERT INTO deployment_jobs (
        id,
        status,
        started_at,
        updated_at,
        commit_sha,
        note,
        stdout,
        stderr
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        commit_sha = excluded.commit_sha,
        note = excluded.note,
        stdout = excluded.stdout,
        stderr = excluded.stderr
\`).run(
    job.id,
    job.status,
    job.startedAt,
    job.updatedAt,
    job.commit ?? null,
    job.note ?? null,
    job.stdout ?? null,
    job.stderr ?? null
);
    db.prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?").run(job.id);
    db.exec("COMMIT");
} catch (error) {
    try {
        db.exec("ROLLBACK");
    } catch {}
    throw error;
} finally {
    db.close();
}
`;
    return [
        `MIRA_DEPLOYMENT_DB=${shellQuote(miraDbPath)}`,
        `MIRA_DEPLOYMENT_JOB=${shellQuote(JSON.stringify(job))}`,
        shellQuote(process.execPath),
        "-e",
        shellQuote(script),
    ].join(" ");
}

/** Performs schedule restart health check. */
async function scheduleRestartHealthCheck(job: DeploymentJob): Promise<CommandResult> {
    const okJob: DeploymentJob = {
        ...job,
        status: "ok",
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
    try {
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await syncMain();
        currentJob = refreshDeploymentHeartbeat(currentJob);

        currentJob = refreshDeploymentHeartbeat(currentJob);
        await runCommand("npm", ["ci", "--legacy-peer-deps"], {
            timeoutMs: 180_000,
        });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await runCommand("npm", ["run", "build"], { timeoutMs: 180_000 });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await runCommand("npm", ["--prefix", "backend", "ci"], {
            timeoutMs: 120_000,
        });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await runCommand("npm", ["--prefix", "backend", "run", "build"], {
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
        currentJob = refreshDeploymentHeartbeat(currentJob);

        const restartScheduled: DeploymentJob = {
            ...currentJob,
            status: "restart-scheduled",
            updatedAt: dateToISOString(new Date()),
            commit: commit.trim(),
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
function startDeployLatest(lockHeldBy?: string): DeploymentJob {
    const now = dateToISOString(new Date());
    const job: DeploymentJob = {
        id: randomUUID(),
        status: "building",
        startedAt: now,
        updatedAt: now,
        note: "Deploy started",
    };
    if (lockHeldBy) {
        const result = db
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
async function approvePullRequest(number: number, deploy: boolean) {
    await ensureProductionCheckout();
    const pr = await getPullRequest(number);
    validateDashboardPrForApproval(pr);
    const lockId = `approve-${randomUUID()}`;
    acquireDeploymentLock(lockId);
    let releaseLock = true;

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

        if (deploy && !syncError) {
            try {
                deployment = startDeployLatest(lockId);
                releaseLock = false;
            } catch (error) {
                deployError = errorMessage(error, "Deploy failed to start");
            }
        }
    } finally {
        if (releaseLock) {
            releaseDeploymentLock(lockId);
        }
    }

    return {
        ok: true,
        message: syncError
            ? `PR #${number} merged; production sync failed`
            : deployError
              ? `PR #${number} merged; deploy failed to start`
              : deploy
                ? `PR #${number} merged; deploy started`
                : `PR #${number} merged`,
        deployment,
        deployError,
        cleanup,
        syncError,
    };
}

/** Performs approve pull request review. */
async function approvePullRequestReview(number: number) {
    const pr = await getPullRequest(number);
    validateDashboardPrForReviewApproval(pr);

    await runCommand(
        "gh",
        ["pr", "review", String(number), "--approve", "--repo", DASHBOARD_REPO],
        { env: buildReviewCommandEnv(), timeoutMs: 60_000 }
    );

    const pullRequest = await getPullRequest(number);

    return {
        ok: true,
        message: `PR #${number} review approved`,
        pullRequest,
    };
}

/** Performs reject pull request. */
async function rejectPullRequest(number: number, comment: string) {
    const pr = await getPullRequest(number);
    validateDashboardPr(pr);

    await runCommand(
        "gh",
        ["pr", "close", String(number), "--repo", DASHBOARD_REPO, "--comment", comment],
        { timeoutMs: 60_000 }
    );
    const cleanup = await cleanupPullRequestWorktree(pr.headRefName);

    return {
        ok: true,
        message: `PR #${number} closed`,
        cleanup,
    };
}

/** Registers pull requests API routes. */
export default function pullRequestsRoutes(app: express.Application): void {
    app.get(
        "/api/pull-requests",
        asyncRoute(async (_req, res) => {
            res.json({ pullRequests: await listDashboardPullRequests() });
        })
    );

    app.get(
        "/api/pull-requests/deployments",
        asyncRoute(async (_req, res) => {
            res.json({ deployments: readDeploymentJobs() });
        })
    );

    app.get(
        "/api/pull-requests/production-checkout",
        asyncRoute(async (_req, res) => {
            res.json({ checkout: await getProductionCheckoutStatus() });
        })
    );

    app.post(
        "/api/pull-requests/deploy",
        express.json(),
        asyncRoute(async (_req, res) => {
            await ensureProductionCheckout();
            await ensureProductionReadyForDeploy();
            res.json({ ok: true, deployment: startDeployLatest() });
        })
    );

    app.post(
        "/api/pull-requests/:number/approve",
        express.json(),
        asyncRoute(async (req, res) => {
            let number: number;
            try {
                number = validatePrNumber(req.params.number);
            } catch (error) {
                res.status(400).json({
                    error: errorMessage(error, "Invalid pull request number"),
                });
                return;
            }
            const deploy = req.body?.deploy === true;
            res.json(await approvePullRequest(number, deploy));
        })
    );

    app.post(
        "/api/pull-requests/:number/review-approval",
        express.json(),
        asyncRoute(async (req, res) => {
            let number: number;
            try {
                number = validatePrNumber(req.params.number);
            } catch (error) {
                res.status(400).json({
                    error: errorMessage(error, "Invalid pull request number"),
                });
                return;
            }
            res.json(await approvePullRequestReview(number));
        })
    );

    app.post(
        "/api/pull-requests/:number/reject",
        express.json(),
        asyncRoute(async (req, res) => {
            let number: number;
            try {
                number = validatePrNumber(req.params.number);
            } catch (error) {
                res.status(400).json({
                    error: errorMessage(error, "Invalid pull request number"),
                });
                return;
            }
            const comment =
                typeof req.body?.comment === "string" && req.body.comment.trim()
                    ? req.body.comment.trim()
                    : "Closed from Mira Dashboard after Rajohan rejected it.";
            res.json(await rejectPullRequest(number, comment));
        })
    );
}

export const __testing = {
    acquireDeploymentLock,
    buildCommandEnv,
    buildReviewCommandEnv,
    clearForceKillTimerIfAllowed,
    parseGhJsonLine,
    parseRepoParts,
    deploymentJobUpdateCommand,
    isDeploymentJobStale,
    readDeploymentLock,
    readDeploymentJob,
    reportBackgroundDeploymentError,
    runDeploymentJobAndReportErrors,
    releaseDeploymentLock,
    runDeploymentJob,
    isPathInsideRoot,
    parseGitWorktrees,
    runCommand,
    runGhJson,
    runGhJsonLines,
    toGhJsonParseError,
    validatePrNumber,
    validateDashboardPr,
    validateDashboardPrForApproval,
    validateDashboardPrForReviewApproval,
    validateMiraPr,
    validateMiraPrForApproval,
    shellQuote,
    startDeployLatest,
    trimOutput,
    getResolvedRoots,
    writeDeploymentJob,
};
