import { database, sqlNullable } from "../database.ts";
import {
    isJobResourceClass,
    type JobResourceClass,
    jobResourcePriority,
} from "../lib/jobResources.ts";

const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const MAX_EXECUTION_LIST_LIMIT = 200;

export type JobExecutionStatus =
    "queued" | "running" | "success" | "failed" | "cancelled";
export type JobExecutionTriggerType = "manual" | "schedule" | "startup" | "system";

export interface JobExecution {
    id: string;
    scheduledJobId: string | undefined;
    scheduledRunId: number | undefined;
    actionKey: string;
    displayName: string;
    resourceClass: JobResourceClass;
    priority: number;
    status: JobExecutionStatus;
    triggerType: JobExecutionTriggerType;
    payload: Record<string, unknown>;
    queuedAt: string;
    availableAt: string;
    startedAt: string | undefined;
    finishedAt: string | undefined;
    leaseOwner: string | undefined;
    leaseExpiresAt: string | undefined;
    heartbeatAt: string | undefined;
    cancelRequestedAt: string | undefined;
    cancellable: boolean;
    attempt: number;
    timeoutMs: number;
    message: string | undefined;
    output: Record<string, unknown>;
}

export interface JobExecutionSummary {
    activeResourceClasses: JobResourceClass[];
    oldestQueuedAgeMs: number | undefined;
    oldestQueuedAt: string | undefined;
    queued: number;
    running: number;
    workerCapacity: number;
    workerCount: number;
    workerLastHeartbeatAt: string | undefined;
    workerOnline: boolean;
}

export interface InsertJobExecutionInput {
    actionKey: string;
    availableAt?: string;
    cancellable?: boolean;
    displayName: string;
    id?: string;
    leaseOwner?: string;
    payload?: Record<string, unknown>;
    priority?: number;
    queuedAt: string;
    resourceClass: JobResourceClass;
    scheduledJobId?: string;
    scheduledRunId?: number;
    status?: "queued" | "running";
    timeoutMs: number;
    triggerType: JobExecutionTriggerType;
}

export interface EnqueueJobExecutionInput {
    actionKey: string;
    availableAt?: string;
    cancellable?: boolean;
    displayName: string;
    id?: string;
    payload?: Record<string, unknown>;
    priority?: number;
    resourceClass: JobResourceClass;
    timeoutMs: number;
    triggerType?: JobExecutionTriggerType;
}

type QueuedJobCancellationHandler = (execution: JobExecution, timestamp: string) => void;
type ExpiredJobExecutionHandler = (execution: JobExecution) => void;

const queuedJobCancellationHandlers = new Map<string, QueuedJobCancellationHandler>();
const expiredJobExecutionHandlers = new Map<string, ExpiredJobExecutionHandler>();

/** Registers domain cleanup that participates in a queued cancellation transaction. */
export function registerQueuedJobCancellationHandler(
    actionKey: string,
    handler: QueuedJobCancellationHandler
): void {
    queuedJobCancellationHandlers.set(actionKey, handler);
}

/** Registers domain cleanup that participates in expired-lease recovery. */
export function registerExpiredJobExecutionHandler(
    actionKey: string,
    handler: ExpiredJobExecutionHandler
): void {
    expiredJobExecutionHandlers.set(actionKey, handler);
}

