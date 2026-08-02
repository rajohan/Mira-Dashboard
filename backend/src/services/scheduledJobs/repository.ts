import type {
    JobResourceClass,
    ScheduledJob,
    ScheduledJobPatch,
    ScheduledJobRun,
    ScheduledJobRunStatus,
    ScheduledJobScheduleType,
    ScheduledJobTriggerType,
} from "../../../../contracts/jobs.ts";
import { database, sqlNullable } from "../../database.ts";
import { isJobResourceClass } from "../../lib/jobResources.ts";
import { parseJobDisableIntent } from "../jobDisableIntent.ts";
import {
    assertValidActionTimeoutMs,
    assertValidScheduledJobActionKey,
    registeredScheduledJobAction,
} from "./actionRegistry.ts";
import { ScheduledJobValidationError } from "./errors.ts";
import { assertValidSchedule, calculateNextRunAt } from "./schedule.ts";

const DEFAULT_SCHEDULED_JOB_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const LATEST_RUNS_JOB_ID_CHUNK_SIZE = 900;

export interface ScheduledJobDefinition {
    id: string;
    name: string;
    description?: string;
    enabled?: boolean;
    scheduleType: ScheduledJobScheduleType;
    intervalSeconds?: number;
    timeOfDay?: string;
    cronExpression?: string;
    actionKey: string;
    actionPayload?: Record<string, unknown>;
    resourceClass?: JobResourceClass;
    timeoutMs?: number;
}

interface ScheduledJobRow {
    id: string;
    name: string;
    description: string;
    enabled: number;
    schedule_type: string;
    interval_seconds: number;
    time_of_day: string | null | undefined;
    cron_expression: string | null | undefined;
    action_key: string;
    action_payload_json: string;
    disable_intent_json: string | null | undefined;
    next_run_at: string | null | undefined;
    created_at: string;
    updated_at: string;
    resource_class?: string | null;
    timeout_ms?: number | null;
}

interface ScheduledJobRunRow {
    id: number;
    job_id: string;
    status: string;
    trigger_type: string;
    started_at: string;
    finished_at: string | null | undefined;
    message: string | null | undefined;
    output_json: string;
    execution_id?: string | null;
    execution_queued_at?: string | null;
    execution_resource_class?: string | null;
    execution_cancel_requested_at?: string | null;
    execution_cancellable?: number | null;
}

function fromSqlNullable<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
}

function nowIso(): string {
    return new Date().toISOString();
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

export function assertValidScheduledJobId(id: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(id)) {
        throw new ScheduledJobValidationError("Job id is invalid");
    }
}

function mapRun(row: ScheduledJobRunRow | undefined): ScheduledJobRun | undefined {
    if (!row) {
        return undefined;
    }
    const resourceClass = isJobResourceClass(row.execution_resource_class)
        ? row.execution_resource_class
        : "light";
    return {
        id: row.id,
        jobId: row.job_id,
        status: row.status as ScheduledJobRunStatus,
        triggerType: row.trigger_type as ScheduledJobTriggerType,
        startedAt: row.started_at,
        finishedAt: fromSqlNullable(row.finished_at),
        message: fromSqlNullable(row.message),
        output: parseJsonObject(row.output_json),
        executionId: fromSqlNullable(row.execution_id),
        queuedAt: fromSqlNullable(row.execution_queued_at) ?? row.started_at,
        resourceClass,
        cancelRequestedAt: fromSqlNullable(row.execution_cancel_requested_at),
        cancellable: row.execution_cancellable !== 0,
    };
}

function latestRunsByJobId(jobIds: string[]): Map<string, ScheduledJobRun> {
    if (jobIds.length === 0) {
        return new Map();
    }
    const runs = new Map<string, ScheduledJobRun>();
    for (
        let index = 0;
        index < jobIds.length;
        index += LATEST_RUNS_JOB_ID_CHUNK_SIZE
    ) {
        const chunk = jobIds.slice(index, index + LATEST_RUNS_JOB_ID_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = database
            .prepare(
                `SELECT *
                 FROM (
                     SELECT
                         run.*,
                         execution.id AS execution_id,
                         execution.queued_at AS execution_queued_at,
                         execution.resource_class AS execution_resource_class,
                         execution.cancel_requested_at AS execution_cancel_requested_at,
                         execution.cancellable AS execution_cancellable,
                         ROW_NUMBER() OVER (
                             PARTITION BY run.job_id
                             ORDER BY run.started_at DESC, run.id DESC
                         ) AS row_number
                     FROM scheduled_job_runs run
                     LEFT JOIN job_executions execution
                       ON execution.scheduled_run_id = run.id
                     WHERE run.job_id IN (${placeholders})
                 )
                 WHERE row_number = 1
                 ORDER BY job_id, started_at DESC, id DESC`
            )
            .all(...chunk) as unknown as ScheduledJobRunRow[];
        for (const row of rows) {
            if (runs.has(row.job_id)) {
                continue;
            }
            const run = mapRun(row);
            if (run) {
                runs.set(row.job_id, run);
            }
        }
    }
    return runs;
}

function mapJob(
    row: ScheduledJobRow,
    latestRuns = latestRunsByJobId([row.id])
): ScheduledJob {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        enabled: row.enabled === 1,
        scheduleType: row.schedule_type as ScheduledJobScheduleType,
        intervalSeconds: row.interval_seconds,
        timeOfDay: fromSqlNullable(row.time_of_day),
        cronExpression: fromSqlNullable(row.cron_expression),
        actionKey: row.action_key,
        actionPayload: parseJsonObject(row.action_payload_json),
        disableIntent: parseJobDisableIntent(row.disable_intent_json),
        nextRunAt: fromSqlNullable(row.next_run_at),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastRun: latestRuns.get(row.id),
        resourceClass: isJobResourceClass(row.resource_class)
            ? row.resource_class
            : "light",
        timeoutMs:
            typeof row.timeout_ms === "number" && row.timeout_ms > 0
                ? row.timeout_ms
                : DEFAULT_SCHEDULED_JOB_RUN_TIMEOUT_MS,
        isQueued: latestRuns.get(row.id)?.status === "queued",
        isRunning: latestRuns.get(row.id)?.status === "running",
    };
}

