import type { JobExecutionStatus } from "../../../../contracts/jobs/shared.ts";
import { database, sqlNullable } from "../../database/connection.ts";
import type { AuditOutcome } from "../auditEvents.ts";
import { getJobWorkerClaimsState } from "../jobWorkerControl.ts";
import {
    DEFAULT_LEASE_MS,
    type JobExecutionRecord,
    type JobExecutionRow,
    getJobExecution,
    leaseExpiry,
    mapExecution,
    nowIso,
    statusError,
    writeJobAudit,
} from "./repository.ts";

type QueuedJobCancellationHandler = (
    execution: JobExecutionRecord,
    timestamp: string
) => void;
type ExpiredJobExecutionHandler = (execution: JobExecutionRecord) => void;

const queuedJobCancellationHandlers = new Map<string, QueuedJobCancellationHandler>();
const expiredJobExecutionHandlers = new Map<string, ExpiredJobExecutionHandler>();

/**
 * Registers domain cleanup that participates in a queued cancellation transaction.
 * @param actionKey Action key value.
 * @param handler Handler value.
 */
export function registerQueuedJobCancellationHandler(
    actionKey: string,
    handler: QueuedJobCancellationHandler
): void {
    queuedJobCancellationHandlers.set(actionKey, handler);
}

/**
 * Registers domain cleanup that participates in expired-lease recovery.
 * @param actionKey Action key value.
 * @param handler Handler value.
 */
export function registerExpiredJobExecutionHandler(
    actionKey: string,
    handler: ExpiredJobExecutionHandler
): void {
    expiredJobExecutionHandlers.set(actionKey, handler);
}
export function registerJobWorker(
    id: string,
    capacity: number,
    timestamp = nowIso()
): void {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
        throw new Error("Job worker capacity must be a positive integer");
    }
    database
        .prepare(
            `INSERT INTO job_workers (id, capacity, started_at, heartbeat_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                 capacity = excluded.capacity,
                 started_at = excluded.started_at,
                 heartbeat_at = excluded.heartbeat_at`
        )
        .run(id, capacity, timestamp, timestamp);
    database
        .prepare("DELETE FROM job_workers WHERE heartbeat_at < ?")
        .run(new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000).toISOString());
}

export function didHeartbeatJobWorker(id: string, timestamp = nowIso()): boolean {
    return (
        database
            .prepare("UPDATE job_workers SET heartbeat_at = ? WHERE id = ?")
            .run(timestamp, id).changes > 0
    );
}

export function unregisterJobWorker(id: string): void {
    database.prepare("DELETE FROM job_workers WHERE id = ?").run(id);
}

function finishExpiredExecution(row: JobExecutionRow, finishedAt: string): void {
    const status: JobExecutionStatus = row.cancel_requested_at ? "cancelled" : "failed";
    const message = row.cancel_requested_at
        ? "Job cancelled after its worker lease expired"
        : "Job failed after its worker lease expired";
    const update = database
        .prepare(
            `UPDATE job_executions
             SET status = ?, finished_at = ?, lease_owner = NULL,
                 lease_expires_at = NULL, message = ?
             WHERE id = ? AND status = 'running'`
        )
        .run(status, finishedAt, message, row.id);
    if (update.changes === 0) return;
    if (row.scheduled_run_id !== null && row.scheduled_run_id !== undefined) {
        database
            .prepare(
                `UPDATE scheduled_job_runs
                 SET status = ?, finished_at = ?, message = ?
                 WHERE id = ? AND status = 'running'`
            )
            .run(status, finishedAt, message, row.scheduled_run_id);
    }
    const recoveryHandler = expiredJobExecutionHandlers.get(row.action_key);
    const execution = mapExecution({
        ...row,
        finished_at: finishedAt,
        lease_expires_at: undefined,
        lease_owner: undefined,
        message,
        status,
    });
    if (execution) {
        writeJobAudit(
            execution,
            "job.execute",
            status === "cancelled" ? "cancelled" : "failed",
            finishedAt,
            { recovery: "lease-expired" }
        );
    }
    if (recoveryHandler && execution) {
        recoveryHandler(execution);
    }
}

function recoverExpiredJobExecutionsInTransaction(timestamp: string): number {
    const rows = database
        .prepare(
            `SELECT * FROM job_executions
             WHERE status = 'running'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?`
        )
        .all(timestamp) as unknown as JobExecutionRow[];
    for (const row of rows) finishExpiredExecution(row, timestamp);
    return rows.length;
}

export function recoverExpiredJobExecutions(timestamp = nowIso()): number {
    database.run("BEGIN IMMEDIATE");
    try {
        const recovered = recoverExpiredJobExecutionsInTransaction(timestamp);
        database.run("COMMIT");
        return recovered;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the recovery error.
        }
        throw error;
    }
}

