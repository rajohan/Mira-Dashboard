import path from "node:path";

import { database, getMiraDatabasePath, sqlNullable } from "../database.ts";
import { errorMessage } from "../lib/errors.ts";
import {
    killProcessGroup,
    pipeProcessOutput,
    runProcess,
    spawnProcess,
} from "../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../lib/values.ts";
import {
    assertManagedDashboardUnitProperties,
    MANAGED_DASHBOARD_UNITS,
    managedDashboardUnitContract,
    stageDashboardRelease,
} from "../releaseDeployment.ts";
import {
    readDashboardReleaseState,
    resolveDashboardReleasesRoot,
} from "../releaseManager.ts";
import {
    enqueueJobExecution,
    JOB_WORKER_HEARTBEAT_MAX_AGE_MS,
    type JobExecution,
    registerExpiredJobExecutionHandler,
    registerQueuedJobCancellationHandler,
} from "./jobExecutionQueue.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "./queuedJobExecution.ts";
import {
    type OrphanedDeploymentCutover,
    registerDeploymentCutoverRecoveryHandler,
    registerScheduledJobAction,
    type ScheduledJob,
    type ScheduledJobActionContext,
    ScheduledJobActionError,
} from "./scheduledJobs.ts";

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
const DASHBOARD_SERVICES = [
    "mira-dashboard.service",
    "mira-dashboard-worker.service",
] as const;
const DEFAULT_REVIEWER_AUTHOR = "rajohan";
const DEFAULT_BASE = "main";
const DEPLOYMENT_LOCK_STALE_MS = 30 * 60 * 1000;
const RECENT_DEPLOYMENTS_LIMIT = 10;
const MAX_BUFFER = 20 * 1024 * 1024;
const MAX_JSON_LINE_LENGTH = 1024 * 1024;
const PR_LIST_TIMEOUT_MS = 180_000;
const DEPLOYMENT_RESTART_STATUS_POLL_MS = 1000;
const DEPLOYMENT_RESTART_CLAIM_PAUSE_TIMEOUT_MS = 2 * 60 * 1000;
const DEPLOYMENT_WORKER_STABILITY_SECONDS =
    Math.ceil(JOB_WORKER_HEARTBEAT_MAX_AGE_MS / 1000) + 1;
const PASSING_CHECK_VALUES = new Set(["success", "successful", "neutral", "skipped"]);
const OPINIONATED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const ACTIVE_DEPLOYMENT_STATUSES = new Set(["building", "restart-scheduled"]);
const BUN_EXECUTABLE = process.env.BUN_BINARY || "bun";

