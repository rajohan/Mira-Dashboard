import type {
    JobResourceClass,
    ScheduledJob,
    ScheduledJobPatch,
    ScheduledJobRun,
    ScheduledJobRunStatus,
    ScheduledJobScheduleType,
    ScheduledJobTriggerType,
} from "../../../contracts/jobs.ts";
import type { SchedulerMetrics } from "../../../contracts/metrics.ts";
import { database, sqlNullable } from "../database.ts";
import { errorMessage } from "../lib/errors.ts";
import { isJobResourceClass, withJobResourceClass } from "../lib/jobResources.ts";
import { runWithLogContext } from "../lib/logContext.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { parseJobDisableIntent } from "./jobDisableIntent.ts";
import {
    claimNextJobExecution,
    didHeartbeatJobWorker,
    finishJobExecution,
    getJobExecution,
    getJobExecutionSummary,
    heartbeatJobExecution,
    insertJobExecution,
    type JobExecutionRecord,
    protectRunningJobExecutionFromCancellation,
    recoverExpiredJobExecutions,
    registerJobWorker,
    unregisterJobWorker,
    updateJobExecutionOutput,
} from "./jobExecutionQueue.ts";
import { waitForJobExecution } from "./queuedJobExecution.ts";

const logger = createStructuredLogger("scheduled-jobs");

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const schedulerTickMs = 30_000;
const defaultScheduledJobRunTimeoutMs = 5 * 60 * 1000;
const minimumIntervalSeconds = 60;
const latestRunsJobIdChunkSize = 900;
const executorTickMs = 1000;
const executorHeartbeatMs = 1000;
const executorCapacity = 1;
const deploymentCutoverReconcileIntervalMs = 5000;
const deploymentCutoverMaximumUnknownMs = 10 * 60 * 1000;
const interruptedHandlerGraceMs = 30_000;
const RELEASE_COMMIT_PATTERN = /^(?:[\da-f]{8,40}|development)$/u;
const FULL_RELEASE_COMMIT_PATTERN = /^[\da-f]{40}$/u;
const DEPLOYMENT_GUARDIAN_UNIT_PREFIX = "mira-dashboard-deploy-";
const DEPLOYMENT_RECOVERY_UNIT_PREFIX = "mira-dashboard-deploy-recovery-";
const actionHandlers = new Map<string, ScheduledJobActionRegistration>();
const interruptedHandlerSettled = new WeakMap<
    ScheduledJobInterruptionError,
    Promise<unknown>
>();
const activeExecutionControllers = new Map<string, AbortController>();
const activeExecutionRuns = new Map<string, Promise<void>>();

type DeploymentGuardianState = "active" | "inactive" | "unknown";
type DeploymentGuardianStateReader = (jobId: string) => DeploymentGuardianState;
export interface OrphanedDeploymentCutover {
    candidateCommit?: string;
    id: string;
    updatedAt: string;
}
export type DeploymentCutoverRecoveryHandler = (
    cutover: OrphanedDeploymentCutover
) => boolean;

const scheduledJobRuntimeState: {
    scheduler: NodeJS.Timeout | undefined;
    executor: NodeJS.Timeout | undefined;
    workerHeartbeat: NodeJS.Timeout | undefined;
    executorClaimPauseGeneration: number;
    deploymentCutoverRecoveryHandler: DeploymentCutoverRecoveryHandler | undefined;
    isSchedulerTickRunning: boolean;
    isExecutorClaimingPaused: boolean;
    isExecutorTickRunning: boolean;
    lastSchedulerTickAt: string | undefined;
    lastSchedulerTickDurationMs: number;
    missingCutoverRecoveryWarningKey: string | undefined;
    nextDeploymentCutoverReconcileAt: number;
    schedulerQueueFailures: number;
    schedulerTickFailures: number;
    schedulerTicks: number;
    workerId: string;
} = {
    scheduler: undefined,
    executor: undefined,
    workerHeartbeat: undefined,
    executorClaimPauseGeneration: 0,
    deploymentCutoverRecoveryHandler: undefined,
    isSchedulerTickRunning: false,
    isExecutorClaimingPaused: false,
    isExecutorTickRunning: false,
    lastSchedulerTickAt: undefined,
    lastSchedulerTickDurationMs: 0,
    missingCutoverRecoveryWarningKey: undefined,
    nextDeploymentCutoverReconcileAt: 0,
    schedulerQueueFailures: 0,
    schedulerTickFailures: 0,
    schedulerTicks: 0,
    workerId: "",
};