function claimExecutionRow(
    row: JobExecutionRow,
    workerId: string,
    timestamp: string,
    leaseMs: number
): JobExecutionRecord | undefined {
    const update = database
        .prepare(
            `UPDATE job_executions
             SET status = 'running', started_at = ?, heartbeat_at = ?,
                 lease_owner = ?, lease_expires_at = ?, attempt = attempt + 1
             WHERE id = ? AND status = 'queued' AND cancel_requested_at IS NULL`
        )
        .run(timestamp, timestamp, workerId, leaseExpiry(timestamp, leaseMs), row.id);
    if (update.changes === 0) return undefined;
    if (row.scheduled_run_id !== null && row.scheduled_run_id !== undefined) {
        database
            .prepare(
                `UPDATE scheduled_job_runs
                 SET status = 'running', started_at = ?
                 WHERE id = ? AND status = 'queued'`
            )
            .run(timestamp, row.scheduled_run_id);
    }
    const execution = getJobExecution(row.id);
    if (execution) {
        writeJobAudit(execution, "job.execute", "attempted", timestamp, {
            attempt: execution.attempt,
            workerId,
        });
    }
    return execution;
}

export function claimNextJobExecution(
    workerId: string,
    capacity = 1,
    timestamp = nowIso(),
    leaseMs = DEFAULT_LEASE_MS
): JobExecutionRecord | undefined {
    database.run("BEGIN IMMEDIATE");
    try {
        recoverExpiredJobExecutionsInTransaction(timestamp);
        if (getJobWorkerClaimsState().paused) {
            database.run("COMMIT");
            return undefined;
        }
        const active = database
            .prepare(
                "SELECT COUNT(*) AS count FROM job_executions WHERE status = 'running'"
            )
            .get() as { count: number };
        if (active.count >= capacity) {
            database.run("COMMIT");
            return undefined;
        }
        const row = database
            .prepare(
                `SELECT * FROM job_executions
                 WHERE status = 'queued'
                   AND cancel_requested_at IS NULL
                   AND available_at <= ?
                 ORDER BY priority DESC, queued_at, id
                 LIMIT 1`
            )
            .get(timestamp) as JobExecutionRow | undefined;
        const claimed = row
            ? claimExecutionRow(row, workerId, timestamp, leaseMs)
            : undefined;
        database.run("COMMIT");
        return claimed;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the claim error.
        }
        throw error;
    }
}

export function heartbeatJobExecution(
    id: string,
    workerId: string,
    timestamp = nowIso(),
    leaseMs = DEFAULT_LEASE_MS
): { cancelRequested: boolean; hasLease: boolean } {
    const update = database
        .prepare(
            `UPDATE job_executions
             SET heartbeat_at = ?, lease_expires_at = ?
             WHERE id = ? AND status = 'running' AND lease_owner = ?`
        )
        .run(timestamp, leaseExpiry(timestamp, leaseMs), id, workerId);
    if (update.changes === 0) {
        return { cancelRequested: false, hasLease: false };
    }
    const row = database
        .prepare("SELECT cancel_requested_at FROM job_executions WHERE id = ?")
        .get(id) as { cancel_requested_at: string | null | undefined } | undefined;
    return {
        cancelRequested: Boolean(row?.cancel_requested_at),
        hasLease: true,
    };
}

/**
 * Atomically closes the UI cancellation window before an irreversible action.
 * Queued executions remain cancellable until the worker starts the action.
 * @param id Resource identifier.
 * @returns Protect running job execution from cancellation result.
 */
export function protectRunningJobExecutionFromCancellation(
    id: string
): JobExecutionRecord {
    const update = database
        .prepare(
            `UPDATE job_executions
             SET cancellable = 0
             WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL`
        )
        .run(id);
    if (update.changes === 0) {
        const execution = getJobExecution(id);
        if (!execution) throw statusError("Job execution not found", 404);
        if (execution.cancelRequestedAt) {
            throw statusError("Job cancellation was already requested", 409);
        }
        throw statusError("Job execution is not running", 409);
    }
    return getJobExecution(id) as JobExecutionRecord;
}

/**
 * Replaces the bounded progress snapshot for an execution with an active lease.
 * @param id Resource identifier.
 * @param workerId Worker identifier.
 * @param output Output value.
 * @returns Update job execution output result.
 */
export function updateJobExecutionOutput(
    id: string,
    workerId: string,
    output: Record<string, unknown>
): JobExecutionRecord {
    const update = database
        .prepare(
            `UPDATE job_executions
             SET output_json = ?
             WHERE id = ? AND status = 'running' AND lease_owner = ?`
        )
        .run(JSON.stringify(output), id, workerId);
    if (update.changes === 0) {
        throw statusError("Job execution lease is no longer active", 409);
    }
    return getJobExecution(id) as JobExecutionRecord;
}

