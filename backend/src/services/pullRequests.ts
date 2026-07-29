import path from "node:path";

import type {
    DashboardReleaseStatus,
    DashboardReleaseSummary,
    DeploymentJob,
    ProductionCheckoutStatus,
    PullRequestPreviewCleanupResult,
    PullRequestSummary,
    WorktreeCleanupResult,
} from "../../../contracts/delivery.ts";
import {
    parseGitHubPullRequestState,
    parsePublicGitHubPullRequests,
    parsePullRequestSummary,
} from "../../../contracts/delivery.ts";
import type { ScheduledJob } from "../../../contracts/jobs.ts";
import type { ContractParser } from "../../../contracts/runtime.ts";
import { database, getMiraDatabasePath, sqlNullable } from "../database.ts";
import { byteStreamReader } from "../lib/byteStreams.ts";
import { resolveDashboardProjectPaths } from "../lib/dashboardPaths.ts";
import { errorMessage } from "../lib/errors.ts";
import {
    killProcessGroup,
    pipeProcessOutput,
    resolveBunExecutable,
    runProcess,
    spawnProcess,
} from "../lib/processes.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { nonEmptyEnvironmentFallback } from "../lib/values.ts";
import {
    assertManagedDashboardUnitProperties,
    MANAGED_DASHBOARD_UNITS,
    managedDashboardUnitContract,
    stageDashboardRelease,
} from "../releaseDeployment.ts";
import {
    assertDashboardReleaseRuntimeAvailable,
    assertManagedDashboardReleaseRollbackSchemaCompatible,
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
    type JobExecutionRecord,
    registerExpiredJobExecutionHandler,
    registerQueuedJobCancellationHandler,
} from "./jobExecutionQueue.ts";
import { cleanupClosedPullRequestPreview } from "./pullRequestPreviewHost.ts";
import {
    isPullRequestPreviewAuthorAllowed,
    resolvePullRequestPreviewAllowedAuthors,
} from "./pullRequestPreviewPolicy.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "./queuedJobExecution.ts";

const logger = createStructuredLogger("pull-requests");

/**
 * Describes the outcome of merging a pull request and starting deployment.
 *
 * @param number - Pull request number.
 * @param willDeploy - Whether deployment was requested.
 * @param syncError - Production checkout synchronization error, when present.
 * @param deployError - Deployment startup error, when present.
 * @returns User-facing merge result message.
 */
function pullRequestMergeMessage(
    number: number,
    willDeploy: boolean,
    syncError: string | undefined,
    deployError: string | undefined
): string {
    if (syncError) {
        return `PR #${number} merged. Production sync failed`;
    }
    if (deployError) {
        return `PR #${number} merged. Deploy failed to start`;
    }
    return willDeploy ? `PR #${number} merged. Deploy started` : `PR #${number} merged`;
}