interface JobExecutionRow {
    id: string;
    scheduled_job_id: string | null | undefined;
    scheduled_run_id: number | null | undefined;
    action_key: string;
    display_name: string;
    resource_class: string;
    priority: number;
    status: string;
    trigger_type: string;
    payload_json: string;
    queued_at: string;
    available_at: string;
    started_at: string | null | undefined;
    finished_at: string | null | undefined;
    lease_owner: string | null | undefined;
    lease_expires_at: string | null | undefined;
    heartbeat_at: string | null | undefined;
    cancel_requested_at: string | null | undefined;
    cancellable: number;
    attempt: number;
    timeout_ms: number;
    message: string | null | undefined;
    output_json: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

function fromSqlNullable<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function mapExecution(row: JobExecutionRow | undefined): JobExecution | undefined {
    if (!row) return undefined;
    return {
        id: row.id,
        scheduledJobId: fromSqlNullable(row.scheduled_job_id),
        scheduledRunId: fromSqlNullable(row.scheduled_run_id),
        actionKey: row.action_key,
        displayName: row.display_name,
        resourceClass: isJobResourceClass(row.resource_class)
            ? row.resource_class
            : "light",
        priority: row.priority,
        status: row.status as JobExecutionStatus,
        triggerType: row.trigger_type as JobExecutionTriggerType,
        payload: parseJsonObject(row.payload_json),
        queuedAt: row.queued_at,
        availableAt: row.available_at,
        startedAt: fromSqlNullable(row.started_at),
        finishedAt: fromSqlNullable(row.finished_at),
        leaseOwner: fromSqlNullable(row.lease_owner),
        leaseExpiresAt: fromSqlNullable(row.lease_expires_at),
        heartbeatAt: fromSqlNullable(row.heartbeat_at),
        cancelRequestedAt: fromSqlNullable(row.cancel_requested_at),
        cancellable: row.cancellable === 1,
        attempt: row.attempt,
        timeoutMs: row.timeout_ms,
        message: fromSqlNullable(row.message),
        output: parseJsonObject(row.output_json),
    };
}

function statusError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode });
}

function leaseExpiry(timestamp: string, leaseMs = DEFAULT_LEASE_MS): string {
    return new Date(Date.parse(timestamp) + leaseMs).toISOString();
}

/** Inserts a queue row inside the caller's transaction. */
export function insertJobExecution(input: InsertJobExecutionInput): JobExecution {
    const id = input.id ?? Bun.randomUUIDv7();
    const status = input.status ?? "queued";
    const startedAt = status === "running" ? input.queuedAt : undefined;
    const leaseOwner = status === "running" ? input.leaseOwner : undefined;
    if (status === "running" && !leaseOwner) {
        throw new Error("Running job executions require a lease owner");
    }
    database
        .prepare(
            `INSERT INTO job_executions (
                id, scheduled_job_id, scheduled_run_id, action_key, display_name,
                resource_class, priority, status, trigger_type, payload_json,
                queued_at, available_at, started_at, lease_owner, lease_expires_at,
                heartbeat_at, cancellable, attempt, timeout_ms, output_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`
        )
        .run(
            id,
            sqlNullable(input.scheduledJobId),
            sqlNullable(input.scheduledRunId),
            input.actionKey,
            input.displayName,
            input.resourceClass,
            input.priority ?? jobResourcePriority(input.resourceClass),
            status,
            input.triggerType,
            JSON.stringify(input.payload ?? {}),
            input.queuedAt,
            input.availableAt ?? input.queuedAt,
            sqlNullable(startedAt),
            sqlNullable(leaseOwner),
            sqlNullable(startedAt ? leaseExpiry(startedAt) : undefined),
            sqlNullable(startedAt),
            input.cancellable === false ? 0 : 1,
            status === "running" ? 1 : 0,
            input.timeoutMs
        );
    return getJobExecution(id) as JobExecution;
}

export function getJobExecution(id: string): JobExecution | undefined {
    return mapExecution(
        database.prepare("SELECT * FROM job_executions WHERE id = ?").get(id) as
            JobExecutionRow | undefined
    );
}

export function getLatestScheduledJobExecution(
    scheduledJobId: string
): JobExecution | undefined {
    return mapExecution(
        database
            .prepare(
                `SELECT * FROM job_executions
                 WHERE scheduled_job_id = ?
                 ORDER BY queued_at DESC, id DESC
                 LIMIT 1`
            )
            .get(scheduledJobId) as JobExecutionRow | undefined
    );
}

/** Adds non-scheduled work to the same persistent queue used by the scheduler. */
export function enqueueJobExecution(
    input: EnqueueJobExecutionInput,
    queuedAt = nowIso()
): JobExecution {
    return insertJobExecution({
        ...input,
        queuedAt,
        triggerType: input.triggerType ?? "manual",
    });
}