export function finishJobExecution(
    id: string,
    workerId: string,
    status: "success" | "failed" | "cancelled",
    message: string | undefined,
    output: Record<string, unknown>,
    finishedAt = nowIso()
): JobExecutionRecord {
    database.run("BEGIN IMMEDIATE");
    try {
        const row = database
            .prepare("SELECT * FROM job_executions WHERE id = ?")
            .get(id) as JobExecutionRow | undefined;
        if (!row) throw statusError("Job execution not found", 404);
        if (row.status !== "running" || row.lease_owner !== workerId) {
            throw statusError("Job execution lease is no longer active", 409);
        }
        const wasCancellationRequested = Boolean(row.cancel_requested_at);
        const finalStatus: JobExecutionStatus =
            wasCancellationRequested || status === "cancelled" ? "cancelled" : status;
        let finalMessage = message;
        if (finalStatus === "cancelled") {
            finalMessage = message ?? "Job cancelled";
        }
        if (wasCancellationRequested) {
            finalMessage = "Job cancelled";
        }
        database
            .prepare(
                `UPDATE job_executions
                 SET status = ?, finished_at = ?, lease_owner = NULL,
                     lease_expires_at = NULL, message = ?, output_json = ?
                 WHERE id = ? AND status = 'running' AND lease_owner = ?`
            )
            .run(
                finalStatus,
                finishedAt,
                sqlNullable(finalMessage),
                JSON.stringify(output),
                id,
                workerId
            );
        if (row.scheduled_run_id !== null && row.scheduled_run_id !== undefined) {
            database
                .prepare(
                    `UPDATE scheduled_job_runs
                     SET status = ?, finished_at = ?, message = ?, output_json = ?
                     WHERE id = ?`
                )
                .run(
                    finalStatus,
                    finishedAt,
                    sqlNullable(finalMessage),
                    JSON.stringify(output),
                    row.scheduled_run_id
                );
        }
        const execution = getJobExecution(id) as JobExecutionRecord;
        let auditOutcome: AuditOutcome = "failed";
        if (finalStatus === "cancelled") {
            auditOutcome = "cancelled";
        }
        if (finalStatus === "success") {
            auditOutcome = "succeeded";
        }
        writeJobAudit(execution, "job.execute", auditOutcome, finishedAt, {
            attempt: execution.attempt,
        });
        database.run("COMMIT");
        return execution;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the finish error.
        }
        throw error;
    }
}

export function cancelJobExecution(id: string, timestamp = nowIso()): JobExecutionRecord {
    database.run("BEGIN IMMEDIATE");
    try {
        const row = database
            .prepare("SELECT * FROM job_executions WHERE id = ?")
            .get(id) as JobExecutionRow | undefined;
        if (!row) throw statusError("Job execution not found", 404);
        if (!row.cancellable) {
            throw statusError("This job execution cannot be cancelled here", 409);
        }
        if (row.status === "queued") {
            database
                .prepare(
                    `UPDATE job_executions
                     SET status = 'cancelled', cancel_requested_at = ?, finished_at = ?,
                         message = 'Job cancelled before execution'
                     WHERE id = ? AND status = 'queued'`
                )
                .run(timestamp, timestamp, id);
            if (row.scheduled_run_id !== null && row.scheduled_run_id !== undefined) {
                database
                    .prepare(
                        `UPDATE scheduled_job_runs
                         SET status = 'cancelled', finished_at = ?,
                             message = 'Job cancelled before execution'
                         WHERE id = ? AND status = 'queued'`
                    )
                    .run(timestamp, row.scheduled_run_id);
            }
            const cancellationHandler = queuedJobCancellationHandlers.get(row.action_key);
            const execution = mapExecution(row);
            if (cancellationHandler && execution) {
                cancellationHandler(execution, timestamp);
            }
        } else if (row.status === "running") {
            database
                .prepare(
                    `UPDATE job_executions
                     SET cancel_requested_at = COALESCE(cancel_requested_at, ?)
                     WHERE id = ? AND status = 'running'`
                )
                .run(timestamp, id);
        } else {
            throw statusError("Completed job executions cannot be cancelled", 409);
        }
        const execution = getJobExecution(id) as JobExecutionRecord;
        writeJobAudit(
            execution,
            "job.cancel",
            row.status === "queued" ? "cancelled" : "accepted",
            timestamp,
            { previousStatus: row.status }
        );
        database.run("COMMIT");
        return execution;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the cancellation error.
        }
        throw error;
    }
}