import {
    type OrphanedDeploymentCutover,
    registerDeploymentCutoverRecoveryHandler,
    registerScheduledJobAction,
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
// Must exceed scheduled-job interrupted-handler cleanup before final status is durable.
const DEPLOYMENT_CUTOVER_HANDOFF_TIMEOUT_MS = 75_000;
const MAX_DEPLOYMENT_CUTOVER_CONTEXT_BYTES = 4096;
const DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION = 2;
const DEPLOYMENT_WORKER_STABILITY_SECONDS =
    Math.ceil(JOB_WORKER_HEARTBEAT_MAX_AGE_MS / 1000) + 1;
const PASSING_CHECK_VALUES = new Set(["success", "successful", "neutral", "skipped"]);
const OPINIONATED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const ACTIVE_DEPLOYMENT_STATUSES = new Set(["building", "verifying"]);
const FULL_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
const SQLITE_CUTOVER_SNAPSHOT_ID_PATTERN =
    /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const publicPullRequestCache: {
    failure?: { expiresAt: number; message: string };
    value?: { expiresAt: number; pullRequests: PullRequestSummary[] };
} = {};

export function getResolvedRoots() {
    return {
        dashboardRoot: getDashboardRoot(),
        dashboardWorktreeRoot: getDashboardWorktreeRoot(),
    };
}

function getDashboardRoot(): string {
    return process.env.NODE_ENV === "production"
        ? resolveDashboardProjectPaths().productionCheckoutRoot
        : resolveConfiguredRoot(
              "MIRA_DASHBOARD_ROOT",
              resolveDashboardProjectPaths().productionCheckoutRoot
          );
}

function getDashboardWorktreeRoot(): string {
    return process.env.NODE_ENV === "production"
        ? resolveDashboardProjectPaths().developmentWorktreeRoot
        : resolveConfiguredRoot(
              "MIRA_DASHBOARD_WORKTREE_ROOT",
              resolveDashboardProjectPaths().developmentWorktreeRoot
          );
}

/** Represents command result. */
interface CommandResult {
    stdout: string;
    stderr: string;
}

/** Represents Git worktree. */
interface GitWorktree {
    path: string;
    branch?: string;
    head?: string;
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

/**
 * Reads one deployment job.
 * @param jobId Job identifier.
 * @returns Read one deployment job.
 */
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

/**
 * Checks whether an active deployment lock is stale enough to replace.
 * @returns Whether the deployment job is stale.
 */
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
    status: JobExecutionRecord["status"];
}

interface DeploymentCutoverContext {
    candidateCommit: string;
    databaseSnapshotId: string;
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
    databaseSnapshotId: string,
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
    if (!SQLITE_CUTOVER_SNAPSHOT_ID_PATTERN.test(databaseSnapshotId)) {
        throw new TypeError("Release cutover context requires a lowercase UUIDv7");
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
        databaseSnapshotId,
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
        "databaseSnapshotId",
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
        typeof value.databaseSnapshotId !== "string" ||
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
            value.databaseSnapshotId,
            value.preActivationCommit,
            value.rollbackCommit,
            value.preActivationPreviousCommit
        );
    } catch {
        return undefined;
    }
}

/**
 * Checks whether an active deployment lock row is stale enough to replace.
 * @returns Whether the deployment lock is stale.
 */
function isDeploymentLockStale(lock: DeploymentLockRow, now = Date.now()): boolean {
    const updatedAt = Date.parse(lock.updated_at);
    if (!Number.isFinite(updatedAt)) {
        return true;
    }
    return now - updatedAt > DEPLOYMENT_LOCK_STALE_MS;
}

/**
 * Reads the active deployment lock.
 * @returns Read the active deployment lock.
 */
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

/**
 * Releases the active release lock if it still belongs to the given job.
 * @param jobId Job identifier.
 */
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
    execution: JobExecutionRecord,
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
    execution: JobExecutionRecord,
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