export function listJobExecutions(limit = 50): JobExecution[] {
    const normalizedLimit =
        Number.isSafeInteger(limit) && limit > 0
            ? Math.min(limit, MAX_EXECUTION_LIST_LIMIT)
            : 50;
    return (
        database
            .prepare(
                `SELECT * FROM job_executions
                 ORDER BY
                    CASE WHEN status IN ('queued', 'running') THEN 0 ELSE 1 END,
                    CASE WHEN status IN ('queued', 'running') THEN queued_at END,
                    queued_at DESC,
                    id DESC
                 LIMIT ?`
            )
            .all(normalizedLimit) as unknown as JobExecutionRow[]
    ).map((row) => mapExecution(row) as JobExecution);
}

export function getJobExecutionSummary(timestamp = Date.now()): JobExecutionSummary {
    const counts = database
        .prepare(
            `SELECT
                 SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
                 SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
                 MIN(CASE WHEN status = 'queued' THEN queued_at END) AS oldest_queued_at
             FROM job_executions`
        )
        .get() as {
        oldest_queued_at: string | null | undefined;
        queued: number | null | undefined;
        running: number | null | undefined;
    };
    const activeRows = database
        .prepare(
            `SELECT DISTINCT resource_class
             FROM job_executions
             WHERE status = 'running'
             ORDER BY resource_class`
        )
        .all() as Array<{ resource_class: string }>;
    const oldestQueuedAt = fromSqlNullable(counts.oldest_queued_at);
    const parsedOldestQueuedAt = oldestQueuedAt ? Date.parse(oldestQueuedAt) : NaN;
    const workerFreshAfter = new Date(timestamp - 30_000).toISOString();
    const worker = database
        .prepare(
            `SELECT COUNT(*) AS count,
                    COALESCE(MAX(capacity), 0) AS capacity,
                    MAX(heartbeat_at) AS last_heartbeat_at
             FROM job_workers
             WHERE heartbeat_at >= ?`
        )
        .get(workerFreshAfter) as {
        capacity: number | null | undefined;
        count: number;
        last_heartbeat_at: string | null | undefined;
    };
    return {
        activeResourceClasses: activeRows
            .map((row) => row.resource_class)
            .filter(isJobResourceClass),
        oldestQueuedAgeMs: Number.isFinite(parsedOldestQueuedAt)
            ? Math.max(0, timestamp - parsedOldestQueuedAt)
            : undefined,
        oldestQueuedAt,
        queued: Number(counts.queued ?? 0),
        running: Number(counts.running ?? 0),
        workerCapacity: Number(worker.capacity ?? 0),
        workerCount: Number(worker.count ?? 0),
        workerLastHeartbeatAt: fromSqlNullable(worker.last_heartbeat_at),
        workerOnline: worker.count > 0,
    };
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
): JobExecution | undefined {
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
    return getJobExecution(row.id);
}

export function claimNextJobExecution(
    workerId: string,
    capacity = 1,
    timestamp = nowIso(),
    leaseMs = DEFAULT_LEASE_MS
): JobExecution | undefined {
    database.run("BEGIN IMMEDIATE");
    try {
        recoverExpiredJobExecutionsInTransaction(timestamp);
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

/** Replaces the bounded progress snapshot for an execution with an active lease. */
export function updateJobExecutionOutput(
    id: string,
    workerId: string,
    output: Record<string, unknown>
): JobExecution {
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
    return getJobExecution(id) as JobExecution;
}

export function finishJobExecution(
    id: string,
    workerId: string,
    status: "success" | "failed" | "cancelled",
    message: string | undefined,
    output: Record<string, unknown>,
    finishedAt = nowIso()
): JobExecution {
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
        const finalMessage = wasCancellationRequested
            ? "Job cancelled"
            : finalStatus === "cancelled"
              ? (message ?? "Job cancelled")
              : message;
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
        database.run("COMMIT");
        return getJobExecution(id) as JobExecution;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the finish error.
        }
        throw error;
    }
}

export function cancelJobExecution(id: string, timestamp = nowIso()): JobExecution {
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
        database.run("COMMIT");
        return getJobExecution(id) as JobExecution;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the cancellation error.
        }
        throw error;
    }
}
