import type { DeploymentJob } from "../../../../contracts/delivery.ts";
import { database } from "../../database/connection.ts";
import type { JobExecutionRecord } from "../jobExecutionQueue/repository.ts";
import {
    registerExpiredJobExecutionHandler,
    registerQueuedJobCancellationHandler,
} from "../jobExecutionQueue/worker.ts";
import { readDeploymentJob, writeDeploymentJob } from "./deploymentJobRepository.ts";
import { dateToISOString } from "./support.ts";

const DEPLOYMENT_LOCK_STALE_MS = 30 * 60 * 1000;
const ACTIVE_DEPLOYMENT_STATUSES = new Set(["building", "verifying"]);

interface DeploymentLockRow {
    job_id: string;
    updated_at: string;
}

interface DeploymentLockExecutionRow {
    action_key: string;
    output_json: string;
    status: JobExecutionRecord["status"];
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
