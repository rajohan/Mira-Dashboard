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
    assertDashboardReleaseHostRuntimeCompatible,
    type ManagedDashboardRelease,
    readDashboardReleaseState,
    resolveDashboardReleasesRoot,
} from "../releaseManager.ts";
import {
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS,
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PREDICATE_SQL,
    ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX,
    RELEASE_READINESS_FAILURE_NOTE_PREFIX,
    ROLLBACK_READINESS_FAILURE_NOTE_PREFIX,
} from "./deploymentRuntimeResults.ts";
import {
    enqueueJobExecution,
    JOB_WORKER_HEARTBEAT_MAX_AGE_MS,
    type JobExecution,
    registerExpiredJobExecutionHandler,
    registerQueuedJobCancellationHandler,
} from "./jobExecutionQueue.ts";
import {
    cleanupClosedPullRequestPreview,
    type PullRequestPreviewCleanupResult,
} from "./pullRequestPreviewHost.ts";
import {
    isPullRequestPreviewAuthorAllowed,
    resolvePullRequestPreviewAllowedAuthors,
} from "./pullRequestPreviewPolicy.ts";
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
const PUBLIC_PR_CACHE_MS = 2 * 60 * 1000;
const PUBLIC_PR_FAILURE_CACHE_MS = 30_000;
const PUBLIC_GITHUB_API_TIMEOUT_MS = 15_000;
const DEPLOYMENT_RESTART_STATUS_POLL_MS = 1000;
const DEPLOYMENT_RESTART_CLAIM_PAUSE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DEPLOYMENT_CUTOVER_CONTEXT_BYTES = 4096;
const DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION = 1;
const DEPLOYMENT_WORKER_STABILITY_SECONDS =
    Math.ceil(JOB_WORKER_HEARTBEAT_MAX_AGE_MS / 1000) + 1;
const PASSING_CHECK_VALUES = new Set(["success", "successful", "neutral", "skipped"]);
const OPINIONATED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const ACTIVE_DEPLOYMENT_STATUSES = new Set(["building", "restart-scheduled"]);
const FULL_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
const BUN_EXECUTABLE = process.env.BUN_BINARY || "bun";
const publicPullRequestCache: {
    failure?: { expiresAt: number; message: string };
    value?: { expiresAt: number; pullRequests: PullRequestSummary[] };
} = {};