export interface ScheduledJobActionContext {
    executionId: string;
    pauseWorkerClaims: () => () => void;
    protectFromCancellation: () => void;
    updateOutput: (output: Record<string, unknown>) => void;
}
export type ScheduledJobActionHandler = (
    job: ScheduledJob,
    signal: AbortSignal | undefined,
    context: ScheduledJobActionContext
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface ScheduledJobActionOptions {
    timeoutMs?: number;
}

interface ScheduledJobActionRegistration {
    handler: ScheduledJobActionHandler;
    timeoutMs?: number;
}

/** Allows an action failure to persist structured output with the failed run. */
export class ScheduledJobActionError extends Error {
    readonly output: Record<string, unknown>;

    constructor(message: string, output: Record<string, unknown>) {
        super(message);
        this.name = "ScheduledJobActionError";
        this.output = output;
    }
}

class ScheduledJobInterruptionError extends Error {
    constructor(message: string, handlerSettled: Promise<unknown>) {
        super(message);
        interruptedHandlerSettled.set(this, handlerSettled);
    }

    getHandlerSettled(): Promise<unknown> {
        return interruptedHandlerSettled.get(this)!;
    }
}

export interface ScheduledJobDefinition {
    id: string;
    name: string;
    description?: string;
    enabled?: boolean;
    scheduleType: ScheduledJobScheduleType;
    intervalSeconds?: number;
    timeOfDay?: string | undefined;
    cronExpression?: string | undefined;
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

export class ScheduledJobValidationError extends Error {
    declare statusCode: number;

    constructor(message: string) {
        super(message);
        this.name = "ScheduledJobValidationError";
        this.statusCode = 400;
    }
}

function fromSqlNullable<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
}

export function isScheduledJobValidationError(
    error: unknown
): error is ScheduledJobValidationError {
    return error instanceof ScheduledJobValidationError;
}

function nowIso(): string {
    return dateToISOString(new Date());
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

function assertValidId(id: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(id)) {
        throw new ScheduledJobValidationError("Job id is invalid");
    }
}

function assertValidActionKey(actionKey: string): void {
    if (!/^[a-z][a-z0-9.-]{1,79}$/u.test(actionKey)) {
        throw new ScheduledJobValidationError("Job action key is invalid");
    }
}

function assertValidSchedule(
    scheduleType: ScheduledJobScheduleType,
    intervalSeconds: number,
    timeOfDay: string | undefined,
    cronExpression: string | undefined
): void {
    if (scheduleType === "interval") {
        if (
            !Number.isSafeInteger(intervalSeconds) ||
            intervalSeconds < minimumIntervalSeconds
        ) {
            throw new ScheduledJobValidationError(
                `Interval must be at least ${minimumIntervalSeconds} seconds`
            );
        }
        return;
    }

    if (scheduleType === "daily") {
        if (!timeOfDay || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDay)) {
            throw new ScheduledJobValidationError("Daily jobs require HH:MM timeOfDay");
        }
        return;
    }

    if (!cronExpression || !parseCronExpression(cronExpression)) {
        throw new ScheduledJobValidationError("Cron jobs require a valid cronExpression");
    }
}

function parseCronField(
    field: string,
    minimum: number,
    maximum: number
): Set<number> | undefined {
    const values = new Set<number>();
    for (const part of field.split(",")) {
        if (!part) {
            return undefined;
        }
        const stepPieces = part.split("/");
        if (stepPieces.length > 2) {
            return undefined;
        }
        const [rangePart = "", stepPart] = stepPieces;
        const step = stepPart === undefined ? 1 : Number(stepPart);
        if (!Number.isSafeInteger(step) || step < 1) {
            return undefined;
        }
        const rangePieces = rangePart.split("-");
        if (rangePieces.length > 2) {
            return undefined;
        }
        let start: number;
        let end: number;
        if (rangePart === "*") {
            start = minimum;
            end = maximum;
        } else if (rangePart.includes("-")) {
            const [rawStart, rawEnd] = rangePieces;
            if (
                rawStart === undefined ||
                rawStart === "" ||
                rawEnd === undefined ||
                rawEnd === ""
            ) {
                return undefined;
            }
            start = Number(rawStart);
            end = Number(rawEnd);
        } else {
            if (rangePart === "") {
                return undefined;
            }
            start = Number(rangePart);
            end = stepPart === undefined ? Number(rangePart) : maximum;
        }
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < minimum ||
            end > maximum ||
            start > end
        ) {
            return undefined;
        }
        for (let value = start; value <= end; value += step) {
            values.add(value);
        }
    }
    return values;
}

function isCronFieldWildcard(
    values: Set<number>,
    minimum: number,
    maximum: number
): boolean {
    for (let value = minimum; value <= maximum; value += 1) {
        if (!values.has(value)) {
            return false;
        }
    }
    return true;
}

function parseCronExpression(expression: string):
    | undefined
    | {
          minutes: Set<number>;
          hours: Set<number>;
          daysOfMonth: Set<number>;
          months: Set<number>;
          daysOfWeek: Set<number>;
          dayOfMonthWildcard: boolean;
          dayOfWeekWildcard: boolean;
      } {
    const fields = expression.trim().split(/\s+/u);
    if (fields.length !== 5) {
        return undefined;
    }
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    if (
        minute === undefined ||
        hour === undefined ||
        dayOfMonth === undefined ||
        month === undefined ||
        dayOfWeek === undefined
    ) {
        return undefined;
    }
    const minutes = parseCronField(minute, 0, 59);
    const hours = parseCronField(hour, 0, 23);
    const daysOfMonth = parseCronField(dayOfMonth, 1, 31);
    const months = parseCronField(month, 1, 12);
    const daysOfWeek = parseCronField(dayOfWeek, 0, 7);
    if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
        return undefined;
    }
    if (daysOfWeek.has(7)) {
        daysOfWeek.add(0);
        daysOfWeek.delete(7);
    }
    return {
        minutes,
        hours,
        daysOfMonth,
        months,
        daysOfWeek,
        dayOfMonthWildcard: isCronFieldWildcard(daysOfMonth, 1, 31),
        dayOfWeekWildcard: isCronFieldWildcard(daysOfWeek, 0, 6),
    };
}

