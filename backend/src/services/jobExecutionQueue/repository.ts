import type { JobExecutionSummary } from "../../../../contracts/jobs/executions.ts";
import type {
    JobExecutionStatus,
    JobExecutionTriggerType,
    JobResourceClass,
} from "../../../../contracts/jobs/shared.ts";
import { database, sqlNullable } from "../../database/connection.ts";
import { currentRequestAuditContext } from "../../http/requestAuditContext.ts";
import { isJobResourceClass, jobResourcePriority } from "../../lib/jobResources.ts";
import {
    type AuditActor,
    type AuditOutcome,
    auditProvenanceForTarget,
    writeAuditEvent,
} from "../auditEvents.ts";
import { getJobWorkerClaimsState } from "../jobWorkerControl.ts";

export const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const MAX_EXECUTION_LIST_LIMIT = 200;
export const JOB_WORKER_HEARTBEAT_MAX_AGE_MS = 30_000;
const RELEASE_COMMIT_PATTERN = /^[\da-f]{8,40}$/u;

export interface JobExecutionRecord {
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
export interface JobExecutionRow {
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

export function nowIso(): string {
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

export function mapExecution(
    row: JobExecutionRow | undefined
): JobExecutionRecord | undefined {
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

export function statusError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode });
}

export function leaseExpiry(timestamp: string, leaseMs = DEFAULT_LEASE_MS): string {
    return new Date(Date.parse(timestamp) + leaseMs).toISOString();
}

function systemActor(triggerType: JobExecutionTriggerType): AuditActor {
    return { id: `job-${triggerType}`, type: "system" };
}

function jobAuditProvenance(
    executionId: string,
    triggerType: JobExecutionTriggerType
): { actor: AuditActor; requestId: string | undefined } {
    const requestContext = currentRequestAuditContext();
    if (requestContext) {
        return {
            actor: requestContext.actor,
            requestId: requestContext.requestId,
        };
    }
    return (
        auditProvenanceForTarget("job.enqueue", "job-execution", executionId) ?? {
            actor: systemActor(triggerType),
            requestId: undefined,
        }
    );
}

/**
 * Records the backend-generated transition timestamp already persisted on the
 * job row. Route payloads never supply this value.
 */
export function writeJobAudit(
    execution: Pick<
        JobExecutionRecord,
        | "actionKey"
        | "displayName"
        | "id"
        | "resourceClass"
        | "scheduledJobId"
        | "triggerType"
    >,
    action: "job.cancel" | "job.enqueue" | "job.execute",
    outcome: AuditOutcome,
    transitionAt: string,
    metadata: Record<string, unknown> = {}
): void {
    const provenance = jobAuditProvenance(execution.id, execution.triggerType);
    writeAuditEvent({
        actor: provenance.actor,
        action,
        metadata: {
            actionKey: execution.actionKey,
            displayName: execution.displayName,
            resourceClass: execution.resourceClass,
            scheduledJobId: execution.scheduledJobId,
            triggerType: execution.triggerType,
            ...metadata,
        },
        occurredAt: transitionAt,
        outcome,
        requestId: provenance.requestId,
        targetId: execution.id,
        targetType: "job-execution",
    });
}

function insertJobExecutionInTransaction(
    input: InsertJobExecutionInput
): JobExecutionRecord {
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
    const execution = getJobExecution(id) as JobExecutionRecord;
    writeJobAudit(execution, "job.enqueue", "accepted", input.queuedAt);
    if (status === "running") {
        writeJobAudit(execution, "job.execute", "attempted", input.queuedAt, {
            attempt: execution.attempt,
            workerId: execution.leaseOwner,
        });
    }
    return execution;
}

/**
 * Atomically inserts queue and audit rows, reusing an existing caller transaction.
 * @returns Insert job execution result.
 */
export function insertJobExecution(input: InsertJobExecutionInput): JobExecutionRecord {
    if (database.inTransaction) {
        return insertJobExecutionInTransaction(input);
    }

    database.run("BEGIN IMMEDIATE");
    try {
        const execution = insertJobExecutionInTransaction(input);
        database.run("COMMIT");
        return execution;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the insertion or audit error.
        }
        throw error;
    }
}

export function getJobExecution(id: string): JobExecutionRecord | undefined {
    return mapExecution(
        database.prepare("SELECT * FROM job_executions WHERE id = ?").get(id) as
            | JobExecutionRow
            | undefined
    );
}

export function getLatestScheduledJobExecution(
    scheduledJobId: string
): JobExecutionRecord | undefined {
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

export function getPreviousScheduledJobExecution(
    scheduledJobId: string,
    executionId: string
): JobExecutionRecord | undefined {
    return mapExecution(
        database
            .prepare(
                `SELECT candidate.*
                 FROM job_executions candidate
                 JOIN job_executions current ON current.id = ?
                 WHERE candidate.scheduled_job_id = ?
                   AND (
                       candidate.queued_at < current.queued_at
                       OR (
                           candidate.queued_at = current.queued_at
                           AND candidate.id < current.id
                       )
                   )
                 ORDER BY candidate.queued_at DESC, candidate.id DESC
                 LIMIT 1`
            )
            .get(executionId, scheduledJobId) as JobExecutionRow | undefined
    );
}

/**
 * Adds non-scheduled work to the same persistent queue used by the scheduler.
 * @returns Enqueue job execution result.
 */
export function enqueueJobExecution(
    input: EnqueueJobExecutionInput,
    queuedAt = nowIso()
): JobExecutionRecord {
    return insertJobExecution({
        ...input,
        queuedAt,
        triggerType: input.triggerType ?? "manual",
    });
}

export function listJobExecutions(limit = 50): JobExecutionRecord[] {
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
    ).map((row) => mapExecution(row) as JobExecutionRecord);
}

export function getJobExecutionSummary(timestamp = Date.now()): JobExecutionSummary {
    const claims = getJobWorkerClaimsState();
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
    const parsedOldestQueuedAt = oldestQueuedAt ? Date.parse(oldestQueuedAt) : Number.NaN;
    const workerFreshAfter = new Date(
        timestamp - JOB_WORKER_HEARTBEAT_MAX_AGE_MS
    ).toISOString();
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
            .filter((resourceClass) => isJobResourceClass(resourceClass)),
        claimsPaused: claims.paused,
        claimsPausedAt: claims.paused ? claims.updatedAt : undefined,
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

export function isJobWorkerReleaseReady(
    releaseCommit: string,
    timestamp = Date.now()
): boolean {
    if (!RELEASE_COMMIT_PATTERN.test(releaseCommit)) {
        return false;
    }
    const freshAfter = new Date(
        timestamp - JOB_WORKER_HEARTBEAT_MAX_AGE_MS
    ).toISOString();
    const row = database
        .prepare(
            `SELECT 1
             FROM job_workers
             WHERE heartbeat_at >= ?
               AND id LIKE ?
             LIMIT 1`
        )
        .get(freshAfter, `dashboard-worker:${releaseCommit}:%`);
    return row !== null && row !== undefined;
}