function resolveExecutableFromPath(executable: string): string | undefined {
    if (path.isAbsolute(executable)) {
        return executable;
    }
    if (executable.includes(path.sep)) {
        return path.resolve(executable);
    }

    return Bun.which(executable, { PATH: process.env.PATH }) ?? undefined;
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
export interface PullRequestSummary {
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
    previewEligible?: boolean;
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

interface PublicGitHubPullRequest {
    base?: { ref?: unknown };
    body?: unknown;
    created_at?: unknown;
    draft?: unknown;
    head?: { ref?: unknown; sha?: unknown };
    html_url?: unknown;
    number?: unknown;
    title?: unknown;
    updated_at?: unknown;
    user?: { login?: unknown };
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

/** Represents one immutable Dashboard release exposed to the operator UI. */
export interface DashboardReleaseSummary {
    builtAt: string;
    commitSha: string;
    commitTitle: string;
    commitUrl: string;
    schema: {
        maximumCompatible: number;
        minimumCompatible: number;
        target: number;
    };
}

/** Represents the active and immediately rollback-capable release slots. */
export interface DashboardReleaseStatus {
    current?: DashboardReleaseSummary;
    previous?: DashboardReleaseSummary;
    rollback: {
        available: boolean;
        reason?: string;
    };
}

/** Represents production checkout status. */
interface ProductionCheckoutStatus {
    root: string;
    expectedRoot: string;
    worktreeRoot: string;
    branch: string;
    expectedBranch: string;
    head: string;
    headCommit: string;
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

function dashboardCommitUrl(commitSha: string): string {
    return `https://github.com/${DASHBOARD_REPO}/commit/${encodeURIComponent(commitSha)}`;
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
        commitUrl: commit ? dashboardCommitUrl(commit) : undefined,
        note: row.note ?? undefined,
        stdout: row.stdout ?? undefined,
        stderr: row.stderr ?? undefined,
    };
}

interface PublicDeploymentJob extends Omit<DeploymentJob, "status"> {
    status: "building" | "verifying" | "isOk" | "failed";
}

/**
 * Keeps the persisted cutover protocol compatible with the previous release
 * while exposing the work actually in progress to operators.
 */
function publicDeploymentJob(job: DeploymentJob): PublicDeploymentJob {
    return {
        ...job,
        status: job.status === "restart-scheduled" ? "verifying" : job.status,
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
    action_key: string;
    output_json: string;
    status: JobExecution["status"];
}

interface DeploymentCutoverContext {
    candidateCommit: string;
    formatVersion: typeof DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION;
    preActivationCommit: string;
    preActivationPreviousCommit?: string;
    rollbackCommit: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDeploymentCutoverContext(
    candidateCommit: string,
    preActivationCommit: string,
    rollbackCommit: string,
    preActivationPreviousCommit: string | undefined
): DeploymentCutoverContext {
    if (
        !FULL_COMMIT_SHA_PATTERN.test(candidateCommit) ||
        !FULL_COMMIT_SHA_PATTERN.test(preActivationCommit) ||
        !FULL_COMMIT_SHA_PATTERN.test(rollbackCommit)
    ) {
        throw new TypeError("Release cutover context requires full commit SHAs");
    }
    if (rollbackCommit === candidateCommit) {
        throw new TypeError(
            "Release cutover context requires a distinct rollback commit"
        );
    }
    if (
        preActivationPreviousCommit !== undefined &&
        (preActivationPreviousCommit === preActivationCommit ||
            !FULL_COMMIT_SHA_PATTERN.test(preActivationPreviousCommit))
    ) {
        throw new TypeError(
            "Release cutover context requires a distinct full pre-activation previous SHA"
        );
    }
    if (candidateCommit === preActivationCommit) {
        if (rollbackCommit !== preActivationPreviousCommit) {
            throw new TypeError(
                "Redeploy cutover context requires the pre-activation previous release as rollback target"
            );
        }
    } else if (rollbackCommit !== preActivationCommit) {
        throw new TypeError(
            "New release cutover context requires the pre-activation current release as rollback target"
        );
    }
    return {
        candidateCommit,
        formatVersion: DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION,
        preActivationCommit,
        ...(preActivationPreviousCommit && { preActivationPreviousCommit }),
        rollbackCommit,
    };
}

function parseDeploymentCutoverContext(
    outputJson: string,
    expectedDeploymentId: string,
    expectedCandidateCommit: string
): DeploymentCutoverContext | undefined {
    if (Buffer.byteLength(outputJson, "utf8") > MAX_DEPLOYMENT_CUTOVER_CONTEXT_BYTES) {
        return undefined;
    }
    let output: unknown;
    try {
        output = JSON.parse(outputJson) as unknown;
    } catch {
        return undefined;
    }
    if (
        !isRecord(output) ||
        output.deploymentId !== expectedDeploymentId ||
        !isRecord(output.releaseCutover)
    ) {
        return undefined;
    }
    const value = output.releaseCutover;
    const allowedKeys = new Set([
        "candidateCommit",
        "formatVersion",
        "preActivationCommit",
        "preActivationPreviousCommit",
        "rollbackCommit",
    ]);
    if (
        Object.keys(value).some((key) => !allowedKeys.has(key)) ||
        value.formatVersion !== DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION ||
        typeof value.candidateCommit !== "string" ||
        value.candidateCommit !== expectedCandidateCommit ||
        typeof value.preActivationCommit !== "string" ||
        typeof value.rollbackCommit !== "string" ||
        (value.preActivationPreviousCommit !== undefined &&
            typeof value.preActivationPreviousCommit !== "string")
    ) {
        return undefined;
    }
    try {
        return createDeploymentCutoverContext(
            value.candidateCommit,
            value.preActivationCommit,
            value.rollbackCommit,
            value.preActivationPreviousCommit
        );
    } catch {
        return undefined;
    }
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
            `SELECT action_key, output_json, status
             FROM job_executions
             WHERE json_valid(payload_json)
               AND (
                   (
                       action_key IN ('dashboard.deploy', 'dashboard.rollback')
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

/** Releases the active release lock if it still belongs to the given job. */
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
    if (
        execution.actionKey === "dashboard.deploy" ||
        execution.actionKey === "dashboard.rollback"
    ) {
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
        execution.actionKey === "dashboard.rollback"
            ? "Rollback cancelled before execution"
            : "Deploy cancelled before execution"
    );
}

function cleanupExpiredDeploymentExecution(execution: JobExecution): void {
    cleanupTerminatedDeploymentExecution(
        execution,
        execution.finishedAt ?? dateToISOString(new Date()),
        execution.actionKey === "dashboard.rollback"
            ? execution.status === "cancelled"
                ? "Rollback cancelled after its worker lease expired"
                : "Rollback failed after its worker lease expired"
            : execution.status === "cancelled"
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
        "dashboard.rollback",
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
    registerExpiredJobExecutionHandler(
        "dashboard.rollback",
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
            throw new Error(
                `Dashboard release action already in progress (${activeJobId})`
            );
        }
        if (lockExecution && activeJob?.status === "building") {
            writeDeploymentJob({
                ...activeJob,
                note:
                    lockExecution.action_key === "dashboard.rollback"
                        ? "Rollback execution ended before build completion"
                        : "Deploy execution ended before build completion",
                status: "failed",
                updatedAt: dateToISOString(new Date()),
            });
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            return;
        }
        if (!activeJob) {
            if (!lockExecution && !isDeploymentLockStale(activeLock)) {
                throw new Error(
                    `Dashboard release action already in progress (${activeJobId})`
                );
            }
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
        } else if (
            ACTIVE_DEPLOYMENT_STATUSES.has(activeJob.status) &&
            !isDeploymentJobStale(activeJob)
        ) {
            throw new Error(
                `Dashboard release action already in progress (${activeJob.id})`
            );
        } else {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
        }
    }
}

/** Acquires the active release lock for a deployment or rollback job. */
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
            throw new Error("Dashboard release action already in progress", {
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
        throw new Error("Dashboard release lock ownership was lost");
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
export function readDeploymentJobs(): PublicDeploymentJob[] {
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
    ).map((row) => publicDeploymentJob(mapDeploymentJob(row)));
}

interface DeploymentRuntimeResultRow {
    note: string | null;
    status: DeploymentJob["status"];
}

/**
 * Rejects a previous slot whose latest meaningful runtime result failed
 * readiness. Build failures and cancelled jobs do not disqualify an otherwise
 * verified immutable release.
 */
function rollbackIneligibilityReason(
    commitSha: string,
    excludedJobId?: string
): string | undefined {
    const row = database
        .prepare(
            `
            SELECT status, note
            FROM deployment_jobs
            WHERE commit_sha = ?
              ${excludedJobId ? "AND id <> ?" : ""}
              AND (
                  status = 'isOk'
                  OR (
                      status = 'failed'
                      AND (
                          ${DEPLOYMENT_RUNTIME_FAILURE_NOTE_PREDICATE_SQL}
                      )
                  )
              )
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            `
        )
        .get(
            commitSha,
            ...(excludedJobId ? [excludedJobId] : []),
            ...DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS
        ) as DeploymentRuntimeResultRow | undefined;
    return row?.status === "failed"
        ? "Previous release failed its latest runtime readiness check"
        : undefined;
}

function dashboardReleaseSummary(
    release: ManagedDashboardRelease
): DashboardReleaseSummary {
    return {
        builtAt: release.manifest.builtAt,
        commitSha: release.commitSha,
        commitTitle: release.manifest.commitTitle,
        commitUrl: dashboardCommitUrl(release.commitSha),
        schema: {
            maximumCompatible: release.manifest.schema.maximumCompatible,
            minimumCompatible: release.manifest.schema.minimumCompatible,
            target: release.manifest.schema.target,
        },
    };
}

/** Reads the managed production release slots without exposing host paths. */
export async function getDashboardReleaseStatus(): Promise<DashboardReleaseStatus> {
    const state = await readDashboardReleaseState(resolveDashboardReleasesRoot());
    const current = state.current ? dashboardReleaseSummary(state.current) : undefined;
    const previous = state.previous ? dashboardReleaseSummary(state.previous) : undefined;
    const isRollbackAvailable =
        current !== undefined &&
        previous !== undefined &&
        current.commitSha !== previous.commitSha;
    const runtimeIneligibilityReason =
        isRollbackAvailable && previous
            ? rollbackIneligibilityReason(previous.commitSha)
            : undefined;

    return {
        current,
        previous,
        rollback: {
            available: isRollbackAvailable && !runtimeIneligibilityReason,
            ...((!isRollbackAvailable || runtimeIneligibilityReason) && {
                reason:
                    runtimeIneligibilityReason ??
                    (current
                        ? "No distinct previous release is available"
                        : "No active managed release is available"),
            }),
        },
    };
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

function configuredGithubReadToken(): string {
    return (
        process.env.MIRA_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim() ||
        ""
    );
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
    const previewAllowedAuthors = resolvePullRequestPreviewAllowedAuthors(
        process.env.MIRA_DASHBOARD_PREVIEW_ALLOWED_AUTHORS
    );

    return {
        ...rest,
        canReviewerApprove: canReviewerApprove(pr),
        previewEligible:
            pr.baseRefName === DEFAULT_BASE &&
            isPullRequestPreviewAuthorAllowed(pr.author?.login, previewAllowedAuthors) &&
            typeof pr.headRefOid === "string" &&
            FULL_COMMIT_SHA_PATTERN.test(pr.headRefOid),
        reviewerApproved: isPullRequestReviewApproved(pr),
    };
}

/** Parses the bounded public REST shape used only by credential-free dev previews. */
export function parsePublicGithubPullRequests(value: unknown): PullRequestSummary[] {
    if (!Array.isArray(value) || value.length > 100) {
        throw new Error("GitHub public pull request response is invalid");
    }
    return value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("GitHub public pull request response is invalid");
        }
        const pullRequest = entry as PublicGitHubPullRequest;
        if (
            !Number.isSafeInteger(pullRequest.number) ||
            Number(pullRequest.number) <= 0 ||
            typeof pullRequest.title !== "string" ||
            typeof pullRequest.html_url !== "string" ||
            typeof pullRequest.head?.ref !== "string" ||
            typeof pullRequest.head.sha !== "string" ||
            !FULL_COMMIT_SHA_PATTERN.test(pullRequest.head.sha) ||
            typeof pullRequest.base?.ref !== "string" ||
            typeof pullRequest.user?.login !== "string" ||
            typeof pullRequest.created_at !== "string" ||
            typeof pullRequest.updated_at !== "string" ||
            typeof pullRequest.draft !== "boolean"
        ) {
            throw new Error("GitHub public pull request response is invalid");
        }
        return normalizePullRequest({
            author: { login: pullRequest.user.login },
            baseRefName: pullRequest.base.ref,
            body: typeof pullRequest.body === "string" ? pullRequest.body : undefined,
            createdAt: pullRequest.created_at,
            headRefName: pullRequest.head.ref,
            headRefOid: pullRequest.head.sha,
            isDraft: pullRequest.draft,
            number: Number(pullRequest.number),
            statusCheckRollup: [],
            title: pullRequest.title,
            updatedAt: pullRequest.updated_at,
            url: pullRequest.html_url,
        });
    });
}

async function readBoundedJsonResponse(
    response: Response,
    maximumBytes: number
): Promise<unknown> {
    if (!response.body) {
        throw new Error("GitHub public pull request response was empty");
    }
    const reader = response.body.getReader();
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
            `https://api.github.com/repos/${DASHBOARD_REPO}/pulls?state=open&base=${DEFAULT_BASE}&per_page=100`,
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
    if (
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE === "1" &&
        !configuredGithubReadToken()
    ) {
        return listPublicDashboardPullRequests();
    }
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

/** Checks the PR lifecycle without filtering by its current base branch. */
export async function isDashboardPullRequestOpen(
    number: number,
    signal?: AbortSignal
): Promise<boolean> {
    const result = await runGhJson<{ state?: unknown }>(
        ["pr", "view", String(number), "--repo", DASHBOARD_REPO, "--json", "state"],
        signal
    );
    if (
        typeof result.state !== "string" ||
        !["CLOSED", "MERGED", "OPEN"].includes(result.state)
    ) {
        throw new Error("GitHub returned an invalid pull request state");
    }
    return result.state === "OPEN";
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
            runCommand("git", ["rev-parse", "HEAD"], {
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
        head: head.trim().slice(0, 8),
        headCommit: head.trim(),
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
const job = {
    ...JSON.parse(process.env.MIRA_DEPLOYMENT_JOB || "{}"),
    updatedAt: new Date().toISOString(),
};
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
    cutover: DeploymentCutoverContext,
    signal?: AbortSignal
): Promise<CommandResult> {
    const {
        candidateCommit,
        preActivationCommit,
        preActivationPreviousCommit,
        rollbackCommit,
    } = cutover;
    if (!job.commit || !FULL_COMMIT_SHA_PATTERN.test(job.commit)) {
        throw new TypeError("Release cutover requires a full candidate commit");
    }
    if (
        !FULL_COMMIT_SHA_PATTERN.test(candidateCommit) ||
        candidateCommit !== job.commit
    ) {
        throw new TypeError("Release cutover requires the matching full candidate SHA");
    }
    if (!FULL_COMMIT_SHA_PATTERN.test(preActivationCommit)) {
        throw new TypeError("Release cutover requires a full pre-activation commit");
    }
    if (
        rollbackCommit === candidateCommit ||
        !FULL_COMMIT_SHA_PATTERN.test(rollbackCommit)
    ) {
        throw new TypeError("Release cutover requires a distinct full rollback commit");
    }
    if (
        preActivationPreviousCommit !== undefined &&
        (preActivationPreviousCommit === preActivationCommit ||
            !FULL_COMMIT_SHA_PATTERN.test(preActivationPreviousCommit))
    ) {
        throw new TypeError(
            "Release cutover requires a distinct full pre-activation previous SHA"
        );
    }
    const isNewActivation = candidateCommit !== preActivationCommit;
    if (isNewActivation && rollbackCommit !== preActivationCommit) {
        throw new TypeError(
            "New release cutover requires the pre-activation current release as rollback target"
        );
    }
    const releasesRoot = resolveDashboardReleasesRoot();
    const activationLifecycleCommand = path.join(
        releasesRoot,
        "releases",
        preActivationCommit,
        "backend",
        "dist",
        "releaseLifecycle.js"
    );
    const guardedLifecycleCommand = path.join(
        releasesRoot,
        "releases",
        candidateCommit,
        "backend",
        "dist",
        "releaseLifecycle.js"
    );
    const activationLifecycleEnvironment = releaseLifecycleInvocation(
        releasesRoot,
        activationLifecycleCommand
    );
    const guardedLifecycleEnvironment = releaseLifecycleInvocation(
        releasesRoot,
        guardedLifecycleCommand
    );
    const restoreCommand = isNewActivation
        ? [
              guardedLifecycleEnvironment,
              "restore",
              shellQuote(candidateCommit),
              shellQuote(rollbackCommit),
              ...(preActivationPreviousCommit
                  ? [shellQuote(preActivationPreviousCommit)]
                  : []),
          ].join(" ")
        : `${guardedLifecycleEnvironment} rollback ${shellQuote(candidateCommit)} ${shellQuote(rollbackCommit)}`;
    const candidateShort = candidateCommit.slice(0, 8);
    const rollbackShort = rollbackCommit.slice(0, 8);
    const okJob: DeploymentJob = {
        ...job,
        status: "isOk",
        updatedAt: dateToISOString(new Date()),
        note: `Atomic release activated. Web, worker, commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS}-second worker stability checks passed`,
    };
    const okWithRetentionWarningJob: DeploymentJob = {
        ...okJob,
        note: `Atomic release activated and verified, including ${DEPLOYMENT_WORKER_STABILITY_SECONDS}-second worker stability; release retention cleanup failed`,
    };
    const rolledBackJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: isNewActivation
            ? `${RELEASE_READINESS_FAILURE_NOTE_PREFIX}; automatic rollback restored the exact pre-deploy release slots with ${rollbackShort} active`
            : `${RELEASE_READINESS_FAILURE_NOTE_PREFIX}; automatic rollback activated the previous verified release ${rollbackShort}`,
    };
    const rollbackFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: `${RELEASE_READINESS_FAILURE_NOTE_PREFIX} and automatic rollback to ${rollbackShort} failed`,
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
        `if ${activationLifecycleEnvironment} activate ${shellQuote(candidateCommit)}; then`,
        `  if restart_services && ready_for_commit ${shellQuote(candidateShort)}; then`,
        `    if ${activationLifecycleEnvironment} prune 3; then`,
        `      ${deploymentJobUpdateCommand(okJob)}`,
        "    else",
        `      ${deploymentJobUpdateCommand(okWithRetentionWarningJob)}`,
        "    fi",
        "  else",
        `    if ${restoreCommand} && restart_services && ready_for_commit ${shellQuote(rollbackShort)}; then`,
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
            "--expand-environment=no",
            `--unit=mira-dashboard-deploy-${job.id}`,
            "--description=Mira Dashboard atomic release cutover",
            "/bin/bash",
            "-lc",
            script,
        ],
        { signal, timeoutMs: 30_000 }
    );
}

/** Schedules a detached current/previous swap with readiness-bound restoration. */
async function scheduleReleaseRollback(
    job: DeploymentJob,
    targetCommit: string,
    originalCommit: string,
    signal?: AbortSignal
): Promise<CommandResult> {
    if (
        !job.commit ||
        !FULL_COMMIT_SHA_PATTERN.test(job.commit) ||
        job.commit !== targetCommit
    ) {
        throw new TypeError("Release rollback requires its matching full target SHA");
    }
    if (
        originalCommit === targetCommit ||
        !FULL_COMMIT_SHA_PATTERN.test(originalCommit)
    ) {
        throw new TypeError(
            "Release rollback requires a distinct full original release SHA"
        );
    }

    const releasesRoot = resolveDashboardReleasesRoot();
    const lifecycleCommand = path.join(
        releasesRoot,
        "releases",
        originalCommit,
        "backend",
        "dist",
        "releaseLifecycle.js"
    );
    const lifecycleEnvironment = releaseLifecycleInvocation(
        releasesRoot,
        lifecycleCommand
    );
    const targetShort = targetCommit.slice(0, 8);
    const originalShort = originalCommit.slice(0, 8);
    const okJob: DeploymentJob = {
        ...job,
        status: "isOk",
        updatedAt: dateToISOString(new Date()),
        note: `Atomic rollback activated ${targetShort}. Web, worker, commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS}-second worker stability checks passed`,
    };
    const restoredJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: `${ROLLBACK_READINESS_FAILURE_NOTE_PREFIX}. Original release ${originalShort} was restored automatically`,
    };
    const restorationFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: `${ROLLBACK_READINESS_FAILURE_NOTE_PREFIX} and restoration of ${originalShort} failed`,
    };
    const transitionFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Atomic rollback failed before restart. Current release was left unchanged",
    };

    const script = [
        "sleep 2",
        ...releaseCutoverShellFunctions(),
        `if ${lifecycleEnvironment} rollback ${shellQuote(originalCommit)} ${shellQuote(targetCommit)}; then`,
        `  if restart_services && ready_for_commit ${shellQuote(targetShort)}; then`,
        `    ${deploymentJobUpdateCommand(okJob)}`,
        "  else",
        `    if ${lifecycleEnvironment} rollback ${shellQuote(targetCommit)} ${shellQuote(originalCommit)} && restart_services && ready_for_commit ${shellQuote(originalShort)}; then`,
        `      ${deploymentJobUpdateCommand(restoredJob)}`,
        "    else",
        `      ${deploymentJobUpdateCommand(restorationFailedJob)}`,
        "    fi",
        "  fi",
        "else",
        `  ${deploymentJobUpdateCommand(transitionFailedJob)}`,
        "fi",
    ].join("\n");

    return runCommand(
        "systemd-run",
        [
            "--user",
            "--collect",
            "--expand-environment=no",
            `--unit=mira-dashboard-deploy-${job.id}`,
            "--description=Mira Dashboard atomic release rollback",
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
        !FULL_COMMIT_SHA_PATTERN.test(candidateCommit) ||
        job.commit !== candidateCommit
    ) {
        throw new Error(
            "Orphaned release cutover recovery requires its persisted full candidate SHA"
        );
    }

    const releasesRoot = resolveDashboardReleasesRoot();
    const recoveryExecution = readDeploymentLockExecution(cutover.id);
    const isRollbackAction = recoveryExecution?.action_key === "dashboard.rollback";
    const persistedCutover =
        recoveryExecution?.action_key === "dashboard.deploy"
            ? parseDeploymentCutoverContext(
                  recoveryExecution.output_json,
                  cutover.id,
                  candidateCommit
              )
            : undefined;
    const willRestoreExactPreActivationSlots =
        persistedCutover !== undefined &&
        persistedCutover.candidateCommit !== persistedCutover.preActivationCommit;
    const recoveryMode = willRestoreExactPreActivationSlots
        ? "restore"
        : isRollbackAction
          ? "rollback"
          : "legacy-rollback";
    const rolledBackJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: willRestoreExactPreActivationSlots
            ? `${ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX} the exact pre-deploy release slots`
            : `${ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX} the previous verified release`,
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
        note: `Interrupted release cutover recovered; active candidate passed restart, commit-bound readiness, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS}-second worker stability`,
    };
    const script = [
        "sleep 1",
        ...releaseCutoverShellFunctions(),
        `releases_root=${shellQuote(releasesRoot)}`,
        `candidate_commit=${shellQuote(candidateCommit)}`,
        `recovery_mode=${shellQuote(recoveryMode)}`,
        `expected_rollback_commit=${shellQuote(persistedCutover?.rollbackCommit ?? "")}`,
        `pre_activation_previous_commit=${shellQuote(
            persistedCutover?.preActivationPreviousCommit ?? ""
        )}`,
        `bun_executable=${shellQuote(resolveBunExecutable())}`,
        "resolve_trusted_lifecycles() {",
        '  candidate_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/releases/$candidate_commit") || return 1',
        '  [ "$candidate_release" = "$releases_root/releases/$candidate_commit" ] || return 1',
        '  candidate_lifecycle="$candidate_release/backend/dist/releaseLifecycle.js"',
        '  [ -f "$candidate_lifecycle" ] && [ ! -L "$candidate_lifecycle" ] || return 1',
        '  current_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/current") || return 1',
        '  current_commit="$(/usr/bin/basename -- "$current_release")"',
        '  [[ "$current_commit" =~ ^[0-9a-f]{40}$ ]] || return 1',
        '  [ "$current_release" = "$releases_root/releases/$current_commit" ] || return 1',
        '  if [ "$current_commit" = "$candidate_commit" ]; then',
        '    if [ -e "$releases_root/previous" ] || [ -L "$releases_root/previous" ]; then',
        '      activation_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/previous") || return 1',
        "    else",
        '      activation_release="$candidate_release"',
        "    fi",
        "  else",
        '    activation_release="$current_release"',
        "  fi",
        '  activation_commit="$(/usr/bin/basename -- "$activation_release")"',
        '  [[ "$activation_commit" =~ ^[0-9a-f]{40}$ ]] || return 1',
        '  [ "$activation_release" = "$releases_root/releases/$activation_commit" ] || return 1',
        '  activation_lifecycle="$activation_release/backend/dist/releaseLifecycle.js"',
        '  [ -f "$activation_lifecycle" ] && [ ! -L "$activation_lifecycle" ]',
        "}",
        "run_activation_lifecycle() {",
        '  MIRA_DASHBOARD_RELEASES_ROOT="$releases_root" \\',
        `  MIRA_DASHBOARD_DB_PATH=${shellQuote(getMiraDatabasePath())} \\`,
        "  NODE_ENV=production \\",
        '  "$bun_executable" "$activation_lifecycle" "$@"',
        "}",
        "run_candidate_lifecycle() {",
        '  MIRA_DASHBOARD_RELEASES_ROOT="$releases_root" \\',
        `  MIRA_DASHBOARD_DB_PATH=${shellQuote(getMiraDatabasePath())} \\`,
        "  NODE_ENV=production \\",
        '  "$bun_executable" "$candidate_lifecycle" "$@"',
        "}",
        "restore_failed_candidate() {",
        '  case "$recovery_mode" in',
        "    restore)",
        '      [ "$rollback_commit" = "$expected_rollback_commit" ] || return 1',
        '      if [ -n "$pre_activation_previous_commit" ]; then',
        '        run_candidate_lifecycle restore "$candidate_commit" "$rollback_commit" "$pre_activation_previous_commit"',
        "      else",
        '        run_candidate_lifecycle restore "$candidate_commit" "$rollback_commit"',
        "      fi",
        "      ;;",
        "    rollback)",
        '      run_activation_lifecycle rollback "$candidate_commit" "$rollback_commit"',
        "      ;;",
        "    legacy-rollback)",
        '      run_candidate_lifecycle rollback "$candidate_commit" "$rollback_commit"',
        "      ;;",
        "    *) return 1 ;;",
        "  esac",
        "}",
        "resolve_trusted_lifecycles || exit 1",
        'if activation_output="$(run_activation_lifecycle activate "$candidate_commit")"; then',
        '  activation_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.current.commitSha // empty\')"',
        '  [ "$activation_commit" = "$candidate_commit" ] || exit 1',
        '  if restart_services && ready_for_commit "${candidate_commit:0:8}"; then',
        `    ${deploymentJobUpdateCommand(activeCandidateRecoveredJob)}`,
        "    exit 0",
        "  fi",
        '  rollback_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.previous.commitSha // empty\')"',
        '  [[ "$rollback_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '  [ "$rollback_commit" != "$candidate_commit" ] || exit 1',
        '  if restore_failed_candidate && restart_services && ready_for_commit "${rollback_commit:0:8}"; then',
        `    ${deploymentJobUpdateCommand(rolledBackJob)}`,
        "  else",
        "    exit 1",
        "  fi",
        "else",
        '  status_output="$(run_activation_lifecycle status)" || exit 1',
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
            "--expand-environment=no",
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
    persistCutover: (cutover: DeploymentCutoverContext) => void,
    signal?: AbortSignal
): Promise<DeploymentCutoverContext | undefined> {
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
            throw new Error("Managed deployment requires an active current release");
        }
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const { stdout: commitSha } = await runCommand("git", ["rev-parse", "HEAD"], {
            signal,
            timeoutMs: 30_000,
        });
        const expectedCommit = commitSha.trim();
        const isRedeploy = currentState.current.commitSha === expectedCommit;
        const rollbackRelease = isRedeploy ? currentState.previous : currentState.current;
        if (!rollbackRelease || rollbackRelease.commitSha === expectedCommit) {
            throw new Error(
                "Managed deployment requires a distinct verified rollback release"
            );
        }
        if (isRedeploy) {
            const runtimeIneligibilityReason = rollbackIneligibilityReason(
                rollbackRelease.commitSha,
                job.id
            );
            if (runtimeIneligibilityReason) {
                throw new Error(
                    `Automatic redeploy fallback is not eligible: ${runtimeIneligibilityReason}`
                );
            }
        }
        assertDashboardReleaseHostRuntimeCompatible(rollbackRelease);

        const candidate = await stageDashboardRelease(expectedCommit, {
            bunExecutable: resolveBunExecutable(),
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
        const releaseCutover = createDeploymentCutoverContext(
            expectedCommit,
            currentState.current.commitSha,
            rollbackRelease.commitSha,
            currentState.previous?.commitSha
        );
        persistCutover(releaseCutover);

        const cutoverJob: DeploymentJob = {
            ...currentJob,
            status: "restart-scheduled",
            updatedAt: dateToISOString(new Date()),
            commit: candidate.manifest.commitSha,
            commitTitle: candidate.manifest.commitTitle,
            note: `Release published. Activating it, restarting services, then verifying web, worker, deployed commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS} seconds of worker stability; automatic rollback is armed`,
        };
        writeDeploymentJob(cutoverJob);
        await scheduleReleaseCutover(cutoverJob, releaseCutover, signal);
        return releaseCutover;
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
        return undefined;
    }
}

/** Validates and schedules a managed rollback after the API has returned its job. */
async function runRollbackJob(
    job: DeploymentJob,
    signal?: AbortSignal
): Promise<boolean> {
    let currentJob = job;
    const releasesRoot = resolveDashboardReleasesRoot();
    try {
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await assertManagedDashboardServiceContract(signal);
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const state = await readDashboardReleaseState(releasesRoot);
        if (!state.current || !state.previous) {
            throw new Error(
                "Managed release rollback requires active current and previous releases"
            );
        }
        if (!job.commit || state.previous.commitSha !== job.commit) {
            throw new Error(
                "Rollback target changed before execution. Refresh release status and try again"
            );
        }
        if (state.current.commitSha === state.previous.commitSha) {
            throw new Error("Managed release rollback requires two distinct releases");
        }
        const runtimeIneligibilityReason = rollbackIneligibilityReason(
            state.previous.commitSha,
            job.id
        );
        if (runtimeIneligibilityReason) {
            throw new Error(
                `Previous release is not eligible for rollback: ${runtimeIneligibilityReason}`
            );
        }
        assertDashboardReleaseHostRuntimeCompatible(state.previous);

        const cutoverJob: DeploymentJob = {
            ...currentJob,
            status: "restart-scheduled",
            updatedAt: dateToISOString(new Date()),
            commit: state.previous.commitSha,
            commitTitle: state.previous.manifest.commitTitle,
            note: `Rollback target verified. Activating it, restarting services, then verifying web, worker, deployed commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS} seconds of worker stability; automatic restoration is armed`,
        };
        writeDeploymentJob(cutoverJob);
        await scheduleReleaseRollback(
            cutoverJob,
            state.previous.commitSha,
            state.current.commitSha,
            signal
        );
        return true;
    } catch (error) {
        const failed: DeploymentJob = {
            ...currentJob,
            status: "failed",
            updatedAt: dateToISOString(new Date()),
            note: errorMessage(error, "Rollback failed"),
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

/** Validates the confirmed target against current release slots and queues rollback. */
export async function prepareAndStartRollback(
    expectedTargetCommit: string
): Promise<DeploymentJob> {
    if (!FULL_COMMIT_SHA_PATTERN.test(expectedTargetCommit)) {
        throw Object.assign(
            new TypeError("Rollback target must be a full lowercase commit SHA"),
            { statusCode: 400 }
        );
    }
    registerPullRequestJobLifecycleHandlers();
    const now = dateToISOString(new Date());
    const deploymentId = Bun.randomUUIDv7();
    let job: DeploymentJob | undefined;
    acquireDeploymentLock(deploymentId);
    try {
        const state = await readDashboardReleaseState(resolveDashboardReleasesRoot());
        if (!state.current || !state.previous) {
            throw Object.assign(
                new Error(
                    "Managed release rollback requires active current and previous releases"
                ),
                { statusCode: 409 }
            );
        }
        if (state.current.commitSha === state.previous.commitSha) {
            throw Object.assign(
                new Error("Managed release rollback requires two distinct releases"),
                { statusCode: 409 }
            );
        }
        if (state.previous.commitSha !== expectedTargetCommit) {
            throw Object.assign(
                new Error(
                    "Rollback target changed. Refresh release status and confirm the current previous release"
                ),
                { statusCode: 409 }
            );
        }
        const runtimeIneligibilityReason = rollbackIneligibilityReason(
            state.previous.commitSha
        );
        if (runtimeIneligibilityReason) {
            throw Object.assign(
                new Error(
                    `Previous release is not eligible for rollback: ${runtimeIneligibilityReason}`
                ),
                { statusCode: 409 }
            );
        }
        assertDashboardReleaseHostRuntimeCompatible(state.previous);

        job = {
            id: deploymentId,
            status: "building",
            startedAt: now,
            updatedAt: now,
            commit: state.previous.commitSha,
            commitTitle: state.previous.manifest.commitTitle,
            note: `Rollback to ${state.previous.commitSha.slice(0, 8)} queued`,
        };
        writeDeploymentJob(job);
        enqueueJobExecution({
            actionKey: "dashboard.rollback",
            displayName: `Roll back Mira Dashboard to ${state.previous.commitSha.slice(0, 8)}`,
            payload: { deploymentId: job.id },
            resourceClass: "exclusive",
            timeoutMs: 15 * 60 * 1000,
        });
        return job;
    } catch (error) {
        releaseDeploymentLock(deploymentId);
        if (job) {
            try {
                writeDeploymentJob({
                    ...job,
                    note: errorMessage(error, "Dashboard rollback failed to queue"),
                    status: "failed",
                    updatedAt: dateToISOString(new Date()),
                });
            } catch {
                // Preserve the original rollback validation or queue error.
            }
        }
        throw error;
    }
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
    let previewCleanup: PullRequestPreviewCleanupResult;

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
        // The production entry point runs this inside the exclusive github.merge job,
        // which shares the single-capacity worker with every preview lifecycle action.
        previewCleanup = await cleanupClosedPullRequestPreview(number);

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
        previewCleanup,
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
    // The production entry point runs this inside the exclusive github.reject job,
    // which shares the single-capacity worker with every preview lifecycle action.
    const previewCleanup = await cleanupClosedPullRequestPreview(number);

    return {
        isOk: true,
        message: `PR #${number} closed`,
        cleanup,
        previewCleanup,
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

/** Registers every mutating GitHub/release action exclusively in the worker. */
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
        const releaseCutover = await runDeploymentJob(
            deployment,
            (nextCutover) => {
                context.updateOutput({
                    deploymentId,
                    releaseCutover: nextCutover,
                });
            },
            signal
        );
        if (!releaseCutover) {
            throw new ScheduledJobActionError("Dashboard deploy failed", {
                deploymentId,
            });
        }
        const resumeWorkerClaims = context.pauseWorkerClaims();
        resumeWorkerClaimsWhenDeploymentRestartSettles(deploymentId, resumeWorkerClaims);
        return { deploymentId, releaseCutover };
    });
    registerScheduledJobAction("dashboard.rollback", async (job, signal, context) => {
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
        const isSuccess = await runRollbackJob(deployment, signal);
        if (!isSuccess) {
            throw new ScheduledJobActionError("Dashboard rollback failed", {
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