function isCronDayMatch(
    cron: NonNullable<ReturnType<typeof parseCronExpression>>,
    day: Date
): boolean {
    const dayOfMonthMatches = cron.daysOfMonth.has(day.getUTCDate());
    const dayOfWeekMatches = cron.daysOfWeek.has(day.getUTCDay());
    if (!cron.dayOfMonthWildcard && !cron.dayOfWeekWildcard) {
        return dayOfMonthMatches || dayOfWeekMatches;
    }
    return dayOfMonthMatches && dayOfWeekMatches;
}

function nextCronRun(now: Date, expression: string): Date {
    const cron = parseCronExpression(expression);
    if (!cron) {
        throw new ScheduledJobValidationError("Cron jobs require a valid cronExpression");
    }
    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(next.getUTCMinutes() + 1);
    const maximumAttempts = 5 * 366 * 24 * 60;
    for (let index = 0; index < maximumAttempts; index += 1) {
        if (
            cron.minutes.has(next.getUTCMinutes()) &&
            cron.hours.has(next.getUTCHours()) &&
            cron.months.has(next.getUTCMonth() + 1) &&
            isCronDayMatch(cron, next)
        ) {
            return next;
        }
        next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    throw new ScheduledJobValidationError("Cron expression has no upcoming run");
}

function nextDailyRun(now: Date, timeOfDay: string): Date {
    const [hour = "0", minute = "0"] = timeOfDay.split(":", 2);
    const next = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            Number(hour),
            Number(minute),
            0,
            0
        )
    );
    if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
}

