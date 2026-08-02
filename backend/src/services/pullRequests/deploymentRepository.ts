import type {
    DashboardReleaseStatus,
    DashboardReleaseSummary,
    DeploymentJob,
} from "../../../../contracts/delivery.ts";
import { database, sqlNullable } from "../../database/connection.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS,
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PREDICATE_SQL,
} from "../deploymentRuntimeResults.ts";
import { type JobExecutionRecord } from "../jobExecutionQueue/repository.ts";
import {
    registerExpiredJobExecutionHandler,
    registerQueuedJobCancellationHandler,
} from "../jobExecutionQueue/worker.ts";
import { type ManagedDashboardRelease } from "../releases/managerModel.ts";
import { readDashboardReleaseState } from "../releases/managerOperations.ts";
import { resolveDashboardReleasesRoot } from "../releases/releaseLayout.ts";
import { assertManagedDashboardReleaseRollbackSchemaCompatible } from "../releases/schemaCompatibility.ts";
import { DASHBOARD_REPO } from "./config.ts";
import {
    dateToISOString,
    FULL_COMMIT_SHA_PATTERN,
    isRecord,
    pullRequestLogger as logger,
} from "./support.ts";

const DEPLOYMENT_LOCK_STALE_MS = 30 * 60 * 1000;
const RECENT_DEPLOYMENTS_LIMIT = 10;
const MAX_DEPLOYMENT_CUTOVER_CONTEXT_BYTES = 4096;
const DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION = 2;
const ACTIVE_DEPLOYMENT_STATUSES = new Set(["building", "verifying"]);
const SQLITE_CUTOVER_SNAPSHOT_ID_PATTERN =
    /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

export function writeDeploymentJob(job: DeploymentJob): void {
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
export function readDeploymentJob(jobId: string): DeploymentJob | undefined {
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

export interface DeploymentCutoverContext {
    candidateCommit: string;
    databaseSnapshotId: string;
    formatVersion: typeof DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION;
    preActivationCommit: string;
    preActivationPreviousCommit?: string;
    rollbackCommit: string;
}

export function createDeploymentCutoverContext(
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

export function parseDeploymentCutoverContext(
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

export function readDeploymentLockExecution(
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
export function releaseDeploymentLock(jobId: string): void {
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
export function ensureNoActiveDeployment(): void {
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
export function acquireDeploymentLock(jobId: string): void {
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

export function refreshDeploymentLockOwner(jobId: string): void {
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
export function refreshDeploymentHeartbeat(job: DeploymentJob): DeploymentJob {
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

export async function rollbackIneligibilityReason(
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
    let state: Awaited<ReturnType<typeof readDashboardReleaseState>>;
    try {
        state = await readDashboardReleaseState(resolveDashboardReleasesRoot());
    } catch (error) {
        if (
            process.env.NODE_ENV === "production" ||
            process.env.MIRA_DASHBOARD_DEV_SAFE_MODE !== "1"
        ) {
            throw error;
        }
        logger.warn("release_status.isolated_metadata_unavailable", { error });
        return {
            rollback: {
                available: false,
                reason: "Production release metadata is unavailable in isolated PR dev",
            },
        };
    }
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