export function upsertScheduledJob(definition: ScheduledJobDefinition): ScheduledJob {
    assertValidScheduledJobId(definition.id);
    assertValidScheduledJobActionKey(definition.actionKey);
    const existing = getScheduledJob(definition.id);
    const enabled = definition.enabled ?? existing?.enabled ?? false;
    const scheduleType = definition.scheduleType ?? existing?.scheduleType;
    const intervalSeconds =
        definition.intervalSeconds ?? existing?.intervalSeconds ?? 3600;
    const timeOfDay =
        definition.timeOfDay === undefined
            ? existing?.timeOfDay
            : definition.timeOfDay;
    const cronExpression =
        definition.cronExpression === undefined
            ? existing?.cronExpression
            : definition.cronExpression;
    assertValidSchedule(scheduleType, intervalSeconds, timeOfDay, cronExpression);

    const timestamp = nowIso();
    const isScheduleChanged =
        !existing ||
        existing.enabled !== enabled ||
        existing.scheduleType !== scheduleType ||
        existing.intervalSeconds !== intervalSeconds ||
        existing.timeOfDay !== timeOfDay ||
        existing.cronExpression !== cronExpression;
    const nextRunAt = isScheduleChanged
        ? calculateNextRunAt(
              { cronExpression, enabled, intervalSeconds, scheduleType, timeOfDay },
              new Date(timestamp)
          )
        : existing.nextRunAt;
    const resourceClass = definition.resourceClass ?? "light";
    const timeoutMs =
        definition.timeoutMs ??
        registeredScheduledJobAction(definition.actionKey)?.timeoutMs ??
        DEFAULT_SCHEDULED_JOB_RUN_TIMEOUT_MS;
    assertValidActionTimeoutMs(timeoutMs);
    database
        .prepare(
            `INSERT INTO scheduled_jobs (
            id, name, description, enabled, schedule_type, interval_seconds,
            time_of_day, cron_expression, action_key, action_payload_json, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            enabled = excluded.enabled,
            schedule_type = excluded.schedule_type,
            interval_seconds = excluded.interval_seconds,
            time_of_day = excluded.time_of_day,
            cron_expression = excluded.cron_expression,
            action_key = excluded.action_key,
            action_payload_json = excluded.action_payload_json,
            next_run_at = excluded.next_run_at,
            updated_at = excluded.updated_at`
        )
        .run(
            definition.id,
            definition.name,
            definition.description ?? "",
            enabled ? 1 : 0,
            scheduleType,
            intervalSeconds,
            sqlNullable(timeOfDay),
            sqlNullable(cronExpression),
            definition.actionKey,
            JSON.stringify(definition.actionPayload ?? {}),
            sqlNullable(nextRunAt),
            existing?.createdAt ?? timestamp,
            timestamp
        );
    database
        .prepare(
            `INSERT INTO scheduled_job_execution_policies (
                job_id, resource_class, timeout_ms, updated_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(job_id) DO UPDATE SET
                 resource_class = excluded.resource_class,
                 timeout_ms = excluded.timeout_ms,
                 updated_at = excluded.updated_at`
        )
        .run(definition.id, resourceClass, timeoutMs, timestamp);
    return getScheduledJob(definition.id) as ScheduledJob;
}

export function listScheduledJobs(): ScheduledJob[] {
    const rows = database
        .prepare(
            `SELECT job.*, policy.resource_class, policy.timeout_ms
             FROM scheduled_jobs job
             LEFT JOIN scheduled_job_execution_policies policy ON policy.job_id = job.id
             ORDER BY job.name COLLATE NOCASE, job.id`
        )
        .all() as unknown as ScheduledJobRow[];
    const latestRuns = latestRunsByJobId(rows.map((row) => row.id));
    return rows.map((row) => mapJob(row, latestRuns));
}

export function getScheduledJob(id: string): ScheduledJob | undefined {
    const row = database
        .prepare(
            `SELECT job.*, policy.resource_class, policy.timeout_ms
             FROM scheduled_jobs job
             LEFT JOIN scheduled_job_execution_policies policy ON policy.job_id = job.id
             WHERE job.id = ?`
        )
        .get(id) as ScheduledJobRow | undefined;
    return row ? mapJob(row) : undefined;
}