export function calculateNextRunAt(
    job: Pick<
        ScheduledJob,
        "enabled" | "intervalSeconds" | "scheduleType" | "timeOfDay"
    > &
        Pick<Partial<ScheduledJob>, "cronExpression">,
    from = new Date()
): string | undefined {
    if (!job.enabled) {
        return undefined;
    }
    if (job.scheduleType === "daily" && job.timeOfDay) {
        return nextDailyRun(from, job.timeOfDay).toISOString();
    }
    if (job.scheduleType === "cron" && job.cronExpression) {
        return nextCronRun(from, job.cronExpression).toISOString();
    }
    return dateToISOString(new Date(from.getTime() + job.intervalSeconds * 1000));
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

function addLatestRunByJobId(
    runs: Map<string, ScheduledJobRun>,
    row: ScheduledJobRunRow
): void {
    if (runs.has(row.job_id)) {
        return;
    }

    const run = mapRun(row);
    if (run) {
        runs.set(row.job_id, run);
    }
}

function latestRunsByJobId(jobIds: string[]): Map<string, ScheduledJobRun> {
    if (jobIds.length === 0) {
        return new Map();
    }
    const runs = new Map<string, ScheduledJobRun>();
    for (let index = 0; index < jobIds.length; index += latestRunsJobIdChunkSize) {
        const chunk = jobIds.slice(index, index + latestRunsJobIdChunkSize);
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
            addLatestRunByJobId(runs, row);
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
        lastRun: latestRuns.get(row.id) ?? undefined,
        resourceClass: isJobResourceClass(row.resource_class)
            ? row.resource_class
            : "light",
        timeoutMs:
            typeof row.timeout_ms === "number" && row.timeout_ms > 0
                ? row.timeout_ms
                : defaultScheduledJobRunTimeoutMs,
        isQueued: latestRuns.get(row.id)?.status === "queued",
        isRunning: latestRuns.get(row.id)?.status === "running",
    };
}

export function registerScheduledJobAction(
    actionKey: string,
    handler: ScheduledJobActionHandler,
    options: ScheduledJobActionOptions = {}
): void {
    assertValidActionKey(actionKey);
    assertValidActionTimeoutMs(options.timeoutMs);
    actionHandlers.set(actionKey, {
        handler,
        timeoutMs: options.timeoutMs,
    });
}

function assertValidActionTimeoutMs(timeoutMs: number | undefined): void {
    if (timeoutMs === undefined) {
        return;
    }
    if (
        !Number.isFinite(timeoutMs) ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 2_147_483_647
    ) {
        throw new ScheduledJobValidationError(
            "Scheduled job action timeout must be an integer between 1 and 2147483647"
        );
    }
}

export function upsertScheduledJob(definition: ScheduledJobDefinition): ScheduledJob {
    assertValidId(definition.id);
    assertValidActionKey(definition.actionKey);
    const existing = getScheduledJob(definition.id);
    const enabled = definition.enabled ?? existing?.enabled ?? false;
    const scheduleType = definition.scheduleType ?? existing?.scheduleType;
    const intervalSeconds =
        definition.intervalSeconds ?? existing?.intervalSeconds ?? 3600;
    const timeOfDay =
        definition.timeOfDay === undefined
            ? (existing?.timeOfDay ?? undefined)
            : definition.timeOfDay;
    const cronExpression =
        definition.cronExpression === undefined
            ? (existing?.cronExpression ?? undefined)
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
        actionHandlers.get(definition.actionKey)?.timeoutMs ??
        defaultScheduledJobRunTimeoutMs;
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
    assertValidId(id);
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
    assertValidActionKey(actionKey);
    for (const id of registeredIds) {
        assertValidId(id);
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

interface EnqueueScheduledJobOptions {
    availableAt?: string;
}

function scheduledRunById(id: number): ScheduledJobRun | undefined {
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

function insertScheduledRun(
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

function isActiveExecutionConflict(error: unknown): boolean {
    const message = errorMessage(error, "");
    return (
        message.includes("UNIQUE constraint failed: job_executions.scheduled_job_id") ||
        message.includes("idx_job_executions_active_scheduled_job")
    );
}

function jobStatusError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode });
}

export function enqueueScheduledJob(
    id: string,
    triggerType: ScheduledJobTriggerType = "manual",
    options: EnqueueScheduledJobOptions = {}
): ScheduledJobRun {
    const job = getScheduledJob(id);
    if (!job) throw jobStatusError("Scheduled job not found", 404);
    if (triggerType !== "manual" && !job.enabled) {
        throw jobStatusError("Scheduled job is disabled", 409);
    }

    const queuedAt = nowIso();
    database.run("BEGIN IMMEDIATE");
    try {
        if (triggerType === "schedule") {
            const nextRunAt = calculateNextRunAt(job, new Date(queuedAt));
            const update = database
                .prepare(
                    `UPDATE scheduled_jobs
                     SET next_run_at = ?, updated_at = ?
                     WHERE id = ? AND enabled = 1
                       AND next_run_at IS NOT NULL AND next_run_at <= ?`
                )
                .run(sqlNullable(nextRunAt), queuedAt, job.id, queuedAt);
            if (update.changes === 0) {
                throw jobStatusError("Scheduled job is no longer due", 409);
            }
        }

        const runId = insertScheduledRun(job.id, triggerType, "queued", queuedAt);
        insertJobExecution({
            actionKey: job.actionKey,
            availableAt: options.availableAt,
            displayName: job.name,
            payload: job.actionPayload,
            queuedAt,
            resourceClass: job.resourceClass,
            scheduledJobId: job.id,
            scheduledRunId: runId,
            timeoutMs: job.timeoutMs,
            triggerType,
        });
        database.run("COMMIT");
        return scheduledRunById(runId) as ScheduledJobRun;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the enqueue error.
        }
        if (isActiveExecutionConflict(error)) {
            throw jobStatusError("Scheduled job is already queued or running", 409);
        }
        throw error;
    }
}

export async function runScheduledJob(
    id: string,
    triggerType: ScheduledJobTriggerType = "manual",
    signal?: AbortSignal
): Promise<ScheduledJobRun> {
    const job = getScheduledJob(id);
    if (!job) throw jobStatusError("Scheduled job not found", 404);
    const action = actionHandlers.get(job.actionKey);
    if (!action && triggerType === "manual") {
        throw new ScheduledJobValidationError(
            `No scheduled job action registered for ${job.actionKey}`
        );
    }
    const run = enqueueScheduledJob(id, triggerType);
    if (!run.executionId) throw jobStatusError("Scheduled job was not queued", 500);
    await waitForJobExecution(run.executionId, { signal });
    return scheduledRunById(run.id) as ScheduledJobRun;
}

async function executeClaimedJobExecution(
    execution: JobExecutionRecord,
    workerId: string,
    signal?: AbortSignal
): Promise<JobExecutionRecord | ScheduledJobRun> {
    const currentJob = execution.scheduledJobId
        ? getScheduledJob(execution.scheduledJobId)
        : undefined;
    if (!currentJob && execution.scheduledJobId) {
        return finishJobExecution(
            execution.id,
            workerId,
            "cancelled",
            "Scheduled job was removed before execution",
            {}
        );
    }
    if (currentJob && !currentJob.enabled && execution.triggerType !== "manual") {
        const finishedExecution = finishJobExecution(
            execution.id,
            workerId,
            "cancelled",
            "Scheduled job was disabled before execution",
            {}
        );
        return execution.scheduledRunId === undefined
            ? finishedExecution
            : (scheduledRunById(execution.scheduledRunId) as ScheduledJobRun);
    }
    const job: ScheduledJob = currentJob
        ? {
              ...currentJob,
              actionKey: execution.actionKey,
              actionPayload: execution.payload,
              resourceClass: execution.resourceClass,
              timeoutMs: execution.timeoutMs,
          }
        : {
              actionKey: execution.actionKey,
              actionPayload: execution.payload,
              createdAt: execution.queuedAt,
              cronExpression: undefined,
              description: "",
              disableIntent: undefined,
              enabled: true,
              id: execution.id,
              intervalSeconds: 60,
              isQueued: false,
              isRunning: true,
              lastRun: undefined,
              name: execution.displayName,
              nextRunAt: undefined,
              resourceClass: execution.resourceClass,
              scheduleType: "interval",
              timeOfDay: undefined,
              timeoutMs: execution.timeoutMs,
              updatedAt: execution.startedAt ?? execution.queuedAt,
          };
    const action = actionHandlers.get(execution.actionKey);
    const controller = new AbortController();
    const abortFromSignal = () => controller.abort();
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    if (signal?.aborted) controller.abort();
    const heartbeat = setInterval(() => {
        try {
            const lease = heartbeatJobExecution(execution.id, workerId);
            if (!lease.hasLease || lease.cancelRequested) controller.abort();
        } catch (error) {
            logger.warn("scheduled_jobs.execution_heartbeat_failed", {
                error,
                executionId: execution.id,
            });
        }
    }, executorHeartbeatMs);
    heartbeat.unref();

    let status: "success" | "failed" = "success";
    let message: string | undefined;
    let output: Record<string, unknown>;
    try {
        try {
            if (!action) {
                throw new ScheduledJobValidationError(
                    `No scheduled job action registered for ${execution.actionKey}`
                );
            }
            output = await withJobResourceClass(execution.resourceClass, () =>
                runActionWithTimeout(
                    execution.timeoutMs,
                    action,
                    job,
                    {
                        executionId: execution.id,
                        pauseWorkerClaims: pauseExecutorClaims,
                        protectFromCancellation: () => {
                            protectRunningJobExecutionFromCancellation(execution.id);
                        },
                        updateOutput: (nextOutput) => {
                            updateJobExecutionOutput(execution.id, workerId, nextOutput);
                        },
                    },
                    controller.signal
                )
            );
        } catch (error) {
            if (error instanceof ScheduledJobInterruptionError) {
                const didSettle = await waitForInterruptedHandler(
                    error.getHandlerSettled()
                );
                if (!didSettle) {
                    logger.warn("scheduled_jobs.interrupted_action_cleanup_timed_out", {
                        executionId: execution.id,
                    });
                }
            }
            status = "failed";
            message = errorMessage(error, "Scheduled job failed");
            const progressOutput = getJobExecution(execution.id)?.output ?? {};
            const statusCode = Number(
                (error as { statusCode?: unknown } | undefined)?.statusCode
            );
            output = {
                ...progressOutput,
                ...(error instanceof ScheduledJobActionError && error.output),
                ...(Number.isSafeInteger(statusCode) &&
                    statusCode >= 400 &&
                    statusCode < 600 && { statusCode }),
            };
        }
        const finishedExecution = finishJobExecution(
            execution.id,
            workerId,
            status,
            message,
            output
        );
        return execution.scheduledRunId === undefined
            ? finishedExecution
            : (scheduledRunById(execution.scheduledRunId) as ScheduledJobRun);
    } finally {
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", abortFromSignal);
    }
}

async function runActionWithTimeout(
    timeoutMs: number,
    action: ScheduledJobActionRegistration,
    job: ScheduledJob,
    context: ScheduledJobActionContext,
    signal?: AbortSignal
): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
        throw new Error("Scheduled job aborted");
    }
    const controller = new AbortController();
    const abortPromise = Promise.withResolvers<never>();
    let handlerSettled: Promise<unknown> = Promise.resolve();
    const interrupt = (message: string) => {
        abortPromise.reject(new ScheduledJobInterruptionError(message, handlerSettled));
        controller.abort();
    };
    const abortFromSignal = () => interrupt("Scheduled job aborted");
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    let timeout: NodeJS.Timeout | undefined;
    try {
        timeout = setTimeout(() => {
            logger.warn("scheduled_jobs.execution_timed_out", {
                timeoutMs,
            });
            interrupt("Scheduled job timed out");
        }, timeoutMs);
        timeout?.unref();
        const handlerPromise = Promise.resolve(
            action.handler(job, controller.signal, context)
        );
        handlerSettled = suppressHandlerPromiseRejection(handlerPromise);
        const output = (await Promise.race([handlerPromise, abortPromise.promise])) ?? {};
        return output;
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        signal?.removeEventListener("abort", abortFromSignal);
    }
}

