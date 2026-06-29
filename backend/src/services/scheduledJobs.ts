import { database, sqlNullable } from "../database.ts";
import { errorMessage } from "../lib/errors.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const schedulerTickMs = 30_000;
const defaultScheduledJobRunTimeoutMs = 5 * 60 * 1000;
const minimumIntervalSeconds = 60;
const latestRunsJobIdChunkSize = 900;
const runningJobs = new Set<string>();
const scheduledJobRuns = new Set<Promise<void>>();
const actionHandlers = new Map<string, ScheduledJobActionRegistration>();
const abortHandlerSettled = new WeakMap<ScheduledJobAbortError, Promise<unknown>>();

const scheduledJobRuntimeState: {
    scheduler: NodeJS.Timeout | undefined;
    isSchedulerTickRunning: boolean;
} = {
    scheduler: undefined,
    isSchedulerTickRunning: false,
};
const scheduledJobRunTimeoutMs = defaultScheduledJobRunTimeoutMs;

export type ScheduledJobScheduleType = "interval" | "daily" | "cron";
export type ScheduledJobRunStatus = "running" | "success" | "failed";
export type ScheduledJobTriggerType = "manual" | "schedule";
export type ScheduledJobActionHandler = (
    job: ScheduledJob,
    signal?: AbortSignal
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface ScheduledJobActionOptions {
    timeoutMs?: number;
}

interface ScheduledJobActionRegistration {
    handler: ScheduledJobActionHandler;
    timeoutMs?: number;
}

class ScheduledJobAbortError extends Error {
    constructor(handlerSettled: Promise<unknown>) {
        super("Scheduled job aborted");
        abortHandlerSettled.set(this, handlerSettled);
    }

    getHandlerSettled(): Promise<unknown> {
        return abortHandlerSettled.get(this)!;
    }
}

export interface ScheduledJob {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    scheduleType: ScheduledJobScheduleType;
    intervalSeconds: number;
    timeOfDay: string | undefined;
    cronExpression: string | undefined;
    actionKey: string;
    actionPayload: Record<string, unknown>;
    nextRunAt: string | undefined;
    createdAt: string;
    updatedAt: string;
    lastRun: ScheduledJobRun | undefined;
    isRunning: boolean;
}

export interface ScheduledJobRun {
    id: number;
    jobId: string;
    status: ScheduledJobRunStatus;
    triggerType: ScheduledJobTriggerType;
    startedAt: string;
    finishedAt: string | undefined;
    message: string | undefined;
    output: Record<string, unknown>;
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
}

export interface ScheduledJobPatch {
    enabled?: boolean;
    scheduleType?: ScheduledJobScheduleType;
    intervalSeconds?: number;
    timeOfDay?: string | null | undefined;
    cronExpression?: string | null | undefined;
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
    next_run_at: string | null | undefined;
    created_at: string;
    updated_at: string;
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
    return {
        id: row.id,
        jobId: row.job_id,
        status: row.status as ScheduledJobRunStatus,
        triggerType: row.trigger_type as ScheduledJobTriggerType,
        startedAt: row.started_at,
        finishedAt: fromSqlNullable(row.finished_at),
        message: fromSqlNullable(row.message),
        output: parseJsonObject(row.output_json),
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
                         ROW_NUMBER() OVER (
                             PARTITION BY run.job_id
                             ORDER BY run.started_at DESC, run.id DESC
                         ) AS row_number
                     FROM scheduled_job_runs run
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
        nextRunAt: fromSqlNullable(row.next_run_at),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastRun: latestRuns.get(row.id) ?? undefined,
        isRunning: runningJobs.has(row.id),
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
    return getScheduledJob(definition.id) as ScheduledJob;
}

export function listScheduledJobs(): ScheduledJob[] {
    const rows = database
        .prepare("SELECT * FROM scheduled_jobs ORDER BY name COLLATE NOCASE, id")
        .all() as unknown as ScheduledJobRow[];
    const latestRuns = latestRunsByJobId(rows.map((row) => row.id));
    return rows.map((row) => mapJob(row, latestRuns));
}

export function getScheduledJob(id: string): ScheduledJob | undefined {
    const row = database.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as
        ScheduledJobRow | undefined;
    return row ? mapJob(row) : undefined;
}

export function listScheduledJobRuns(id: string, limit = 20): ScheduledJobRun[] {
    assertValidId(id);
    const normalizedLimit =
        Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    return (
        database
            .prepare(
                `SELECT *
                 FROM scheduled_job_runs
                 WHERE job_id = ?
                 ORDER BY started_at DESC, id DESC
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
             next_run_at = ?, updated_at = ?
         WHERE id = ?`
        )
        .run(
            next.enabled ? 1 : 0,
            next.scheduleType,
            next.intervalSeconds,
            sqlNullable(next.timeOfDay),
            sqlNullable(next.cronExpression),
            sqlNullable(nextRunAt),
            timestamp,
            id
        );
    return getScheduledJob(id);
}

function createRun(jobId: string, triggerType: ScheduledJobTriggerType): ScheduledJobRun {
    const startedAt = nowIso();
    const result = database
        .prepare(
            `INSERT INTO scheduled_job_runs (
                job_id, status, trigger_type, started_at, output_json
            ) VALUES (?, 'running', ?, ?, '{}')`
        )
        .run(jobId, triggerType, startedAt);
    return {
        id: Number(result.lastInsertRowid),
        jobId,
        status: "running",
        triggerType,
        startedAt,
        finishedAt: undefined,
        message: undefined,
        output: {},
    };
}

function finishRun(
    run: ScheduledJobRun,
    status: Exclude<ScheduledJobRunStatus, "running">,
    message: string | undefined,
    output: Record<string, unknown>
): ScheduledJobRun {
    const finishedAt = nowIso();
    database
        .prepare(
            `UPDATE scheduled_job_runs
         SET status = ?, finished_at = ?, message = ?, output_json = ?
         WHERE id = ?`
        )
        .run(status, finishedAt, sqlNullable(message), JSON.stringify(output), run.id);
    return { ...run, status, finishedAt, message, output };
}

function claimScheduledRun(job: ScheduledJob): ScheduledJobRun | undefined {
    const currentJob = getScheduledJob(job.id);
    const dueAt = nowIso();
    if (!currentJob?.enabled || !currentJob.nextRunAt || currentJob.nextRunAt > dueAt) {
        return undefined;
    }
    const nextRunAt = calculateNextRunAt(currentJob);
    const startedAt = nowIso();
    try {
        database.run("BEGIN IMMEDIATE");
        const updateResult = database
            .prepare(
                `UPDATE scheduled_jobs
                 SET next_run_at = ?, updated_at = ?
                 WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`
            )
            .run(sqlNullable(nextRunAt), startedAt, currentJob.id, dueAt);
        if (updateResult.changes === 0) {
            database.run("ROLLBACK");
            return undefined;
        }
        const insertResult = database
            .prepare(
                `INSERT INTO scheduled_job_runs (
                    job_id, status, trigger_type, started_at, output_json
                ) VALUES (?, 'running', 'schedule', ?, '{}')`
            )
            .run(currentJob.id, startedAt);
        database.run("COMMIT");
        return {
            id: Number(insertResult.lastInsertRowid),
            jobId: currentJob.id,
            status: "running",
            triggerType: "schedule",
            startedAt,
            finishedAt: undefined,
            message: undefined,
            output: {},
        };
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Ignore rollback failures after SQLite has already unwound the transaction.
        }
        throw error;
    }
}

function markAbandonedRunningRuns(): void {
    try {
        database
            .prepare(
                `UPDATE scheduled_job_runs
             SET status = 'failed',
                 finished_at = COALESCE(finished_at, ?),
                 message = COALESCE(message, ?)
             WHERE status = 'running'`
            )
            .run(nowIso(), "Scheduled job abandoned after backend restart");
    } catch (error) {
        console.warn("[ScheduledJobs] Failed to mark abandoned scheduled runs:", error);
    }
}

function persistedRunFallback(
    run: ScheduledJobRun,
    status: Exclude<ScheduledJobRunStatus, "running">,
    message: string | undefined,
    output: Record<string, unknown>
): ScheduledJobRun {
    return { ...run, status, finishedAt: nowIso(), message, output };
}

function finishRunOrReport(
    run: ScheduledJobRun,
    status: Exclude<ScheduledJobRunStatus, "running">,
    message: string | undefined,
    output: Record<string, unknown>
): ScheduledJobRun {
    try {
        return finishRun(run, status, message, output);
    } catch (error) {
        console.warn(
            `[ScheduledJobs] Failed to persist ${status} scheduled job run:`,
            error
        );
        return persistedRunFallback(
            run,
            status,
            errorMessage(error, `Scheduled job ${status} persistence failed`),
            output
        );
    }
}

export function createManualScheduledJobRun(jobId: string): ScheduledJobRun {
    if (runningJobs.has(jobId)) {
        const error = new Error("Scheduled job is already running") as Error & {
            statusCode?: number;
        };
        error.statusCode = 409;
        throw error;
    }
    runningJobs.add(jobId);
    try {
        return createRun(jobId, "manual");
    } catch (error) {
        runningJobs.delete(jobId);
        throw error;
    }
}

export function finishScheduledJobRun(
    run: ScheduledJobRun,
    status: Exclude<ScheduledJobRunStatus, "running">,
    message: string | undefined,
    output: Record<string, unknown>
): ScheduledJobRun {
    try {
        return finishRunOrReport(run, status, message, output);
    } finally {
        runningJobs.delete(run.jobId);
    }
}

export async function runScheduledJob(
    id: string,
    triggerType: ScheduledJobTriggerType = "manual",
    signal?: AbortSignal
): Promise<ScheduledJobRun> {
    const job = getScheduledJob(id);
    if (!job) {
        const error = new Error("Scheduled job not found") as Error & {
            statusCode?: number;
        };
        error.statusCode = 404;
        throw error;
    }
    if (runningJobs.has(id)) {
        const error = new Error("Scheduled job is already running") as Error & {
            statusCode?: number;
        };
        error.statusCode = 409;
        throw error;
    }
    const action = actionHandlers.get(job.actionKey);
    if (!action && triggerType === "manual") {
        throw new ScheduledJobValidationError(
            `No scheduled job action registered for ${job.actionKey}`
        );
    }
    const timeoutMs = action?.timeoutMs ?? scheduledJobRunTimeoutMs;

    const run =
        triggerType === "schedule" ? claimScheduledRun(job) : createRun(id, triggerType);
    if (!run) {
        const error = new Error("Scheduled job is no longer due") as Error & {
            statusCode?: number;
        };
        error.statusCode = 409;
        throw error;
    }
    runningJobs.add(id);
    try {
        let output: Record<string, unknown>;
        try {
            if (!action) {
                throw new ScheduledJobValidationError(
                    `No scheduled job action registered for ${job.actionKey}`
                );
            }
            output = await runActionWithTimeout(timeoutMs, action, job, signal);
        } catch (error) {
            if (error instanceof ScheduledJobAbortError) {
                await error.getHandlerSettled();
            }
            return finishRunOrReport(
                run,
                "failed",
                errorMessage(error, "Scheduled job failed"),
                {}
            );
        }
        return finishRunOrReport(run, "success", undefined, output);
    } finally {
        runningJobs.delete(id);
    }
}

async function runActionWithTimeout(
    timeoutMs: number,
    action: ScheduledJobActionRegistration,
    job: ScheduledJob,
    signal?: AbortSignal
): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
        throw new Error("Scheduled job aborted");
    }
    const controller = new AbortController();
    const abortPromise = Promise.withResolvers<never>();
    let handlerSettled: Promise<unknown> = Promise.resolve();
    const abortFromSignal = () => {
        controller.abort();
        abortPromise.reject(new ScheduledJobAbortError(handlerSettled));
    };
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    let isTimedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                isTimedOut = true;
                controller.abort();
                console.warn("[ScheduledJobs] Scheduled job exceeded timeout", {
                    timeoutMs,
                });
                reject(new Error("Scheduled job timed out"));
            }, timeoutMs);
        });
        timeout?.unref();
        const handlerPromise = Promise.resolve(action.handler(job, controller.signal));
        handlerSettled = suppressHandlerPromiseRejection(handlerPromise);
        void suppressHandlerPromiseRejection(handlerPromise);
        const output =
            (await Promise.race([
                handlerPromise,
                timeoutPromise,
                abortPromise.promise,
            ])) ?? {};
        return output;
    } catch (error) {
        if (isTimedOut) {
            throw new Error("Scheduled job timed out", { cause: error });
        }
        throw error;
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        signal?.removeEventListener("abort", abortFromSignal);
    }
}

