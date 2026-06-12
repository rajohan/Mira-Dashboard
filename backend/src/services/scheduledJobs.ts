import { db } from "../db.js";
import { errorMessage } from "../lib/errors.js";

const schedulerTickMs = 30_000;
const minimumIntervalSeconds = 60;
const latestRunsJobIdChunkSize = 900;
const runningJobs = new Set<string>();
const actionHandlers = new Map<string, ScheduledJobActionHandler>();

let scheduler: NodeJS.Timeout | null = null;
let schedulerTickRunning = false;

export type ScheduledJobScheduleType = "interval" | "daily" | "cron";
export type ScheduledJobRunStatus = "running" | "success" | "failed";
export type ScheduledJobTriggerType = "manual" | "schedule";
export type ScheduledJobActionHandler = (
    job: ScheduledJob
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface ScheduledJob {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    scheduleType: ScheduledJobScheduleType;
    intervalSeconds: number;
    timeOfDay: string | null;
    cronExpression: string | null;
    actionKey: string;
    actionPayload: Record<string, unknown>;
    nextRunAt: string | null;
    createdAt: string;
    updatedAt: string;
    lastRun: ScheduledJobRun | null;
    isRunning: boolean;
}

export interface ScheduledJobRun {
    id: number;
    jobId: string;
    status: ScheduledJobRunStatus;
    triggerType: ScheduledJobTriggerType;
    startedAt: string;
    finishedAt: string | null;
    message: string | null;
    output: Record<string, unknown>;
}

export interface ScheduledJobDefinition {
    id: string;
    name: string;
    description?: string;
    enabled?: boolean;
    scheduleType: ScheduledJobScheduleType;
    intervalSeconds?: number;
    timeOfDay?: string | null;
    cronExpression?: string | null;
    actionKey: string;
    actionPayload?: Record<string, unknown>;
}

export interface ScheduledJobPatch {
    enabled?: boolean;
    scheduleType?: ScheduledJobScheduleType;
    intervalSeconds?: number;
    timeOfDay?: string | null;
    cronExpression?: string | null;
}

interface ScheduledJobRow {
    id: string;
    name: string;
    description: string;
    enabled: number;
    schedule_type: string;
    interval_seconds: number;
    time_of_day: string | null;
    cron_expression: string | null;
    action_key: string;
    action_payload_json: string;
    next_run_at: string | null;
    created_at: string;
    updated_at: string;
}

interface ScheduledJobRunRow {
    id: number;
    job_id: string;
    status: string;
    trigger_type: string;
    started_at: string;
    finished_at: string | null;
    message: string | null;
    output_json: string;
}

export class ScheduledJobValidationError extends Error {
    statusCode = 400;

    constructor(message: string) {
        super(message);
        this.name = "ScheduledJobValidationError";
    }
}

export function isScheduledJobValidationError(
    error: unknown
): error is ScheduledJobValidationError {
    return error instanceof ScheduledJobValidationError;
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
    timeOfDay: string | null,
    cronExpression: string | null
): void {
    if (scheduleType === "interval") {
        if (
            !Number.isInteger(intervalSeconds) ||
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
): Set<number> | null {
    const values = new Set<number>();
    for (const part of field.split(",")) {
        if (!part) {
            return null;
        }
        const stepPieces = part.split("/");
        if (stepPieces.length > 2) {
            return null;
        }
        const [rangePart = "", stepPart] = stepPieces;
        const step = stepPart === undefined ? 1 : Number(stepPart);
        if (!Number.isInteger(step) || step < 1) {
            return null;
        }
        const rangePieces = rangePart.split("-");
        if (rangePieces.length > 2) {
            return null;
        }
        const [start, end] =
            rangePart === "*"
                ? [minimum, maximum]
                : rangePart.includes("-")
                  ? rangePieces.map(Number)
                  : [
                        Number(rangePart),
                        stepPart === undefined ? Number(rangePart) : maximum,
                    ];
        if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < minimum ||
            end > maximum ||
            start > end
        ) {
            return null;
        }
        for (let value = start; value <= end; value += step) {
            values.add(value);
        }
    }
    return values;
}

function parseCronExpression(expression: string): {
    minutes: Set<number>;
    hours: Set<number>;
    daysOfMonth: Set<number>;
    months: Set<number>;
    daysOfWeek: Set<number>;
    dayOfMonthWildcard: boolean;
    dayOfWeekWildcard: boolean;
} | null {
    const fields = expression.trim().split(/\s+/u);
    if (fields.length !== 5) {
        return null;
    }
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    const minutes = parseCronField(minute, 0, 59);
    const hours = parseCronField(hour, 0, 23);
    const daysOfMonth = parseCronField(dayOfMonth, 1, 31);
    const months = parseCronField(month, 1, 12);
    const daysOfWeek = parseCronField(dayOfWeek, 0, 7);
    if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
        return null;
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
        dayOfMonthWildcard: dayOfMonth === "*",
        dayOfWeekWildcard: dayOfWeek === "*",
    };
}

function cronDayMatches(
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
            cronDayMatches(cron, next)
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
): string | null {
    if (!job.enabled) {
        return null;
    }
    if (job.scheduleType === "daily" && job.timeOfDay) {
        return nextDailyRun(from, job.timeOfDay).toISOString();
    }
    if (job.scheduleType === "cron" && job.cronExpression) {
        return nextCronRun(from, job.cronExpression).toISOString();
    }
    return new Date(from.getTime() + job.intervalSeconds * 1000).toISOString();
}

function mapRun(row: ScheduledJobRunRow | undefined): ScheduledJobRun | null {
    if (!row) {
        return null;
    }
    return {
        id: row.id,
        jobId: row.job_id,
        status: row.status as ScheduledJobRunStatus,
        triggerType: row.trigger_type as ScheduledJobTriggerType,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        message: row.message,
        output: parseJsonObject(row.output_json),
    };
}

function latestRunsByJobId(jobIds: string[]): Map<string, ScheduledJobRun> {
    if (jobIds.length === 0) {
        return new Map();
    }
    const runs = new Map<string, ScheduledJobRun>();
    for (let index = 0; index < jobIds.length; index += latestRunsJobIdChunkSize) {
        const chunk = jobIds.slice(index, index + latestRunsJobIdChunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db
            .prepare(
                `SELECT run.*
                 FROM scheduled_job_runs run
                 WHERE run.job_id IN (${placeholders})
                   AND NOT EXISTS (
                       SELECT 1
                       FROM scheduled_job_runs newer
                       WHERE newer.job_id = run.job_id
                         AND (
                             newer.started_at > run.started_at
                             OR (newer.started_at = run.started_at AND newer.id > run.id)
                         )
                   )
                 ORDER BY run.job_id, run.started_at DESC, run.id DESC`
            )
            .all(...chunk) as unknown as ScheduledJobRunRow[];
        for (const row of rows) {
            if (!runs.has(row.job_id)) {
                const run = mapRun(row);
                if (run) {
                    runs.set(row.job_id, run);
                }
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
        timeOfDay: row.time_of_day,
        cronExpression: row.cron_expression,
        actionKey: row.action_key,
        actionPayload: parseJsonObject(row.action_payload_json),
        nextRunAt: row.next_run_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastRun: latestRuns.get(row.id) ?? null,
        isRunning: runningJobs.has(row.id),
    };
}

export function registerScheduledJobAction(
    actionKey: string,
    handler: ScheduledJobActionHandler
): void {
    assertValidActionKey(actionKey);
    actionHandlers.set(actionKey, handler);
}

export function upsertScheduledJob(definition: ScheduledJobDefinition): ScheduledJob {
    assertValidId(definition.id);
    assertValidActionKey(definition.actionKey);
    const existing = getScheduledJob(definition.id);
    const enabled = existing?.enabled ?? definition.enabled ?? false;
    const scheduleType = existing?.scheduleType ?? definition.scheduleType;
    const intervalSeconds =
        existing?.intervalSeconds ?? definition.intervalSeconds ?? 3600;
    const timeOfDay = existing?.timeOfDay ?? definition.timeOfDay ?? null;
    const cronExpression = existing?.cronExpression ?? definition.cronExpression ?? null;
    assertValidSchedule(scheduleType, intervalSeconds, timeOfDay, cronExpression);

    const timestamp = nowIso();
    const scheduleChanged =
        !existing ||
        existing.enabled !== enabled ||
        existing.scheduleType !== scheduleType ||
        existing.intervalSeconds !== intervalSeconds ||
        existing.timeOfDay !== timeOfDay ||
        existing.cronExpression !== cronExpression;
    const nextRunAt = scheduleChanged
        ? calculateNextRunAt(
              { cronExpression, enabled, intervalSeconds, scheduleType, timeOfDay },
              new Date(timestamp)
          )
        : existing.nextRunAt;
    db.prepare(
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
    ).run(
        definition.id,
        definition.name,
        definition.description ?? "",
        enabled ? 1 : 0,
        scheduleType,
        intervalSeconds,
        timeOfDay,
        cronExpression,
        definition.actionKey,
        JSON.stringify(definition.actionPayload ?? {}),
        nextRunAt,
        existing?.createdAt ?? timestamp,
        timestamp
    );
    return getScheduledJob(definition.id) as ScheduledJob;
}

export function listScheduledJobs(): ScheduledJob[] {
    const rows = db
        .prepare("SELECT * FROM scheduled_jobs ORDER BY name COLLATE NOCASE, id")
        .all() as unknown as ScheduledJobRow[];
    const latestRuns = latestRunsByJobId(rows.map((row) => row.id));
    return rows.map((row) => mapJob(row, latestRuns));
}

export function getScheduledJob(id: string): ScheduledJob | null {
    const row = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as
        | ScheduledJobRow
        | undefined;
    return row ? mapJob(row) : null;
}

export function updateScheduledJob(
    id: string,
    patch: ScheduledJobPatch
): ScheduledJob | null {
    const existing = getScheduledJob(id);
    if (!existing) {
        return null;
    }
    const next = {
        enabled: patch.enabled ?? existing.enabled,
        scheduleType: patch.scheduleType ?? existing.scheduleType,
        intervalSeconds: patch.intervalSeconds ?? existing.intervalSeconds,
        timeOfDay: patch.timeOfDay === undefined ? existing.timeOfDay : patch.timeOfDay,
        cronExpression:
            patch.cronExpression === undefined
                ? existing.cronExpression
                : patch.cronExpression,
    };
    assertValidSchedule(
        next.scheduleType,
        next.intervalSeconds,
        next.timeOfDay,
        next.cronExpression
    );
    const timestamp = nowIso();
    const scheduleChanged =
        existing.enabled !== next.enabled ||
        existing.scheduleType !== next.scheduleType ||
        existing.intervalSeconds !== next.intervalSeconds ||
        existing.timeOfDay !== next.timeOfDay ||
        existing.cronExpression !== next.cronExpression;
    const nextRunAt = scheduleChanged
        ? calculateNextRunAt(next, new Date(timestamp))
        : existing.nextRunAt;
    db.prepare(
        `UPDATE scheduled_jobs
         SET enabled = ?, schedule_type = ?, interval_seconds = ?, time_of_day = ?, cron_expression = ?,
             next_run_at = ?, updated_at = ?
         WHERE id = ?`
    ).run(
        next.enabled ? 1 : 0,
        next.scheduleType,
        next.intervalSeconds,
        next.timeOfDay,
        next.cronExpression,
        nextRunAt,
        timestamp,
        id
    );
    return getScheduledJob(id);
}

function createRun(jobId: string, triggerType: ScheduledJobTriggerType): ScheduledJobRun {
    const startedAt = nowIso();
    const result = db
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
        finishedAt: null,
        message: null,
        output: {},
    };
}

function finishRun(
    run: ScheduledJobRun,
    status: Exclude<ScheduledJobRunStatus, "running">,
    message: string | null,
    output: Record<string, unknown>
): ScheduledJobRun {
    const finishedAt = nowIso();
    db.prepare(
        `UPDATE scheduled_job_runs
         SET status = ?, finished_at = ?, message = ?, output_json = ?
         WHERE id = ?`
    ).run(status, finishedAt, message, JSON.stringify(output), run.id);
    return { ...run, status, finishedAt, message, output };
}

function advanceScheduledRun(job: ScheduledJob): void {
    const currentJob = getScheduledJob(job.id);
    if (!currentJob) {
        return;
    }
    const nextRunAt = calculateNextRunAt(currentJob);
    db.prepare(
        "UPDATE scheduled_jobs SET next_run_at = ?, updated_at = ? WHERE id = ?"
    ).run(nextRunAt, nowIso(), currentJob.id);
}

export async function runScheduledJob(
    id: string,
    triggerType: ScheduledJobTriggerType = "manual"
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
    const handler = actionHandlers.get(job.actionKey);
    if (!handler && triggerType === "manual") {
        throw new ScheduledJobValidationError(
            `No scheduled job action registered for ${job.actionKey}`
        );
    }

    const run = createRun(id, triggerType);
    runningJobs.add(id);
    try {
        if (!handler) {
            throw new ScheduledJobValidationError(
                `No scheduled job action registered for ${job.actionKey}`
            );
        }
        const output = (await handler(job)) ?? {};
        return finishRun(run, "success", null, output);
    } catch (error) {
        return finishRun(run, "failed", errorMessage(error, "Scheduled job failed"), {});
    } finally {
        if (triggerType === "schedule") {
            advanceScheduledRun(job);
        }
        runningJobs.delete(id);
    }
}

async function runDueJobs(): Promise<void> {
    const dueAt = nowIso();
    const rows = db
        .prepare(
            `SELECT id FROM scheduled_jobs
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at, id`
        )
        .all(dueAt) as Array<{ id: string }>;
    const runs: Array<Promise<ScheduledJobRun | void>> = [];
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
                runs.push(
                    runScheduledJob(row.id, "schedule").catch(() => {
                        // Keep unrelated due jobs running even if one row is stale.
                    })
                );
            } catch {
                // Keep later due jobs running even if a persisted row is stale.
            }
        }
    }
    await Promise.all(runs);
}

function scheduleTick(): void {
    if (schedulerTickRunning) {
        return;
    }
    schedulerTickRunning = true;
    void runDueJobs()
        .catch((error) => {
            console.warn("[ScheduledJobs] Scheduler tick failed:", error);
        })
        .finally(() => {
            schedulerTickRunning = false;
        });
}

export function startScheduledJobScheduler(): void {
    if (scheduler) {
        return;
    }
    scheduler = setInterval(scheduleTick, schedulerTickMs);
    scheduler.unref();
    scheduleTick();
}

export function stopScheduledJobScheduler(): void {
    if (!scheduler) {
        return;
    }
    clearInterval(scheduler);
    scheduler = null;
}

export const __testing = {
    clearActionHandlers(): void {
        actionHandlers.clear();
    },
    resetSchedulerState(): void {
        stopScheduledJobScheduler();
        runningJobs.clear();
        schedulerTickRunning = false;
    },
    async runDueJobsForTest(): Promise<void> {
        await runDueJobs();
    },
    mapRunForTest(row?: ScheduledJobRunRow): ScheduledJobRun | null {
        return mapRun(row);
    },
    runSchedulerTickForTest(): void {
        scheduleTick();
    },
};