async function suppressHandlerPromiseRejection(
    handlerPromise: Promise<unknown>
): Promise<void> {
    try {
        await handlerPromise;
    } catch {
        // The race reports handler failures unless the timeout already won.
    }
}

async function waitForInterruptedHandler(
    handlerSettled: Promise<unknown>
): Promise<boolean> {
    const didSettle = async () => {
        await handlerSettled;
        return true;
    };
    const timeout = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => timeout.resolve(false), interruptedHandlerGraceMs);
    timer.unref();
    try {
        return await Promise.race([didSettle(), timeout.promise]);
    } finally {
        clearTimeout(timer);
    }
}

function isStaleScheduledRunError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "statusCode" in error &&
        (error as { statusCode?: unknown }).statusCode === 409
    );
}

function runDueJobs(): void {
    const dueAt = nowIso();
    const rows = database
        .prepare(
            `SELECT id FROM scheduled_jobs
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at, id`
        )
        .all(dueAt) as Array<{ id: string }>;
    for (const row of rows) {
        try {
            enqueueScheduledJob(row.id, "schedule");
        } catch (error) {
            if (!isStaleScheduledRunError(error)) {
                scheduledJobRuntimeState.schedulerQueueFailures += 1;
                logger.warn("scheduled_jobs.due_job_queue_failed", { error });
            }
            // Keep later due jobs queueing even if a persisted row is stale.
        }
    }
}

async function observeClaimedExecution(
    execution: JobExecutionRecord,
    controller: AbortController
): Promise<void> {
    try {
        await runWithLogContext({ jobId: execution.id }, () =>
            executeClaimedJobExecution(
                execution,
                scheduledJobRuntimeState.workerId,
                controller.signal
            )
        );
    } catch (error) {
        logger.warn("scheduled_jobs.queued_execution_failed", {
            error,
            executionId: execution.id,
        });
    } finally {
        activeExecutionControllers.delete(execution.id);
        activeExecutionRuns.delete(execution.id);
        queueMicrotask(executorTick);
    }
}

function pauseExecutorClaims(): () => void {
    const generation = ++scheduledJobRuntimeState.executorClaimPauseGeneration;
    scheduledJobRuntimeState.isExecutorClaimingPaused = true;
    let isResumed = false;
    return () => {
        if (isResumed) return;
        isResumed = true;
        if (scheduledJobRuntimeState.executorClaimPauseGeneration !== generation) {
            return;
        }
        scheduledJobRuntimeState.isExecutorClaimingPaused = false;
        queueMicrotask(executorTick);
    };
}