export function listScheduledJobRuns(id: string, limit = 20): ScheduledJobRun[] {
    assertValidScheduledJobId(id);
    const normalizedLimit =
        Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    return (
        database
            .prepare(
                `SELECT run.*,
                        execution.id AS execution_id,
                        execution.queued_at AS execution_queued_at,
                        execution.resource_class AS execution_resource_class,
                        execution.cancel_requested_at AS execution_cancel_requested_at,
                        execution.cancellable AS execution_cancellable
                 FROM scheduled_job_runs run
                 LEFT JOIN job_executions execution
                   ON execution.scheduled_run_id = run.id
                 WHERE run.job_id = ?
                 ORDER BY run.started_at DESC, run.id DESC
                 LIMIT ?`
            )
            .all(id, normalizedLimit) as unknown as ScheduledJobRunRow[]
    )
        .map((row) => mapRun(row))
        .filter((run): run is ScheduledJobRun => run !== undefined);
}

export function removeScheduledJobsNotInAction(
    actionKey: string,
    registeredIds: readonly string[]
): void {
    assertValidScheduledJobActionKey(actionKey);
    for (const id of registeredIds) {
        assertValidScheduledJobId(id);
    }
    if (registeredIds.length === 0) {
        database
            .prepare("DELETE FROM scheduled_jobs WHERE action_key = ?")
            .run(actionKey);
        return;
    }
    const placeholders = registeredIds.map(() => "?").join(",");
    database
        .prepare(
            `DELETE FROM scheduled_jobs
             WHERE action_key = ?
               AND id NOT IN (${placeholders})`
        )
        .run(actionKey, ...registeredIds);
}

export function updateScheduledJob(
    id: string,
    patch: ScheduledJobPatch
): ScheduledJob | undefined {
    const existing = getScheduledJob(id);
    if (!existing) {
        return undefined;
    }
    const next = {
        disableIntent:
            patch.enabled === true || patch.disableIntent === null
                ? undefined
                : (patch.disableIntent ?? existing.disableIntent),
        enabled: patch.enabled ?? existing.enabled,
        scheduleType: patch.scheduleType ?? existing.scheduleType,
        intervalSeconds: patch.intervalSeconds ?? existing.intervalSeconds,
        timeOfDay:
            patch.timeOfDay === undefined
                ? existing.timeOfDay
                : (patch.timeOfDay ?? undefined),
        cronExpression:
            patch.cronExpression === undefined
                ? existing.cronExpression
                : (patch.cronExpression ?? undefined),
    };
    assertValidSchedule(
        next.scheduleType,
        next.intervalSeconds,
        next.timeOfDay,
        next.cronExpression
    );
    const timestamp = nowIso();
    const isScheduleChanged =
        existing.enabled !== next.enabled ||
        existing.scheduleType !== next.scheduleType ||
        existing.intervalSeconds !== next.intervalSeconds ||
        existing.timeOfDay !== next.timeOfDay ||
        existing.cronExpression !== next.cronExpression;
    const nextRunAt = isScheduleChanged
        ? calculateNextRunAt(next, new Date(timestamp))
        : existing.nextRunAt;
    database
        .prepare(
            `UPDATE scheduled_jobs
             SET enabled = ?, schedule_type = ?, interval_seconds = ?, time_of_day = ?, cron_expression = ?,
                 disable_intent_json = ?, next_run_at = ?, updated_at = ?
             WHERE id = ?`
        )
        .run(
            next.enabled ? 1 : 0,
            next.scheduleType,
            next.intervalSeconds,
            sqlNullable(next.timeOfDay),
            sqlNullable(next.cronExpression),
            sqlNullable(
                next.disableIntent ? JSON.stringify(next.disableIntent) : undefined
            ),
            sqlNullable(nextRunAt),
            timestamp,
            id
        );
    return getScheduledJob(id);
}

export function scheduledRunById(id: number): ScheduledJobRun | undefined {
    const row = database
        .prepare(
            `SELECT run.*,
                    execution.id AS execution_id,
                    execution.queued_at AS execution_queued_at,
                    execution.resource_class AS execution_resource_class,
                    execution.cancel_requested_at AS execution_cancel_requested_at,
                    execution.cancellable AS execution_cancellable
             FROM scheduled_job_runs run
             LEFT JOIN job_executions execution ON execution.scheduled_run_id = run.id
             WHERE run.id = ?`
        )
        .get(id) as ScheduledJobRunRow | undefined;
    return mapRun(row);
}

export function insertScheduledRun(
    jobId: string,
    triggerType: ScheduledJobTriggerType,
    status: "queued" | "running",
    timestamp: string
): number {
    const result = database
        .prepare(
            `INSERT INTO scheduled_job_runs (
                job_id, status, trigger_type, started_at, output_json
            ) VALUES (?, ?, ?, ?, '{}')`
        )
        .run(jobId, status, triggerType, timestamp);
    return Number(result.lastInsertRowid);
}