function trackScheduledRun(run: Promise<void>): void {
    scheduledJobRuns.add(run);
    void untrackScheduledRun(run);
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

async function untrackScheduledRun(run: Promise<void>): Promise<void> {
    try {
        await run;
    } finally {
        scheduledJobRuns.delete(run);
    }
}

function isStaleScheduledRunError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "statusCode" in error &&
        (error as { statusCode?: unknown }).statusCode === 409
    );
}

async function observeScheduledRun(id: string): Promise<void> {
    try {
        await runScheduledJob(id, "schedule");
    } catch (error) {
        if (!isStaleScheduledRunError(error)) {
            console.warn("[ScheduledJobs] Scheduled run failed unexpectedly:", error);
        }
    }
}

async function runDueJobs(): Promise<void> {
    const dueAt = nowIso();
    const rows = database
        .prepare(
            `SELECT id FROM scheduled_jobs
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at, id`
        )
        .all(dueAt) as Array<{ id: string }>;
    for (const row of rows) {
        if (!runningJobs.has(row.id)) {
            try {
                const currentJob = getScheduledJob(row.id);
                if (
                    !currentJob?.enabled ||
                    !currentJob.nextRunAt ||
                    currentJob.nextRunAt > nowIso()
                ) {
                    continue;
                }
                const run = observeScheduledRun(row.id);
                trackScheduledRun(run);
            } catch (error) {
                console.warn(
                    "[ScheduledJobs] Failed to inspect due scheduled job:",
                    error
                );
                // Keep later due jobs running even if a persisted row is stale.
            }
        }
    }
}

function scheduleTick(): void {
    if (scheduledJobRuntimeState.isSchedulerTickRunning) {
        return;
    }
    scheduledJobRuntimeState.isSchedulerTickRunning = true;
    void (async () => {
        try {
            await runDueJobs();
        } catch (error) {
            console.warn("[ScheduledJobs] Scheduler tick failed:", error);
        } finally {
            scheduledJobRuntimeState.isSchedulerTickRunning = false;
        }
    })();
}

export function startScheduledJobScheduler(): void {
    if (scheduledJobRuntimeState.scheduler) {
        return;
    }
    markAbandonedRunningRuns();
    scheduledJobRuntimeState.scheduler = setInterval(scheduleTick, schedulerTickMs);
    scheduledJobRuntimeState.scheduler.unref();
    scheduleTick();
}

export function stopScheduledJobScheduler(): void {
    if (!scheduledJobRuntimeState.scheduler) {
        return;
    }
    clearInterval(scheduledJobRuntimeState.scheduler);
    scheduledJobRuntimeState.scheduler = undefined;
}