function resetExecutorClaimPause(): void {
    scheduledJobRuntimeState.executorClaimPauseGeneration += 1;
    scheduledJobRuntimeState.isExecutorClaimingPaused = false;
    scheduledJobRuntimeState.missingCutoverRecoveryWarningKey = undefined;
    scheduledJobRuntimeState.nextDeploymentCutoverReconcileAt = 0;
}

type SystemdUnitState = DeploymentGuardianState | "missing";

function readSystemdUnitState(unit: string): SystemdUnitState {
    const result = Bun.spawnSync({
        cmd: [
            "systemctl",
            "--user",
            "show",
            unit,
            "--property=ActiveState",
            "--property=LoadState",
            "--no-pager",
        ],
        env: process.env,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (result.exitCode !== 0) {
        logger.warn("scheduled_jobs.systemd_unit_inspection_failed", {
            exitCode: result.exitCode,
            stderr,
            unit,
        });
        return "unknown";
    }
    if (stderr) {
        logger.warn("scheduled_jobs.systemd_unit_diagnostics", {
            stderr,
            unit,
        });
    }
    const properties = new Map(
        new TextDecoder()
            .decode(result.stdout)
            .trim()
            .split("\n")
            .map((line) => {
                const separator = line.indexOf("=");
                return separator === -1
                    ? [line, ""]
                    : [line.slice(0, separator), line.slice(separator + 1)];
            })
    );
    if (properties.get("LoadState") === "not-found") {
        return "missing";
    }
    if (properties.get("LoadState") !== "loaded") {
        return "unknown";
    }
    const state = properties.get("ActiveState");
    if (state && ["active", "activating", "deactivating", "reloading"].includes(state)) {
        return "active";
    }
    if (state && ["inactive", "failed"].includes(state)) {
        return "inactive";
    }
    return "unknown";
}

function readDeploymentGuardianState(jobId: string): DeploymentGuardianState {
    const guardian = readSystemdUnitState(
        `${DEPLOYMENT_GUARDIAN_UNIT_PREFIX}${jobId}.service`
    );
    if (guardian === "active") {
        return "active";
    }
    const recovery = readSystemdUnitState(
        `${DEPLOYMENT_RECOVERY_UNIT_PREFIX}${jobId}.service`
    );
    if (recovery === "active") {
        return "active";
    }
    if (guardian === "unknown" || recovery === "unknown") {
        return "unknown";
    }
    return "inactive";
}

function isDeploymentCutoverReconciliationExpired(
    updatedAt: string,
    timestamp: string
): boolean {
    const updatedAtMs = Date.parse(updatedAt);
    const timestampMs = Date.parse(timestamp);
    return (
        !Number.isFinite(updatedAtMs) ||
        !Number.isFinite(timestampMs) ||
        timestampMs - updatedAtMs >= deploymentCutoverMaximumUnknownMs
    );
}

function didTerminalizeUnrecoverableDeploymentCutover(
    cutover: OrphanedDeploymentCutover,
    timestamp: string
): boolean {
    const terminalize = database.transaction(() => {
        const result = database
            .prepare(
                `UPDATE deployment_jobs
                 SET status = 'failed',
                     updated_at = ?,
                     note = ?
                 WHERE id = ?
                   AND status = 'verifying'`
            )
            .run(
                timestamp,
                "Interrupted deployment cutover cannot be recovered because it lacks a persisted full candidate SHA",
                cutover.id
            );
        if (result.changes === 0) {
            return false;
        }
        database
            .prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?")
            .run(cutover.id);
        return true;
    });
    const didTerminalize = terminalize();
    if (didTerminalize) {
        logger.warn("scheduled_jobs.deployment_cutover_terminalized", {
            candidateCommit: cutover.candidateCommit,
            cutoverId: cutover.id,
        });
    }
    return didTerminalize;
}

export function reconcileOrphanedDeploymentCutovers(
    timestamp = nowIso(),
    readGuardianState: DeploymentGuardianStateReader = readDeploymentGuardianState,
    ...recoveryHandlerOverride: [
        recoverCutover?: DeploymentCutoverRecoveryHandler | undefined,
    ]
): number {
    const recoverCutover =
        recoveryHandlerOverride.length === 0
            ? scheduledJobRuntimeState.deploymentCutoverRecoveryHandler
            : recoveryHandlerOverride[0];
    const pendingRows = database
        .query(
            `SELECT id, commit_sha AS candidateCommit, updated_at AS updatedAt
             FROM deployment_jobs
             WHERE status = 'verifying'`
        )
        .all() as Array<{
        candidateCommit: string | null;
        id: string;
        updatedAt: string;
    }>;
    const pending: OrphanedDeploymentCutover[] = pendingRows.map((row) => ({
        ...(row.candidateCommit && { candidateCommit: row.candidateCommit }),
        id: row.id,
        updatedAt: row.updatedAt,
    }));
    let reconciled = 0;
    const cutoversMissingRecoveryHandler: string[] = [];
    for (const cutover of pending) {
        let state: DeploymentGuardianState = "unknown";
        try {
            state = readGuardianState(cutover.id);
        } catch (error) {
            logger.warn("scheduled_jobs.deployment_guardian_inspection_failed", {
                cutoverId: cutover.id,
                error,
            });
        }
        const shouldRecover =
            state === "inactive" ||
            (state === "unknown" &&
                isDeploymentCutoverReconciliationExpired(cutover.updatedAt, timestamp));
        if (!shouldRecover) {
            continue;
        }
        if (
            !cutover.candidateCommit ||
            !FULL_RELEASE_COMMIT_PATTERN.test(cutover.candidateCommit)
        ) {
            if (didTerminalizeUnrecoverableDeploymentCutover(cutover, timestamp)) {
                reconciled += 1;
            }
            continue;
        }
        if (!recoverCutover) {
            cutoversMissingRecoveryHandler.push(cutover.id);
            continue;
        }
        try {
            if (recoverCutover(cutover)) {
                reconciled += 1;
            }
        } catch (error) {
            logger.warn("scheduled_jobs.orphaned_deployment_rollback_failed", {
                cutoverId: cutover.id,
                error,
            });
        }
    }
    const sortedMissingHandlerIds = cutoversMissingRecoveryHandler.toSorted(
        (left, right) => left.localeCompare(right)
    );
    const warningKey = sortedMissingHandlerIds.join(",");
    if (
        warningKey &&
        scheduledJobRuntimeState.missingCutoverRecoveryWarningKey !== warningKey
    ) {
        logger.warn("scheduled_jobs.deployment_recovery_handler_missing", {
            cutoverIds: sortedMissingHandlerIds,
        });
    }
    scheduledJobRuntimeState.missingCutoverRecoveryWarningKey = warningKey || undefined;
    return reconciled;
}

/** Registers the detached rollback scheduler used for orphaned release cutovers. */
export function registerDeploymentCutoverRecoveryHandler(
    didScheduleRecovery: DeploymentCutoverRecoveryHandler
): void {
    scheduledJobRuntimeState.deploymentCutoverRecoveryHandler = didScheduleRecovery;
    scheduledJobRuntimeState.missingCutoverRecoveryWarningKey = undefined;
}

function hasPendingDeploymentCutover(): boolean {
    const now = Date.now();
    if (now >= scheduledJobRuntimeState.nextDeploymentCutoverReconcileAt) {
        scheduledJobRuntimeState.nextDeploymentCutoverReconcileAt =
            now + deploymentCutoverReconcileIntervalMs;
        const reconciled = reconcileOrphanedDeploymentCutovers();
        if (reconciled > 0) {
            logger.warn("scheduled_jobs.deployment_cutovers_reconciled", {
                reconciled,
            });
        }
    }
    return Boolean(
        database
            .query(
                `SELECT 1
                 FROM deployment_jobs
                 WHERE status = 'verifying'
                 LIMIT 1`
            )
            .get()
    );
}

function executorTick(): void {
    if (
        !scheduledJobRuntimeState.executor ||
        scheduledJobRuntimeState.isExecutorClaimingPaused ||
        scheduledJobRuntimeState.isExecutorTickRunning ||
        activeExecutionRuns.size >= executorCapacity
    ) {
        return;
    }
    scheduledJobRuntimeState.isExecutorTickRunning = true;
    try {
        // The in-memory pause is lost when the deployment restarts this worker.
        // Keep replacement workers idle until the detached guardian records a
        // terminal deployment status in the shared database.
        if (hasPendingDeploymentCutover()) {
            return;
        }
        const execution = claimNextJobExecution(
            scheduledJobRuntimeState.workerId,
            executorCapacity
        );
        if (!execution) return;
        const controller = new AbortController();
        activeExecutionControllers.set(execution.id, controller);
        const run = observeClaimedExecution(execution, controller);
        activeExecutionRuns.set(execution.id, run);
    } catch (error) {
        logger.warn("scheduled_jobs.executor_tick_failed", { error });
    } finally {
        scheduledJobRuntimeState.isExecutorTickRunning = false;
    }
}

function scheduleTick(): void {
    if (scheduledJobRuntimeState.isSchedulerTickRunning) {
        return;
    }
    scheduledJobRuntimeState.isSchedulerTickRunning = true;
    scheduledJobRuntimeState.schedulerTicks += 1;
    scheduledJobRuntimeState.lastSchedulerTickAt = nowIso();
    const startedAt = performance.now();
    try {
        runDueJobs();
    } catch (error) {
        scheduledJobRuntimeState.schedulerTickFailures += 1;
        logger.warn("scheduled_jobs.scheduler_tick_failed", { error });
    } finally {
        scheduledJobRuntimeState.lastSchedulerTickDurationMs =
            Math.round(Math.max(0, performance.now() - startedAt) * 100) / 100;
        scheduledJobRuntimeState.isSchedulerTickRunning = false;
    }
}

/**
 * Returns queue, worker, and due-schedule telemetry without job payloads.
 * @param timestamp Timestamp value.
 * @returns queue, worker, and due-schedule telemetry without job payloads.
 */
export function getScheduledJobSchedulerMetrics(
    timestamp = Date.now()
): SchedulerMetrics {
    const dueAt = new Date(timestamp).toISOString();
    let due: {
        count: number | null | undefined;
        oldest_due_at: string | null | undefined;
    } = { count: 0, oldest_due_at: undefined };
    let queue: ReturnType<typeof getJobExecutionSummary> = {
        activeResourceClasses: [],
        oldestQueuedAgeMs: undefined,
        oldestQueuedAt: undefined,
        queued: 0,
        running: 0,
        workerCapacity: 0,
        workerCount: 0,
        workerLastHeartbeatAt: undefined,
        workerOnline: false,
    };
    try {
        due = database
            .prepare(
                `SELECT COUNT(*) AS count, MIN(next_run_at) AS oldest_due_at
                 FROM scheduled_jobs
                 WHERE enabled = 1
                   AND next_run_at IS NOT NULL
                   AND next_run_at <= ?`
            )
            .get(dueAt) as typeof due;
        queue = getJobExecutionSummary(timestamp);
    } catch {
        // Diagnostics must remain available while readiness reports a database fault.
    }
    const oldestDueAt = due.oldest_due_at ?? undefined;
    const parsedOldestDueAt = oldestDueAt ? Date.parse(oldestDueAt) : Number.NaN;
    return {
        ...queue,
        dueJobs: Number(due.count ?? 0),
        executorActive: scheduledJobRuntimeState.executor !== undefined,
        executorTickRunning: scheduledJobRuntimeState.isExecutorTickRunning,
        lastTickAt: scheduledJobRuntimeState.lastSchedulerTickAt,
        lastTickDurationMs: scheduledJobRuntimeState.lastSchedulerTickDurationMs,
        oldestDueAt,
        queueFailures: scheduledJobRuntimeState.schedulerQueueFailures,
        scheduleLagMs: Number.isFinite(parsedOldestDueAt)
            ? Math.max(0, timestamp - parsedOldestDueAt)
            : 0,
        schedulerActive: scheduledJobRuntimeState.scheduler !== undefined,
        schedulerTickRunning: scheduledJobRuntimeState.isSchedulerTickRunning,
        tickFailures: scheduledJobRuntimeState.schedulerTickFailures,
        ticks: scheduledJobRuntimeState.schedulerTicks,
    };
}

export function startScheduledJobScheduler(): void {
    if (scheduledJobRuntimeState.scheduler) {
        return;
    }
    scheduledJobRuntimeState.scheduler = setInterval(scheduleTick, schedulerTickMs);
    scheduledJobRuntimeState.scheduler.unref();
    scheduleTick();
}

function workerIdForRelease(releaseCommit: string): string {
    if (!RELEASE_COMMIT_PATTERN.test(releaseCommit)) {
        throw new Error("Job worker release commit must be an 8-40 character SHA");
    }
    return `dashboard-worker:${releaseCommit}:${process.pid}:${Bun.randomUUIDv7()}`;
}

export function startScheduledJobExecutor(releaseCommit = "development"): void {
    if (scheduledJobRuntimeState.executor) return;
    scheduledJobRuntimeState.workerId = workerIdForRelease(releaseCommit);
    resetExecutorClaimPause();
    const timestamp = nowIso();
    const recoveredOrphanedRuns = recoverOrphanedScheduledJobRuns(timestamp);
    if (recoveredOrphanedRuns > 0) {
        logger.warn("scheduled_jobs.orphaned_runs_recovered", {
            recovered: recoveredOrphanedRuns,
        });
    }
    const recovered = recoverExpiredJobExecutions(timestamp);
    if (recovered > 0) {
        logger.warn("scheduled_jobs.expired_execution_leases_recovered", {
            recovered,
        });
    }
    registerJobWorker(scheduledJobRuntimeState.workerId, executorCapacity);
    scheduledJobRuntimeState.workerHeartbeat = setInterval(() => {
        try {
            didHeartbeatJobWorker(scheduledJobRuntimeState.workerId);
        } catch (error) {
            logger.warn("scheduled_jobs.worker_heartbeat_failed", { error });
        }
    }, executorHeartbeatMs);
    scheduledJobRuntimeState.workerHeartbeat.unref();
    scheduledJobRuntimeState.executor = setInterval(executorTick, executorTickMs);
    scheduledJobRuntimeState.executor.unref();
    executorTick();
}

export function recoverOrphanedScheduledJobRuns(timestamp = nowIso()): number {
    return database
        .prepare(
            `UPDATE scheduled_job_runs
             SET status = 'failed', finished_at = ?,
                 message = 'Scheduled job interrupted before worker lease recovery'
             WHERE status = 'running'
               AND NOT EXISTS (
                   SELECT 1
                   FROM job_executions
                   WHERE scheduled_run_id = scheduled_job_runs.id
                     AND status IN ('queued', 'running')
               )`
        )
        .run(timestamp).changes;
}

export function stopScheduledJobScheduler(): void {
    if (!scheduledJobRuntimeState.scheduler) {
        return;
    }
    clearInterval(scheduledJobRuntimeState.scheduler);
    scheduledJobRuntimeState.scheduler = undefined;
}

export async function stopScheduledJobExecutor(): Promise<void> {
    if (scheduledJobRuntimeState.executor) {
        clearInterval(scheduledJobRuntimeState.executor);
        scheduledJobRuntimeState.executor = undefined;
    }
    if (scheduledJobRuntimeState.workerHeartbeat) {
        clearInterval(scheduledJobRuntimeState.workerHeartbeat);
        scheduledJobRuntimeState.workerHeartbeat = undefined;
    }
    for (const controller of activeExecutionControllers.values()) {
        controller.abort();
    }
    await Promise.allSettled(activeExecutionRuns.values());
    activeExecutionControllers.clear();
    activeExecutionRuns.clear();
    unregisterJobWorker(scheduledJobRuntimeState.workerId);
    resetExecutorClaimPause();
}