function cleanupExpiredDeploymentExecution(execution: JobExecutionRecord): void {
    const action = execution.actionKey === "dashboard.rollback" ? "Rollback" : "Deploy";
    const outcome = execution.status === "cancelled" ? "cancelled" : "failed";
    cleanupTerminatedDeploymentExecution(
        execution,
        execution.finishedAt ?? dateToISOString(new Date()),
        `${action} ${outcome} after its worker lease expired`
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

/**
 * Acquires the active release lock for a deployment or rollback job.
 * @param jobId Job identifier.
 */
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

/**
 * Refreshes the active deploy heartbeat while long-running work continues.
 * @returns Refresh deployment heartbeat result.
 */
function refreshDeploymentHeartbeat(job: DeploymentJob): DeploymentJob {
    const updatedJob = { ...job, updatedAt: dateToISOString(new Date()) };
    writeDeploymentJob(updatedJob);
    database
        .prepare("UPDATE deployment_lock SET updated_at = ? WHERE id = 1 AND job_id = ?")
        .run(updatedJob.updatedAt, updatedJob.id);
    return updatedJob;
}

/**
 * Performs read deployment jobs.
 * @returns Read deployment jobs result.
 */
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

interface DeploymentRuntimeResultRow {
    note: string | null;
    status: DeploymentJob["status"];
}

/**
 * Rejects a previous slot whose latest meaningful runtime result failed
 * readiness. Build failures and cancelled jobs do not disqualify an otherwise
 * verified immutable release.
 * @param commitSha Commit sha value.
 * @param excludedJobId Excluded job identifier.
 * @returns Rollback runtime ineligibility reason result.
 */
function rollbackRuntimeIneligibilityReason(
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

async function rollbackIneligibilityReason(
    activeRelease: ManagedDashboardRelease,
    rollbackRelease: ManagedDashboardRelease,
    excludedJobId?: string
): Promise<string | undefined> {
    const runtimeReason = rollbackRuntimeIneligibilityReason(
        rollbackRelease.commitSha,
        excludedJobId
    );
    if (runtimeReason) return runtimeReason;

    try {
        await assertManagedDashboardReleaseRollbackSchemaCompatible(
            activeRelease,
            rollbackRelease
        );
        return undefined;
    } catch (error) {
        return errorMessage(
            error,
            "Previous release schema compatibility could not be verified"
        );
    }
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

/**
 * Reads the managed production release slots without exposing host paths.
 * @returns Read the managed production release slots without exposing host paths.
 */
export async function getDashboardReleaseStatus(): Promise<DashboardReleaseStatus> {
    const state = await readDashboardReleaseState(resolveDashboardReleasesRoot());
    const current = state.current ? dashboardReleaseSummary(state.current) : undefined;
    const previous = state.previous ? dashboardReleaseSummary(state.previous) : undefined;
    const isRollbackAvailable =
        current !== undefined &&
        previous !== undefined &&
        current.commitSha !== previous.commitSha;
    const ineligibilityReason =
        isRollbackAvailable && state.current && state.previous
            ? await rollbackIneligibilityReason(state.current, state.previous)
            : undefined;

    return {
        current,
        previous,
        rollback: {
            available: isRollbackAvailable && !ineligibilityReason,
            ...((!isRollbackAvailable || ineligibilityReason) && {
                reason:
                    ineligibilityReason ??
                    (current
                        ? "No distinct previous release is available"
                        : "No active managed release is available"),
            }),
        },
    };
}

/**
 * Performs trim output.
 * @param value Value to process.
 * @returns Trim output result.
 */
function trimOutput(value: string): string {
    return value.slice(-20_000);
}

/**
 * Splits an owner/name GitHub repository identifier.
 * @param repo Repo value.
 * @returns Parsed repo parts.
 */
function parseRepoParts(repo: string): { owner: string; name: string } {
    const parts = repo.split("/");
    const [owner, name] = parts;
    if (!owner || !name || parts.length !== 2) {
        throw new Error("Dashboard repository must be configured as owner/name");
    }
    return { owner, name };
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

/**
 * Builds reviewer command environment.
 * @returns Built reviewer command environment.
 */
function buildReviewCommandEnvironment(): NodeJS.ProcessEnv {
    const githubToken = process.env.RAJOHAN_GITHUB_TOKEN?.trim() || "";
    if (!githubToken) {
        throw new Error("Rajohan GitHub review token is not configured");
    }
    return buildGithubCommandEnvironment(githubToken);
}

/**
 * Returns whether the configured reviewer has approved the pull request.
 * @returns Whether the configured reviewer has approved the pull request.
 */
function hasReviewerApproval(pr: PullRequestSummary): boolean {
    const author = DEFAULT_REVIEWER_AUTHOR;
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

/**
 * Returns whether the pull request has a dashboard-accepted review approval.
 * @returns Whether the pull request has a dashboard-accepted review approval.
 */
function isPullRequestReviewApproved(pr: PullRequestSummary): boolean {
    return (
        pr.reviewDecision?.toUpperCase() === "APPROVED" ||
        pr.reviewerApproved === true ||
        hasReviewerApproval(pr)
    );
}

/**
 * Returns whether the configured reviewer can approve the pull request.
 * @returns Whether the configured reviewer can approve the pull request.
 */
function canReviewerApprove(pr: PullRequestSummary): boolean {
    return (
        pr.author?.login !== DEFAULT_REVIEWER_AUTHOR &&
        !pr.isDraft &&
        !isPullRequestReviewApproved(pr)
    );
}

/**
 * Normalizes pull request metadata for the dashboard API.
 * @returns Normalized pull request metadata for the dashboard API.
 */
function normalizePullRequest(pr: PullRequestSummary): PullRequestSummary {
    const rest = { ...pr };
    delete rest.latestOpinionatedReviews;
    delete rest.reviews;
    const previewAllowedAuthors = resolvePullRequestPreviewAllowedAuthors();

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

/**
 * Parses the bounded public REST shape used only by credential-free dev previews.
 * @param value Value to process.
 * @returns Parsed the bounded public REST shape used only by credential-free dev previews.
 */
export function parsePublicGithubPullRequests(value: unknown): PullRequestSummary[] {
    return parsePublicGitHubPullRequests(value).map((pullRequest) => {
        return normalizePullRequest({
            author: { login: pullRequest.user.login },
            baseRefName: pullRequest.base.ref,
            body: pullRequest.body ?? undefined,
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

/**
 * Performs run command.
 * @param command Command value.
 * @param arguments_ Arguments value.
 * @param options Operation options.
 * @returns Run command result.
 */
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

/**
 * Runs a GitHub CLI command and parses its JSON output.
 * @param arguments_ Arguments value.
 * @param parser Runtime value parser.
 * @param signal Signal used to cancel the operation.
 * @returns Promise resolving to the run gh json result.
 */
async function runGhJson<T>(
    arguments_: string[],
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
 * Lists open pull requests targeting the dashboard production branch.
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
    const repo = parseRepoParts(DASHBOARD_REPO);
    const pullRequests = await runGhJsonLines(
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
        parsePullRequestSummary,
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
async function getPullRequest(
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
    const result = await runGhJson(
        ["pr", "view", String(number), "--repo", DASHBOARD_REPO, "--json", "state"],
        parseGitHubPullRequestState,
        signal
    );
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

/**
 * Returns whether a path is strictly inside the configured worktree root.
 * @param value Value to process.
 * @param root Root value.
 * @returns Whether a path is strictly inside the configured worktree root.
 */
function isPathInsideRoot(value: string, root: string): boolean {
    const resolvedValue = path.resolve(value);
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedValue);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Performs find worktree for branch.
 * @param branch Branch value.
 * @param signal Signal used to cancel the operation.
 * @returns Find worktree for branch result.
 */
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

/**
 * Performs cleanup pull request worktree.
 * @param branch Branch value.
 * @param signal Signal used to cancel the operation.
 * @returns Cleanup pull request worktree result.
 */
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
    if (pr.author?.login === DEFAULT_REVIEWER_AUTHOR) {
        throw new Error("Rajohan cannot approve his own pull request");
    }
    if (isPullRequestReviewApproved(pr)) {
        throw new Error("Pull request is already approved");
    }
}

/**
 * Returns whether pull request checks are conclusively passing.
 * @param checks Checks value.
 * @returns Whether pull request checks are conclusively passing.
 */
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

/**
 * Keeps only the latest check entry for each GitHub check name/context.
 * @returns Latest check records result.
 */
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

/**
 * Returns a stable key for a GitHub status or check run.
 * @returns a stable key for a GitHub status or check run.
 */
function checkKey(check: Record<string, unknown>): string {
    for (const key of ["name", "context", "workflowName"]) {
        const value = check[key];
        if (typeof value === "string" && value.trim()) {
            return `${key}:${value.trim()}`;
        }
    }
    return JSON.stringify(check);
}

/**
 * Returns a comparable timestamp for a GitHub status or check run.
 * @returns a comparable timestamp for a GitHub status or check run.
 */
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

/**
 * Normalizes a GitHub check status or conclusion.
 * @param value Value to process.
 * @returns Normalized a GitHub check status or conclusion.
 */
function normalizedCheckValue(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Returns production checkout status.
 * @returns production checkout status.
 */
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

/**
 * Performs shell quote.
 * @param value Value to process.
 * @returns Shell quote result.
 */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Builds a shell command that records deployment status from a detached process.
 * @returns Built a shell command that records deployment status from a detached process.
 */
function deploymentJobUpdateCommand(job: DeploymentJob): string {
    const script = `
import { Database } from "bun:sqlite";
const job = {
    ...JSON.parse(process.env.MIRA_DEPLOYMENT_JOB || "{}"),
    updatedAt: new Date().toISOString(),
};
const database = new Database(process.env.MIRA_DEPLOYMENT_DB);
function sqlNullable(value) {
    return value === undefined ? null : value;
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

/**
 * Waits until the worker has durably completed the scheduling action. The
 * cutover snapshot must not capture a running execution that an older worker
 * would later recover as failed.
 * @param deploymentId Deployment identifier.
 * @param databaseSnapshotId Database snapshot identifier.
 * @returns Deployment cutover handoff command result.
 */
function deploymentCutoverHandoffCommand(
    deploymentId: string,
    databaseSnapshotId: string
): string {
    const script = `
import { Database } from "bun:sqlite";
const database = new Database(process.env.MIRA_DEPLOYMENT_DB, { readonly: true });
database.run("PRAGMA busy_timeout = 5000");
const deadline = Date.now() + ${DEPLOYMENT_CUTOVER_HANDOFF_TIMEOUT_MS};
const readExecution = database.prepare(\`
    SELECT
        status,
        json_extract(output_json, '$.releaseCutover.databaseSnapshotId') AS database_snapshot_id,
        (SELECT status FROM deployment_jobs WHERE id = ?) AS deployment_status,
        (SELECT job_id FROM deployment_lock WHERE id = 1) AS lock_job_id
    FROM job_executions
    WHERE action_key = 'dashboard.deploy'
      AND json_valid(payload_json)
      AND json_valid(output_json)
      AND json_extract(payload_json, '$.deploymentId') = ?
    ORDER BY queued_at DESC, id DESC
    LIMIT 1
\`);
let isReady = false;
try {
    while (Date.now() < deadline) {
        const execution = readExecution.get(
            process.env.MIRA_DEPLOYMENT_ID,
            process.env.MIRA_DEPLOYMENT_ID
        );
        if (
            execution?.status === "success" &&
            execution.database_snapshot_id === process.env.MIRA_DEPLOYMENT_SNAPSHOT_ID &&
            execution.deployment_status === "verifying" &&
            execution.lock_job_id === process.env.MIRA_DEPLOYMENT_ID
        ) {
            isReady = true;
            break;
        }
        if (
            execution &&
            execution.status !== "queued" &&
            execution.status !== "running"
        ) {
            break;
        }
        await Bun.sleep(100);
    }
} finally {
    database.close();
}
if (!isReady) process.exitCode = 1;
`;
    return [
        `MIRA_DEPLOYMENT_DB=${shellQuote(getMiraDatabasePath())}`,
        `MIRA_DEPLOYMENT_ID=${shellQuote(deploymentId)}`,
        `MIRA_DEPLOYMENT_SNAPSHOT_ID=${shellQuote(databaseSnapshotId)}`,
        shellQuote(resolveBunExecutable()),
        "-e",
        shellQuote(script),
    ].join(" ");
}

function releaseLifecycleInvocation(lifecycleCommand: string): string {
    return [
        `MIRA_DASHBOARD_PROJECT_ROOT=${shellQuote(
            resolveDashboardProjectPaths().projectRoot
        )}`,
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
        "stop_services() {",
        `  /usr/bin/systemctl --user stop ${DASHBOARD_SERVICES.join(" ")}`,
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

/**
 * Schedules detached service restart, commit-bound readiness, and rollback.
 * @returns Promise resolving to the schedule release cutover result.
 */
async function scheduleReleaseCutover(
    job: DeploymentJob,
    cutover: DeploymentCutoverContext,
    signal?: AbortSignal
): Promise<CommandResult> {
    const {
        candidateCommit,
        databaseSnapshotId,
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
    const guardedLifecycleCommand = path.join(
        releasesRoot,
        "releases",
        candidateCommit,
        "backend",
        "dist",
        "releaseLifecycle.js"
    );
    const guardedLifecycleEnvironment = releaseLifecycleInvocation(
        guardedLifecycleCommand
    );
    const snapshotCommand = `${guardedLifecycleEnvironment} snapshot-database ${shellQuote(databaseSnapshotId)}`;
    const restoreDatabaseCommand = `${guardedLifecycleEnvironment} restore-database ${shellQuote(databaseSnapshotId)}`;
    const discardSnapshotCommand = `${guardedLifecycleEnvironment} discard-database-snapshot ${shellQuote(databaseSnapshotId)}`;
    const waitForHandoffCommand = deploymentCutoverHandoffCommand(
        job.id,
        databaseSnapshotId
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
    const activationFailureRestoreCommand = isNewActivation
        ? `${restoreDatabaseCommand} && ${restoreCommand}`
        : restoreDatabaseCommand;
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
        note: "Release activation failed before restart; the exact pre-cutover database and original release were restored",
    };
    const snapshotFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Release activation stopped before restart because the guarded database snapshot failed; original services were restored",
    };
    const cutoverStartFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Release activation could not stop every Dashboard service safely; original services were restored",
    };
    const handoffFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Release activation stopped before service shutdown because the worker handoff did not become durable",
    };

    const script = [
        ...releaseCutoverShellFunctions(),
        `${waitForHandoffCommand} || { ${deploymentJobUpdateCommand(handoffFailedJob)}; exit 1; }`,
        "if stop_services; then",
        `  if ${snapshotCommand}; then`,
        `    if ${guardedLifecycleEnvironment} activate ${shellQuote(candidateCommit)} --coordinated-schema-cutover; then`,
        `      if restart_services && ready_for_commit ${shellQuote(candidateShort)}; then`,
        `        if ${guardedLifecycleEnvironment} prune 3; then`,
        `          ${deploymentJobUpdateCommand(okJob)} || exit 1`,
        "        else",
        `          ${deploymentJobUpdateCommand(okWithRetentionWarningJob)} || exit 1`,
        "        fi",
        `        ${discardSnapshotCommand} >/dev/null 2>&1 || true`,
        "      else",
        `        if stop_services && ${restoreDatabaseCommand} && ${restoreCommand} && restart_services && ready_for_commit ${shellQuote(rollbackShort)}; then`,
        `          ${deploymentJobUpdateCommand(rolledBackJob)} || exit 1`,
        `          ${discardSnapshotCommand} >/dev/null 2>&1 || true`,
        "        else",
        `          ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "        fi",
        "      fi",
        "    else",
        `      if ${activationFailureRestoreCommand} && restart_services && ready_for_commit ${shellQuote(preActivationCommit.slice(0, 8))}; then`,
        `        ${deploymentJobUpdateCommand(activationFailedJob)} || exit 1`,
        `        ${discardSnapshotCommand} >/dev/null 2>&1 || true`,
        "      else",
        `        ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "      fi",
        "    fi",
        "  else",
        `    if restart_services && ready_for_commit ${shellQuote(preActivationCommit.slice(0, 8))}; then`,
        `      ${deploymentJobUpdateCommand(snapshotFailedJob)}`,
        "    else",
        `      ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "    fi",
        "  fi",
        "else",
        `  if restart_services && ready_for_commit ${shellQuote(preActivationCommit.slice(0, 8))}; then`,
        `    ${deploymentJobUpdateCommand(cutoverStartFailedJob)}`,
        "  else",
        `    ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "  fi",
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

/**
 * Schedules a detached current/previous swap with readiness-bound restoration.
 * @returns Promise resolving to the schedule release rollback result.
 */
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
    const lifecycleEnvironment = releaseLifecycleInvocation(lifecycleCommand);
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
    if (!job || job.status !== "verifying") {
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
    let recoveryMode: "candidate-rollback" | "restore" | "rollback" =
        persistedCutover || isRollbackAction ? "rollback" : "candidate-rollback";
    if (willRestoreExactPreActivationSlots) {
        recoveryMode = "restore";
    }
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
        `project_root=${shellQuote(resolveDashboardProjectPaths().projectRoot)}`,
        `releases_root=${shellQuote(releasesRoot)}`,
        `candidate_commit=${shellQuote(candidateCommit)}`,
        `database_snapshot_id=${shellQuote(persistedCutover?.databaseSnapshotId ?? "")}`,
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
        '  MIRA_DASHBOARD_PROJECT_ROOT="$project_root" \\',
        "  NODE_ENV=production \\",
        '  "$bun_executable" "$activation_lifecycle" "$@"',
        "}",
        "run_candidate_lifecycle() {",
        '  MIRA_DASHBOARD_PROJECT_ROOT="$project_root" \\',
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
        "    candidate-rollback)",
        '      run_candidate_lifecycle rollback "$candidate_commit" "$rollback_commit"',
        "      ;;",
        "    *) return 1 ;;",
        "  esac",
        "}",
        "resolve_trusted_lifecycles || exit 1",
        'if [ -n "$database_snapshot_id" ]; then',
        '  if ! run_candidate_lifecycle verify-database-snapshot "$database_snapshot_id" >/dev/null; then',
        '    [ "$current_commit" != "$candidate_commit" ] || exit 1',
        '    if restart_services && ready_for_commit "${current_commit:0:8}"; then',
        `      ${deploymentJobUpdateCommand(activationNotAppliedJob)}`,
        "      exit 0",
        "    fi",
        "    exit 1",
        "  fi",
        "  stop_services || exit 1",
        '  if activation_output="$(run_candidate_lifecycle activate "$candidate_commit" --coordinated-schema-cutover)"; then',
        '    activation_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.current.commitSha // empty\')"',
        '    [ "$activation_commit" = "$candidate_commit" ] || exit 1',
        '    if restart_services && ready_for_commit "${candidate_commit:0:8}"; then',
        `      ${deploymentJobUpdateCommand(activeCandidateRecoveredJob)} || exit 1`,
        '      run_candidate_lifecycle discard-database-snapshot "$database_snapshot_id" >/dev/null 2>&1 || true',
        "      exit 0",
        "    fi",
        '    rollback_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.previous.commitSha // empty\')"',
        '    [[ "$rollback_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '    [ "$rollback_commit" != "$candidate_commit" ] || exit 1',
        '    if stop_services && run_candidate_lifecycle restore-database "$database_snapshot_id" && restore_failed_candidate && restart_services && ready_for_commit "${rollback_commit:0:8}"; then',
        `      ${deploymentJobUpdateCommand(rolledBackJob)} || exit 1`,
        '      run_candidate_lifecycle discard-database-snapshot "$database_snapshot_id" >/dev/null 2>&1 || true',
        "    else",
        "      exit 1",
        "    fi",
        "  else",
        '    if run_candidate_lifecycle restore-database "$database_snapshot_id"; then',
        '      status_output="$(run_candidate_lifecycle status)" || exit 1',
        '      current_commit="$(printf "%s" "$status_output" | /usr/bin/jq --raw-output \'.current.commitSha // empty\')"',
        '      [[ "$current_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '      [ "$current_commit" != "$candidate_commit" ] || exit 1',
        '      if restart_services && ready_for_commit "${current_commit:0:8}"; then',
        `        ${deploymentJobUpdateCommand(activationNotAppliedJob)} || exit 1`,
        '        run_candidate_lifecycle discard-database-snapshot "$database_snapshot_id" >/dev/null 2>&1 || true',
        "        exit 0",
        "      fi",
        "    fi",
        "    exit 1",
        "  fi",
        'elif activation_output="$(run_activation_lifecycle activate "$candidate_commit")"; then',
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

/**
 * Runs deployment work after the API has returned a job to the caller.
 * @returns Promise resolving to the run deployment job result.
 */
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
            const ineligibilityReason = await rollbackIneligibilityReason(
                currentState.current,
                rollbackRelease,
                job.id
            );
            if (ineligibilityReason) {
                throw new Error(
                    `Automatic redeploy fallback is not eligible: ${ineligibilityReason}`
                );
            }
        }
        assertDashboardReleaseRuntimeAvailable(rollbackRelease);

        const candidate = await stageDashboardRelease(expectedCommit, {
            bunExecutable: resolveBunExecutable(),
            commandRunner: async (command, arguments_, options) =>
                runCommand(command, [...arguments_], {
                    cwd: options.cwd,
                    environment: options.environment,
                    signal: options.signal,
                    timeoutMs: options.timeoutMs,
                }),
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
            Bun.randomUUIDv7(),
            currentState.current.commitSha,
            rollbackRelease.commitSha,
            currentState.previous?.commitSha
        );
        persistCutover(releaseCutover);

        const cutoverJob: DeploymentJob = {
            ...currentJob,
            status: "verifying",
            updatedAt: dateToISOString(new Date()),
            commit: candidate.manifest.commitSha,
            commitTitle: candidate.manifest.commitTitle,
            note: `Release published. Pausing Dashboard writes, snapshotting SQLite, activating it, then verifying web, worker, deployed commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS} seconds of worker stability; code-and-data rollback is armed`,
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

/**
 * Validates and schedules a managed rollback after the API has returned its job.
 * @returns Validation result for and schedules a managed rollback after the API has returned its job.
 */
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
        const ineligibilityReason = await rollbackIneligibilityReason(
            state.current,
            state.previous,
            job.id
        );
        if (ineligibilityReason) {
            throw new Error(
                `Previous release is not eligible for rollback: ${ineligibilityReason}`
            );
        }
        assertDashboardReleaseRuntimeAvailable(state.previous);

        const cutoverJob: DeploymentJob = {
            ...currentJob,
            status: "verifying",
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
            logger.warn("deployment.restart_inspection_failed", {
                deploymentId,
                error,
            });
        }
    };
    const restartPoll = setInterval(
        checkRestartStatus,
        DEPLOYMENT_RESTART_STATUS_POLL_MS
    );
    restartPoll.unref();
    const failSafe = setTimeout(() => {
        logger.warn("deployment.worker_claim_pause_timed_out", { deploymentId });
        settle();
    }, DEPLOYMENT_RESTART_CLAIM_PAUSE_TIMEOUT_MS);
    failSafe.unref();
    queueMicrotask(checkRestartStatus);
}

/**
 * Persists a deployment and puts its execution behind the worker lease.
 * @param lockHeldBy Lock held by value.
 * @returns Start deploy latest result.
 */
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

/**
 * Queues a direct deploy; production validation is owned by the worker action.
 * @returns Prepare and start deploy latest result.
 */
export function prepareAndStartDeployLatest(): DeploymentJob {
    return startDeployLatest();
}

/**
 * Validates the confirmed target against current release slots and queues rollback.
 * @param expectedTargetCommit Expected target commit value.
 * @returns Validation result for the confirmed target against current release slots and queues rollback.
 */
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
        const ineligibilityReason = await rollbackIneligibilityReason(
            state.current,
            state.previous
        );
        if (ineligibilityReason) {
            throw Object.assign(
                new Error(
                    `Previous release is not eligible for rollback: ${ineligibilityReason}`
                ),
                { statusCode: 409 }
            );
        }
        assertDashboardReleaseRuntimeAvailable(state.previous);

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

/**
 * Performs approve pull request.
 * @param number Number value.
 * @param willDeploy Whether will deploy.
 * @param options Operation options.
 * @returns Approve pull request result.
 */
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
        message: pullRequestMergeMessage(number, willDeploy, syncError, deployError),
        deployment,
        deployError,
        cleanup,
        previewCleanup,
        syncError,
    };
}

function queuedPullRequestResult<T>(execution: JobExecutionRecord): T {
    if ("result" in execution.output) return execution.output.result as T;
    successfulJobExecutionOutput(execution);
    throw new Error("Pull request result was missing");
}

/**
 * Runs PR merge/deploy through the shared persistent execution plane.
 * @param number Number value.
 * @param willDeploy Whether will deploy.
 * @returns Promise resolving to the run pull request approval result.
 */
export async function runPullRequestApproval(number: number, willDeploy: boolean) {
    registerPullRequestJobLifecycleHandlers();
    const deploymentLockId = `approve-${Bun.randomUUIDv7()}`;
    acquireDeploymentLock(deploymentLockId);
    let execution: JobExecutionRecord;
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

/**
 * Performs approve pull request review.
 * @param number Number value.
 * @param signal Signal used to cancel the operation.
 * @returns Approve pull request review result.
 */
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

/**
 * Updates one pull request branch with the latest base branch.
 * @param number Number value.
 * @param signal Signal used to cancel the operation.
 * @returns Promise resolving to the update pull request branch result.
 */
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

/**
 * Performs reject pull request.
 * @param number Number value.
 * @param comment Comment value.
 * @param signal Signal used to cancel the operation.
 * @returns Reject pull request result.
 */
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

/**
 * Records a GitHub review approval in the shared execution plane.
 * @param number Number value.
 * @returns Promise resolving to the run pull request review approval result.
 */
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

/**
 * Records a GitHub branch update in the shared execution plane.
 * @param number Number value.
 * @returns Promise resolving to the run pull request branch update result.
 */
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

/**
 * Records a PR close and local worktree cleanup in the execution plane.
 * @param number Number value.
 * @param comment Comment value.
 * @returns Promise resolving to the run pull request rejection result.
 */
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