function resolveExecutableFromPath(executable: string): string | undefined {
    if (path.isAbsolute(executable)) {
        return executable;
    }
    if (executable.includes(path.sep)) {
        return path.resolve(executable);
    }

    return Bun.which(executable) ?? undefined;
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
            sqlNullable(job.commit ?? undefined),
            sqlNullable(job.commitTitle ?? undefined),
            sqlNullable(job.note ?? undefined),
            sqlNullable(job.stdout ?? undefined),
            sqlNullable(job.stderr ?? undefined)
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

interface DeploymentLockExecutionRow {
    status: JobExecution["status"];
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

function readDeploymentLockExecution(
    lockOwner: string
): DeploymentLockExecutionRow | undefined {
    return database
        .prepare(
            `SELECT status
             FROM job_executions
             WHERE json_valid(payload_json)
               AND (
                   (
                       action_key = 'dashboard.deploy'
                       AND json_extract(payload_json, '$.deploymentId') = ?
                   )
                   OR (
                       action_key IN ('github.merge', 'github.merge-deploy')
                       AND json_extract(payload_json, '$.deploymentLockId') = ?
                   )
               )
             ORDER BY queued_at DESC, id DESC
             LIMIT 1`
        )
        .get(lockOwner, lockOwner) as DeploymentLockExecutionRow | undefined;
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

function cleanupTerminatedDeploymentExecution(
    execution: JobExecution,
    timestamp: string,
    note: string
): void {
    if (execution.actionKey === "dashboard.deploy") {
        const deploymentId = execution.payload.deploymentId;
        if (typeof deploymentId !== "string" || deploymentId.trim() === "") {
            return;
        }
        const deployment = readDeploymentJob(deploymentId);
        if (deployment && ACTIVE_DEPLOYMENT_STATUSES.has(deployment.status)) {
            writeDeploymentJob({
                ...deployment,
                note,
                status: "failed",
                updatedAt: timestamp,
            });
        }
        database
            .prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?")
            .run(deploymentId);
        return;
    }

    const deploymentLockId = execution.payload.deploymentLockId;
    if (typeof deploymentLockId === "string" && deploymentLockId.trim() !== "") {
        database
            .prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?")
            .run(deploymentLockId);
    }
}

function cleanupQueuedDeploymentCancellation(
    execution: JobExecution,
    timestamp: string
): void {
    cleanupTerminatedDeploymentExecution(
        execution,
        timestamp,
        "Deploy cancelled before execution"
    );
}

function cleanupExpiredDeploymentExecution(execution: JobExecution): void {
    cleanupTerminatedDeploymentExecution(
        execution,
        execution.finishedAt ?? dateToISOString(new Date()),
        execution.status === "cancelled"
            ? "Deploy cancelled after its worker lease expired"
            : "Deploy failed after its worker lease expired"
    );
}

/** Restores action-specific cleanup for queued cancellations and expired leases. */
export function registerPullRequestJobLifecycleHandlers(): void {
    registerQueuedJobCancellationHandler(
        "dashboard.deploy",
        cleanupQueuedDeploymentCancellation
    );
    registerQueuedJobCancellationHandler(
        "github.merge",
        cleanupQueuedDeploymentCancellation
    );
    registerQueuedJobCancellationHandler(
        "github.merge-deploy",
        cleanupQueuedDeploymentCancellation
    );
    registerExpiredJobExecutionHandler(
        "dashboard.deploy",
        cleanupExpiredDeploymentExecution
    );
    registerExpiredJobExecutionHandler("github.merge", cleanupExpiredDeploymentExecution);
    registerExpiredJobExecutionHandler(
        "github.merge-deploy",
        cleanupExpiredDeploymentExecution
    );
}

/** Ensures no active deploy owns the production checkout. */
function ensureNoActiveDeployment(): void {
    const activeLock = readDeploymentLockRow();
    const activeJobId = activeLock?.job_id;
    if (activeJobId) {
        const activeJob = readDeploymentJob(activeJobId);
        const lockExecution = readDeploymentLockExecution(activeJobId);
        if (lockExecution?.status === "queued" || lockExecution?.status === "running") {
            throw new Error(`Dashboard deploy already in progress (${activeJobId})`);
        }
        if (lockExecution && activeJob?.status === "building") {
            writeDeploymentJob({
                ...activeJob,
                note: "Deploy execution ended before build completion",
                status: "failed",
                updatedAt: dateToISOString(new Date()),
            });
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            return;
        }
        if (!activeJob) {
            if (!lockExecution && !isDeploymentLockStale(activeLock)) {
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

function refreshDeploymentLockOwner(jobId: string): void {
    const result = database
        .prepare("UPDATE deployment_lock SET updated_at = ? WHERE id = 1 AND job_id = ?")
        .run(dateToISOString(new Date()), jobId);
    if (result.changes !== 1) {
        throw new Error("Dashboard deploy lock ownership was lost");
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
    ).map((row) => mapDeploymentJob(row));
}

/** Performs trim output. */
function trimOutput(value: string): string {
    return value.slice(-20_000);
}

/** Splits an owner/name GitHub repository identifier. */
function parseRepoParts(repo: string): { owner: string; name: string } {
    const parts = repo.split("/");
    const [owner, name] = parts;
    if (!owner || !name || parts.length !== 2) {
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
    const latestReview = reviews.toSorted((a, b) =>
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

/** Runs a GitHub CLI command and parses its JSON output. */
async function runGhJson<T>(arguments_: string[], signal?: AbortSignal): Promise<T> {
    const { code, stderr, stdout } = await runProcess("gh", arguments_, {
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal,
        timeoutMs: 60_000,
    });
    if (code !== 0) {
        throw new Error(
            `gh ${arguments_.join(" ")} failed with exit code ${code}: ${
                stderr.trim() || stdout.trim()
            }`
        );
    }
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
                        parseGhJsonLine(line, rows);
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
            const code = await child.exited;
            await Promise.all([stdoutDone, stderrDone]);
            return code;
        })()
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

    return refreshedPullRequests.toSorted((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
    );
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
async function getPullRequest(
    number: number,
    signal?: AbortSignal
): Promise<PullRequestSummary> {
    return normalizePullRequest(
        await runGhJson<PullRequestSummary>(
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
            signal
        )
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
async function findWorktreeForBranch(
    branch: string,
    signal?: AbortSignal
): Promise<GitWorktree | undefined> {
    const { stdout } = await runCommand("git", ["worktree", "list", "--porcelain"], {
        signal,
        timeoutMs: 30_000,
    });
    const expectedReference = `refs/heads/${branch}`;
    return (
        parseGitWorktrees(stdout).find(
            (worktree) =>
                worktree.branch === expectedReference || worktree.branch === branch
        ) || undefined
    );
}

/** Performs cleanup pull request worktree. */
async function cleanupPullRequestWorktree(
    branch: string,
    signal?: AbortSignal
): Promise<WorktreeCleanupResult> {
    try {
        const worktree = await findWorktreeForBranch(branch, signal);
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
                message: `Skipped cleanup for ${branch}. Worktree path is outside ${dashboardWorktreeRoot}`,
            };
        }

        const { stdout: status } = await runCommand(
            "git",
            ["-C", worktreePath, "status", "--short"],
            { signal, timeoutMs: 30_000 }
        );
        if (status.trim()) {
            return {
                status: "warning",
                branch,
                path: worktreePath,
                message: `Skipped cleanup for ${branch}. Worktree has local changes`,
            };
        }

        await runCommand("git", ["worktree", "remove", worktreePath], {
            signal,
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

/** Keeps only the latest check entry for each GitHub check name/context. */
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

/** Returns a stable key for a GitHub status or check run. */
function checkKey(check: Record<string, unknown>): string {
    for (const key of ["name", "context", "workflowName"]) {
        const value = check[key];
        if (typeof value === "string" && value.trim()) {
            return `${key}:${value.trim()}`;
        }
    }
    return JSON.stringify(check);
}

/** Returns a comparable timestamp for a GitHub status or check run. */
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

/** Normalizes a GitHub check status or conclusion. */
function normalizedCheckValue(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
}

/** Returns production checkout status. */
export async function getProductionCheckoutStatus(
    signal?: AbortSignal
): Promise<ProductionCheckoutStatus> {
    const [{ stdout: root }, { stdout: branch }, { stdout: head }, { stdout: status }] =
        await Promise.all([
            runCommand("git", ["rev-parse", "--show-toplevel"], {
                signal,
                timeoutMs: 30_000,
            }),
            runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                signal,
                timeoutMs: 30_000,
            }),
            runCommand("git", ["rev-parse", "--short", "HEAD"], {
                signal,
                timeoutMs: 30_000,
            }),
            runCommand("git", ["status", "--short"], {
                signal,
                timeoutMs: 30_000,
            }),
        ]);

    let upstream: string | undefined;
    try {
        const { stdout } = await runCommand(
            "git",
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            { signal, timeoutMs: 30_000 }
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
export async function ensureProductionCheckout(signal?: AbortSignal): Promise<void> {
    const status = await getProductionCheckoutStatus(signal);

    if (!status.isProductionRoot) {
        throw new Error(
            `Expected production checkout at ${getDashboardRoot()}, got ${status.root}`
        );
    }

    if (!status.isClean) {
        throw new Error("Production checkout has local changes. Refusing deploy/merge");
    }
}

/** Performs ensure production ready for deploy. */
export async function ensureProductionReadyForDeploy(
    signal?: AbortSignal
): Promise<void> {
    const status = await getProductionCheckoutStatus(signal);

    if (!status.isSafeForDeploy) {
        throw new Error(
            `Production checkout must be clean ${DEFAULT_BASE} before deploy. Current branch=${status.branch}, clean=${status.isClean}`
        );
    }
}

/** Performs sync main. */
async function syncMain(signal?: AbortSignal): Promise<void> {
    await ensureProductionCheckout(signal);
    await runCommand("git", ["fetch", "--prune", "origin"], {
        signal,
        timeoutMs: 120_000,
    });
    await runCommand("git", ["checkout", DEFAULT_BASE], {
        signal,
        timeoutMs: 60_000,
    });
    await runCommand("git", ["pull", "--ff-only", "origin", DEFAULT_BASE], {
        signal,
        timeoutMs: 120_000,
    });
    await ensureProductionReadyForDeploy(signal);
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
const sqlNull = JSON.parse("null");
function sqlNullable(value) {
    return value === undefined ? sqlNull : value;
}
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
    sqlNullable(job.commit ?? undefined),
    sqlNullable(job.commitTitle ?? undefined),
    sqlNullable(job.note ?? undefined),
    sqlNullable(job.stdout ?? undefined),
    sqlNullable(job.stderr ?? undefined)
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
        `MIRA_DEPLOYMENT_DB=${shellQuote(getMiraDatabasePath())}`,
        `MIRA_DEPLOYMENT_JOB=${shellQuote(JSON.stringify(job))}`,
        shellQuote(resolveBunExecutable()),
        "-e",
        shellQuote(script),
    ].join(" ");
}

function releaseLifecycleInvocation(
    releasesRoot: string,
    lifecycleCommand: string
): string {
    return [
        `MIRA_DASHBOARD_RELEASES_ROOT=${shellQuote(releasesRoot)}`,
        `MIRA_DASHBOARD_DB_PATH=${shellQuote(getMiraDatabasePath())}`,
        "NODE_ENV=production",
        shellQuote(resolveBunExecutable()),
        shellQuote(lifecycleCommand),
    ].join(" ");
}

function releaseCutoverShellFunctions(): string[] {
    return [
        "resolve_dashboard_port() {",
        '  dashboard_port=$(/usr/local/bin/doppler run --config prd --project rajohan -- /bin/sh -c \'printf "%s" "${PORT:-3100}"\' 2>/dev/null || true)',
        "  dashboard_port=\"$(printf \"%s\" \"$dashboard_port\" | /usr/bin/sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^0*//')\"",
        '  [ -n "$dashboard_port" ] || dashboard_port=0',
        '  case "$dashboard_port" in',
        "    *[!0-9]*) dashboard_port=3100 ;;",
        "  esac",
        "  if ((${#dashboard_port} > 5)); then",
        "    dashboard_port=3100",
        "  fi",
        "  if ((10#$dashboard_port < 1 || 10#$dashboard_port > 65535)); then",
        "    dashboard_port=3100",
        "  fi",
        '  printf "%s" "$dashboard_port"',
        "}",
        "worker_identity() {",
        "  worker_properties=$(/usr/bin/systemctl --user show mira-dashboard-worker.service --property=ActiveState --property=SubState --property=MainPID --property=ExecMainStartTimestampMonotonic --no-pager 2>/dev/null) || return 1",
        String.raw`  worker_active="$(printf "%s\n" "$worker_properties" | /usr/bin/sed -n 's/^ActiveState=//p')"`,
        String.raw`  worker_substate="$(printf "%s\n" "$worker_properties" | /usr/bin/sed -n 's/^SubState=//p')"`,
        String.raw`  worker_pid="$(printf "%s\n" "$worker_properties" | /usr/bin/sed -n 's/^MainPID=//p')"`,
        String.raw`  worker_started="$(printf "%s\n" "$worker_properties" | /usr/bin/sed -n 's/^ExecMainStartTimestampMonotonic=//p')"`,
        '  [ "$worker_active" = active ] || return 1',
        '  [ "$worker_substate" = running ] || return 1',
        '  case "$worker_pid:$worker_started" in',
        "    *[!0-9:]*|0:*|*:0|:*|*:) return 1 ;;",
        "  esac",
        '  printf "%s:%s" "$worker_pid" "$worker_started"',
        "}",
        "readiness_matches() {",
        '  expected_commit="$1"',
        '  dashboard_port="$(resolve_dashboard_port)"',
        '  response=$(/usr/bin/curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "http://127.0.0.1:${dashboard_port}/api/health/ready" 2>/dev/null || true)',
        '  printf "%s" "$response" | /usr/bin/jq --exit-status --arg expected "$expected_commit" \'.status == "isReady" and .checks.release.ready == true and .checks.release.backendCommit == $expected and .checks.release.frontendCommit == $expected and .checks.worker.ready == true\' >/dev/null 2>&1',
        "}",
        "ready_for_commit() {",
        '  expected_commit="$1"',
        '  initial_worker_identity=""',
        "  for attempt in {1..30}; do",
        '    if readiness_matches "$expected_commit"; then',
        '      initial_worker_identity="$(worker_identity || true)"',
        '      [ -n "$initial_worker_identity" ] && break',
        "    fi",
        "    sleep 1",
        "  done",
        '  [ -n "$initial_worker_identity" ] || return 1',
        `  sleep ${DEPLOYMENT_WORKER_STABILITY_SECONDS}`,
        '  current_worker_identity="$(worker_identity || true)"',
        '  [ "$current_worker_identity" = "$initial_worker_identity" ] || return 1',
        '  readiness_matches "$expected_commit"',
        "}",
        "restart_services() {",
        `  /usr/bin/systemctl --user restart ${DASHBOARD_SERVICES.join(" ")}`,
        "}",
    ];
}

async function assertManagedDashboardServiceContract(
    signal?: AbortSignal
): Promise<void> {
    const contract = managedDashboardUnitContract();
    for (const unit of Object.keys(MANAGED_DASHBOARD_UNITS) as Array<
        keyof typeof MANAGED_DASHBOARD_UNITS
    >) {
        const { stdout } = await runCommand(
            "systemctl",
            [
                "--user",
                "show",
                unit,
                "--property=Environment",
                "--property=ExecStart",
                "--property=WorkingDirectory",
            ],
            { signal, timeoutMs: 30_000 }
        );
        assertManagedDashboardUnitProperties(unit, stdout, contract);
    }
}

/** Schedules detached service restart, commit-bound readiness, and rollback. */
async function scheduleReleaseCutover(
    job: DeploymentJob,
    candidateCommit: string,
    preActivationCommit: string,
    rollbackCommit: string,
    signal?: AbortSignal
): Promise<CommandResult> {
    if (!job.commit || !/^[\da-f]{40}$/u.test(job.commit)) {
        throw new TypeError("Release cutover requires a full candidate commit");
    }
    if (!/^[\da-f]{40}$/u.test(candidateCommit) || candidateCommit !== job.commit) {
        throw new TypeError("Release cutover requires the matching full candidate SHA");
    }
    if (!/^[\da-f]{40}$/u.test(preActivationCommit)) {
        throw new TypeError("Release cutover requires a full pre-activation commit");
    }
    if (rollbackCommit === candidateCommit || !/^[\da-f]{40}$/u.test(rollbackCommit)) {
        throw new TypeError("Release cutover requires a distinct full rollback commit");
    }
    const releasesRoot = resolveDashboardReleasesRoot();
    const lifecycleCommand = path.join(
        releasesRoot,
        "releases",
        preActivationCommit,
        "backend",
        "dist",
        "releaseLifecycle.js"
    );
    const lifecycleEnvironment = releaseLifecycleInvocation(
        releasesRoot,
        lifecycleCommand
    );
    const candidateShort = candidateCommit.slice(0, 8);
    const rollbackShort = rollbackCommit.slice(0, 8);
    const okJob: DeploymentJob = {
        ...job,
        status: "isOk",
        updatedAt: dateToISOString(new Date()),
        note: "Atomic release activated. Web, worker, and commit readiness passed",
    };
    const okWithRetentionWarningJob: DeploymentJob = {
        ...okJob,
        note: "Atomic release activated and ready; release retention cleanup failed",
    };
    const rolledBackJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: `Release readiness failed; automatic rollback restored ${rollbackShort}`,
    };
    const rollbackFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: `Release readiness failed and automatic rollback to ${rollbackShort} failed`,
    };
    const activationFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Release activation failed before restart; guardian left current unchanged",
    };

    const script = [
        "sleep 2",
        ...releaseCutoverShellFunctions(),
        `if ${lifecycleEnvironment} activate ${shellQuote(candidateCommit)}; then`,
        `  if restart_services && ready_for_commit ${shellQuote(candidateShort)}; then`,
        `    if ${lifecycleEnvironment} prune 3; then`,
        `      ${deploymentJobUpdateCommand(okJob)}`,
        "    else",
        `      ${deploymentJobUpdateCommand(okWithRetentionWarningJob)}`,
        "    fi",
        "  else",
        `    if ${lifecycleEnvironment} rollback && restart_services && ready_for_commit ${shellQuote(rollbackShort)}; then`,
        `      ${deploymentJobUpdateCommand(rolledBackJob)}`,
        "    else",
        `      ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "    fi",
        "  fi",
        "else",
        `  ${deploymentJobUpdateCommand(activationFailedJob)}`,
        "fi",
    ].join("\n");

    return runCommand(
        "systemd-run",
        [
            "--user",
            "--collect",
            `--unit=mira-dashboard-deploy-${job.id}`,
            "--description=Mira Dashboard atomic release cutover",
            "/bin/bash",
            "-lc",
            script,
        ],
        { signal, timeoutMs: 30_000 }
    );
}

function didScheduleOrphanedReleaseCutoverRecovery(
    cutover: OrphanedDeploymentCutover
): boolean {
    const job = readDeploymentJob(cutover.id);
    if (!job || job.status !== "restart-scheduled") {
        return false;
    }
    const candidateCommit = cutover.candidateCommit ?? job.commit;
    if (
        !candidateCommit ||
        !/^[\da-f]{40}$/u.test(candidateCommit) ||
        job.commit !== candidateCommit
    ) {
        throw new Error(
            "Orphaned release cutover recovery requires its persisted full candidate SHA"
        );
    }

    const releasesRoot = resolveDashboardReleasesRoot();
    const rolledBackJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Interrupted release cutover recovered; automatic rollback restored the previous verified release",
    };
    const activationNotAppliedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Interrupted release cutover recovered before candidate activation; current verified release remains ready",
    };
    const activeCandidateRecoveredJob: DeploymentJob = {
        ...job,
        status: "isOk",
        updatedAt: dateToISOString(new Date()),
        note: "Interrupted release cutover recovered; active candidate passed restart and commit-bound readiness",
    };
    const script = [
        "sleep 1",
        ...releaseCutoverShellFunctions(),
        `releases_root=${shellQuote(releasesRoot)}`,
        `candidate_commit=${shellQuote(candidateCommit)}`,
        `bun_executable=${shellQuote(resolveBunExecutable())}`,
        "resolve_trusted_lifecycle() {",
        '  current_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/current") || return 1',
        '  current_commit="$(/usr/bin/basename -- "$current_release")"',
        '  [[ "$current_commit" =~ ^[0-9a-f]{40}$ ]] || return 1',
        '  [ "$current_release" = "$releases_root/releases/$current_commit" ] || return 1',
        '  if [ "$current_commit" = "$candidate_commit" ]; then',
        '    trusted_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/previous") || return 1',
        "  else",
        '    trusted_release="$current_release"',
        "  fi",
        '  trusted_commit="$(/usr/bin/basename -- "$trusted_release")"',
        '  [[ "$trusted_commit" =~ ^[0-9a-f]{40}$ ]] || return 1',
        '  [ "$trusted_release" = "$releases_root/releases/$trusted_commit" ] || return 1',
        '  trusted_lifecycle="$trusted_release/backend/dist/releaseLifecycle.js"',
        '  [ -f "$trusted_lifecycle" ] && [ ! -L "$trusted_lifecycle" ]',
        "}",
        "run_lifecycle() {",
        '  MIRA_DASHBOARD_RELEASES_ROOT="$releases_root" \\',
        `  MIRA_DASHBOARD_DB_PATH=${shellQuote(getMiraDatabasePath())} \\`,
        "  NODE_ENV=production \\",
        '  "$bun_executable" "$trusted_lifecycle" "$@"',
        "}",
        "resolve_trusted_lifecycle || exit 1",
        'if [ "$current_commit" = "$candidate_commit" ] && restart_services && ready_for_commit "${candidate_commit:0:8}"; then',
        `  ${deploymentJobUpdateCommand(activeCandidateRecoveredJob)}`,
        "  exit 0",
        "fi",
        'if activation_output="$(run_lifecycle activate "$candidate_commit")"; then',
        '  rollback_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.previous.commitSha // empty\')"',
        '  [[ "$rollback_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '  [ "$rollback_commit" != "$candidate_commit" ] || exit 1',
        '  if run_lifecycle rollback && restart_services && ready_for_commit "${rollback_commit:0:8}"; then',
        `    ${deploymentJobUpdateCommand(rolledBackJob)}`,
        "  else",
        "    exit 1",
        "  fi",
        "else",
        '  status_output="$(run_lifecycle status)" || exit 1',
        '  current_commit="$(printf "%s" "$status_output" | /usr/bin/jq --raw-output \'.current.commitSha // empty\')"',
        '  [[ "$current_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '  [ "$current_commit" != "$candidate_commit" ] || exit 1',
        '  if ready_for_commit "${current_commit:0:8}" || { restart_services && ready_for_commit "${current_commit:0:8}"; }; then',
        `    ${deploymentJobUpdateCommand(activationNotAppliedJob)}`,
        "  else",
        "    exit 1",
        "  fi",
        "fi",
    ].join("\n");

    writeDeploymentJob({
        ...job,
        updatedAt: dateToISOString(new Date()),
        note: "Detached release guardian ended without a terminal result; automatic rollback recovery scheduled",
    });
    const result = Bun.spawnSync({
        cmd: [
            "systemd-run",
            "--user",
            "--collect",
            `--unit=mira-dashboard-deploy-recovery-${job.id}`,
            "--description=Mira Dashboard orphaned release rollback",
            "/bin/bash",
            "-lc",
            script,
        ],
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    if (result.exitCode !== 0) {
        const diagnostic =
            new TextDecoder().decode(result.stderr).trim() ||
            new TextDecoder().decode(result.stdout).trim();
        throw new Error(
            `systemd-run failed to schedule orphaned release rollback: ${
                diagnostic || `exit ${result.exitCode}`
            }`
        );
    }
    return true;
}

/** Runs deployment work after the API has returned a job to the caller. */
async function runDeploymentJob(
    job: DeploymentJob,
    signal?: AbortSignal
): Promise<boolean> {
    let currentJob = job;
    const dashboardRoot = getDashboardRoot();
    const releasesRoot = resolveDashboardReleasesRoot();
    try {
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await syncMain(signal);
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await assertManagedDashboardServiceContract(signal);
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const currentState = await readDashboardReleaseState(releasesRoot);
        if (!currentState.current) {
            throw new Error(
                "Managed deployment requires a current release from the one-time production cutover"
            );
        }
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const { stdout: commitSha } = await runCommand("git", ["rev-parse", "HEAD"], {
            signal,
            timeoutMs: 30_000,
        });
        const expectedCommit = commitSha.trim();
        const candidate = await stageDashboardRelease(expectedCommit, {
            commandRunner: async (command, arguments_, options) =>
                runCommand(command, [...arguments_], {
                    cwd: options.cwd,
                    environment: options.environment,
                    signal: options.signal,
                    timeoutMs: options.timeoutMs,
                }),
            databasePath: getMiraDatabasePath(),
            onProgress: () => {
                currentJob = refreshDeploymentHeartbeat(currentJob);
            },
            releasesRoot,
            signal,
            sourceRoot: dashboardRoot,
            worktreeRoot: getDashboardWorktreeRoot(),
        });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const rollbackRelease =
            currentState.current.commitSha === expectedCommit
                ? currentState.previous
                : currentState.current;
        if (!rollbackRelease || rollbackRelease.commitSha === expectedCommit) {
            throw new Error(
                "Managed deployment requires a distinct verified rollback release"
            );
        }

        const restartScheduled: DeploymentJob = {
            ...currentJob,
            status: "restart-scheduled",
            updatedAt: dateToISOString(new Date()),
            commit: candidate.manifest.commitSha,
            commitTitle: candidate.manifest.commitTitle,
            note: "Immutable release published. Detached activation and rollback check scheduled",
        };
        writeDeploymentJob(restartScheduled);
        await scheduleReleaseCutover(
            restartScheduled,
            expectedCommit,
            currentState.current.commitSha,
            rollbackRelease.commitSha,
            signal
        );
        return true;
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
        return false;
    }
}

function resumeWorkerClaimsWhenDeploymentRestartSettles(
    deploymentId: string,
    resumeWorkerClaims: () => void
): void {
    let isSettled = false;
    const settle = () => {
        if (isSettled) return;
        isSettled = true;
        clearInterval(restartPoll);
        clearTimeout(failSafe);
        resumeWorkerClaims();
    };
    const checkRestartStatus = () => {
        try {
            const deployment = readDeploymentJob(deploymentId);
            if (!deployment || !ACTIVE_DEPLOYMENT_STATUSES.has(deployment.status)) {
                settle();
            }
        } catch (error) {
            console.warn(
                "[PullRequests] Failed to inspect detached deployment restart:",
                error
            );
        }
    };
    const restartPoll = setInterval(
        checkRestartStatus,
        DEPLOYMENT_RESTART_STATUS_POLL_MS
    );
    restartPoll.unref();
    const failSafe = setTimeout(() => {
        console.warn(
            "[PullRequests] Resuming worker claims after deployment restart pause timed out",
            { deploymentId }
        );
        settle();
    }, DEPLOYMENT_RESTART_CLAIM_PAUSE_TIMEOUT_MS);
    failSafe.unref();
    queueMicrotask(checkRestartStatus);
}

/** Persists a deployment and puts its execution behind the worker lease. */
export function startDeployLatest(lockHeldBy?: string): DeploymentJob {
    registerPullRequestJobLifecycleHandlers();
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
        enqueueJobExecution({
            actionKey: "dashboard.deploy",
            displayName: "Deploy Mira Dashboard",
            payload: { deploymentId: job.id },
            resourceClass: "exclusive",
            timeoutMs: 45 * 60 * 1000,
        });
        return job;
    } catch (error) {
        releaseDeploymentLock(job.id);
        if (lockHeldBy) {
            releaseDeploymentLock(lockHeldBy);
        }
        writeDeploymentJob({
            ...job,
            note: errorMessage(error, "Dashboard deploy failed to queue"),
            status: "failed",
            updatedAt: dateToISOString(new Date()),
        });
        throw error;
    }
}

/** Queues a direct deploy; production validation is owned by the worker action. */
export async function prepareAndStartDeployLatest(): Promise<DeploymentJob> {
    return startDeployLatest();
}

interface PullRequestApprovalExecutionOptions {
    lockHeldBy?: string;
    signal?: AbortSignal;
}

/** Performs approve pull request. */
export async function approvePullRequest(
    number: number,
    willDeploy: boolean,
    options: PullRequestApprovalExecutionOptions = {}
) {
    const lockId = options.lockHeldBy ?? `approve-${Bun.randomUUIDv7()}`;
    let isReleaseLock = options.lockHeldBy !== undefined;

    let syncError: string | undefined;
    let deployError: string | undefined;
    let deployment: DeploymentJob | undefined;
    let cleanup: WorktreeCleanupResult;

    try {
        if (options.lockHeldBy) {
            refreshDeploymentLockOwner(lockId);
        }
        await ensureProductionCheckout(options.signal);
        const pr = await getPullRequest(number, options.signal);
        validateDashboardPrForApproval(pr);
        if (!options.lockHeldBy) {
            acquireDeploymentLock(lockId);
            isReleaseLock = true;
        }
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
            { signal: options.signal, timeoutMs: 120_000 }
        );
        cleanup = await cleanupPullRequestWorktree(pr.headRefName, options.signal);

        try {
            await syncMain(options.signal);
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
            ? `PR #${number} merged. Production sync failed`
            : deployError
              ? `PR #${number} merged. Deploy failed to start`
              : willDeploy
                ? `PR #${number} merged. Deploy started`
                : `PR #${number} merged`,
        deployment,
        deployError,
        cleanup,
        syncError,
    };
}

function queuedPullRequestResult<T>(execution: JobExecution): T {
    if ("result" in execution.output) return execution.output.result as T;
    successfulJobExecutionOutput(execution);
    throw new Error("Pull request result was missing");
}

/** Runs PR merge/deploy through the shared persistent execution plane. */
export async function runPullRequestApproval(number: number, willDeploy: boolean) {
    registerPullRequestJobLifecycleHandlers();
    const deploymentLockId = `approve-${Bun.randomUUIDv7()}`;
    acquireDeploymentLock(deploymentLockId);
    let execution: JobExecution;
    try {
        execution = enqueueJobExecution({
            actionKey: willDeploy ? "github.merge-deploy" : "github.merge",
            displayName: willDeploy
                ? `Merge and deploy PR #${number}`
                : `Merge PR #${number}`,
            payload: { deploymentLockId, number, willDeploy },
            resourceClass: "exclusive",
            timeoutMs: (willDeploy ? 45 : 10) * 60 * 1000,
        });
    } catch (error) {
        releaseDeploymentLock(deploymentLockId);
        throw error;
    }
    return queuedPullRequestResult<Awaited<ReturnType<typeof approvePullRequest>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 60 * 60 * 1000 })
    );
}

/** Performs approve pull request review. */
export async function approvePullRequestReview(number: number, signal?: AbortSignal) {
    const pr = await getPullRequest(number, signal);
    validateDashboardPrForReviewApproval(pr);

    await runCommand(
        "gh",
        ["pr", "review", String(number), "--approve", "--repo", DASHBOARD_REPO],
        {
            environment: buildReviewCommandEnvironment(),
            signal,
            timeoutMs: 60_000,
        }
    );

    const pullRequest = await getPullRequest(number, signal);

    return {
        isOk: true,
        message: `PR #${number} review approved`,
        pullRequest,
    };
}

/** Updates one pull request branch with the latest base branch. */
export async function updatePullRequestBranch(number: number, signal?: AbortSignal) {
    const pr = await getPullRequest(number, signal);
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

    await runCommand("gh", arguments_, { signal, timeoutMs: 60_000 });

    return {
        isOk: true,
        message: `PR #${number} branch update started`,
        pullRequest: await getPullRequest(number, signal),
    };
}

/** Performs reject pull request. */
export async function rejectPullRequest(
    number: number,
    comment: string,
    signal?: AbortSignal
) {
    const pr = await getPullRequest(number, signal);
    validateDashboardPr(pr);

    await runCommand(
        "gh",
        ["pr", "close", String(number), "--repo", DASHBOARD_REPO, "--comment", comment],
        { signal, timeoutMs: 60_000 }
    );
    const cleanup = await cleanupPullRequestWorktree(pr.headRefName, signal);

    return {
        isOk: true,
        message: `PR #${number} closed`,
        cleanup,
    };
}

/** Records a GitHub review approval in the shared execution plane. */
export async function runPullRequestReviewApproval(number: number) {
    const execution = enqueueJobExecution({
        actionKey: "github.review-approval",
        displayName: `Approve review for PR #${number}`,
        payload: { number },
        resourceClass: "network",
        timeoutMs: 2 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof approvePullRequestReview>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

/** Records a GitHub branch update in the shared execution plane. */
export async function runPullRequestBranchUpdate(number: number) {
    const execution = enqueueJobExecution({
        actionKey: "github.update-branch",
        displayName: `Update branch for PR #${number}`,
        payload: { number },
        resourceClass: "network",
        timeoutMs: 2 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof updatePullRequestBranch>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

/** Records a PR close and local worktree cleanup in the execution plane. */
export async function runPullRequestRejection(number: number, comment: string) {
    const execution = enqueueJobExecution({
        actionKey: "github.reject",
        displayName: `Reject PR #${number}`,
        payload: { comment, number },
        resourceClass: "exclusive",
        timeoutMs: 5 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof rejectPullRequest>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

function executionPullRequestNumber(payload: Record<string, unknown>): number {
    const number = payload.number;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) {
        return number;
    }
    return validatePrNumber(number);
}

async function executePullRequestMerge(
    job: ScheduledJob,
    signal: AbortSignal | undefined,
    context: ScheduledJobActionContext
) {
    context.protectFromCancellation();
    const number = executionPullRequestNumber(job.actionPayload);
    const willDeploy = job.actionPayload.willDeploy === true;
    const deploymentLockId = job.actionPayload.deploymentLockId;
    if (
        deploymentLockId !== undefined &&
        (typeof deploymentLockId !== "string" || deploymentLockId.trim() === "")
    ) {
        throw Object.assign(new Error("Deployment lock id is invalid"), {
            statusCode: 400,
        });
    }
    const result = await approvePullRequest(number, willDeploy, {
        lockHeldBy: deploymentLockId,
        signal,
    });
    const message = result.syncError || result.deployError;
    if (message) {
        throw new ScheduledJobActionError(message, { result });
    }
    return { result };
}

/** Registers every mutating GitHub/deploy action exclusively in the worker. */
export function registerPullRequestExecutionActions(): void {
    registerPullRequestJobLifecycleHandlers();
    registerDeploymentCutoverRecoveryHandler(didScheduleOrphanedReleaseCutoverRecovery);
    registerScheduledJobAction("dashboard.deploy", async (job, signal, context) => {
        const deploymentId = job.actionPayload.deploymentId;
        if (typeof deploymentId !== "string" || deploymentId.trim() === "") {
            throw Object.assign(new Error("Deployment id is missing"), {
                statusCode: 400,
            });
        }
        const deployment = readDeploymentJob(deploymentId);
        if (!deployment) {
            throw Object.assign(new Error("Deployment job not found"), {
                statusCode: 404,
            });
        }
        context.protectFromCancellation();
        const isSuccess = await runDeploymentJob(deployment, signal);
        if (!isSuccess) {
            throw new ScheduledJobActionError("Dashboard deploy failed", {
                deploymentId,
            });
        }
        const resumeWorkerClaims = context.pauseWorkerClaims();
        resumeWorkerClaimsWhenDeploymentRestartSettles(deploymentId, resumeWorkerClaims);
        return { deploymentId };
    });
    registerScheduledJobAction("github.merge", executePullRequestMerge);
    registerScheduledJobAction("github.merge-deploy", executePullRequestMerge);
    registerScheduledJobAction("github.review-approval", async (job, signal, context) => {
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await approvePullRequestReview(number, signal),
        };
    });
    registerScheduledJobAction("github.update-branch", async (job, signal, context) => {
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await updatePullRequestBranch(number, signal),
        };
    });
    registerScheduledJobAction("github.reject", async (job, signal, context) => {
        const comment = job.actionPayload.comment;
        if (typeof comment !== "string" || comment.trim() === "") {
            throw Object.assign(new Error("Pull request rejection comment is missing"), {
                statusCode: 400,
            });
        }
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await rejectPullRequest(number, comment, signal),
        };
    });
}
