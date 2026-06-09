import { db } from "../db.js";
import { errorMessage } from "../lib/errors.js";
import { refreshCacheProducer } from "./cacheRefresh.js";
import { runDockerUpdaterService } from "./dockerUpdater.js";
import { runElevatedLogRotationService } from "./logRotation.js";
import { runOpenClawNotificationCheck } from "./openclawNotifications.js";
import { runQuotaNotificationCheck } from "./quotaNotifications.js";

const schedulerTickMs = 30_000;

export type ScheduledJobActionType =
    | "cache.refresh"
    | "cache.refreshMany"
    | "docker.updater"
    | "notification.openclaw"
    | "notification.quota"
    | "ops.logRotation";
export type ScheduledJobScheduleType = "interval" | "daily" | "cron";
export type ScheduledJobRunStatus = "running" | "success" | "failed";
export type ScheduledJobTriggerType = "manual" | "schedule";

export interface ScheduledJob {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    scheduleType: ScheduledJobScheduleType;
    intervalSeconds: number;
    timeOfDay: string | null;
    cronExpression: string | null;
    actionType: ScheduledJobActionType;
    actionTarget: string;
    settings: Record<string, unknown>;
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

interface ScheduledJobRow {
    id: string;
    name: string;
    description: string;
    enabled: number;
    schedule_type: string;
    interval_seconds: number;
    time_of_day: string | null;
    cron_expression: string | null;
    action_type: string;
    action_target: string;
    settings_json: string;
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

interface DefaultScheduledJob {
    id: string;
    name: string;
    description: string;
    actionType?: ScheduledJobActionType;
    actionTarget?: string;
    cacheKey?: string;
    settings?: Record<string, unknown>;
    scheduleType: ScheduledJobScheduleType;
    intervalSeconds: number;
    timeOfDay: string | null;
    cronExpression: string | null;
}

export class ScheduledJobValidationError extends Error {
    statusCode = 400;
    code = "SCHEDULED_JOB_VALIDATION_ERROR";

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

type CacheRefreshRunner = (key: string) => Promise<unknown>;
type DockerUpdaterStep = { step: string; ok: boolean; stderr?: string };
type DockerUpdaterRunner = () => Promise<DockerUpdaterStep[]>;
type LogRotationRunner = (options: { dryRun: boolean }) => Promise<unknown>;
type NotificationRunner = () => Promise<boolean | void>;

const defaultJobs: ReadonlyArray<DefaultScheduledJob> = [
    {
        id: "cache.weather",
        name: "Weather cache",
        description: "Refresh Spydeberg weather cache.",
        cacheKey: "weather.spydeberg",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        timeOfDay: null,
        cronExpression: null,
    },
    {
        id: "cache.quotas",
        name: "Quota cache",
        description: "Refresh provider quota summaries.",
        cacheKey: "quotas.summary",
        scheduleType: "interval",
        intervalSeconds: 30 * 60,
        timeOfDay: null,
        cronExpression: null,
    },
    {
        id: "cache.system",
        name: "System cache",
        description: "Refresh host and OpenClaw system checks.",
        cacheKey: "system.host",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "02:50",
        cronExpression: null,
    },
    {
        id: "cache.git",
        name: "Git cache",
        description: "Refresh workspace git status cache.",
        cacheKey: "git.workspace",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "02:40",
        cronExpression: null,
    },
    {
        id: "cache.moltbook",
        name: "Moltbook cache",
        description: "Refresh Moltbook home, feeds, profile, and own content caches.",
        cacheKey: "moltbook.home",
        actionTarget: "moltbook",
        scheduleType: "interval",
        intervalSeconds: 30 * 60,
        timeOfDay: null,
        cronExpression: null,
    },
    {
        id: "docker.updater",
        name: "Docker updater",
        description:
            "Register services, poll registries, auto-update, and send notifications.",
        actionType: "docker.updater",
        actionTarget: "docker",
        settings: {},
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "04:00",
        cronExpression: null,
    },
    {
        id: "notification.openclaw",
        name: "OpenClaw update notifications",
        description:
            "Check cached OpenClaw version data and create update notifications.",
        actionType: "notification.openclaw",
        actionTarget: "openclaw",
        settings: {},
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        timeOfDay: null,
        cronExpression: null,
    },
    {
        id: "notification.quotas",
        name: "Quota notifications",
        description:
            "Check cached provider quota data and create threshold notifications.",
        actionType: "notification.quota",
        actionTarget: "quotas",
        settings: {},
        scheduleType: "interval",
        intervalSeconds: 15 * 60,
        timeOfDay: null,
        cronExpression: null,
    },
    {
        id: "ops.log-rotation",
        name: "Log rotation",
        description: "Rotate approved file logs using the backend ops runner.",
        actionType: "ops.logRotation",
        actionTarget: "log-rotation",
        settings: { daily: true, dryRun: false, keep: 3, maxSizeMb: 10 },
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:30",
        cronExpression: null,
    },
    {
        id: "cache.backup-kopia",
        name: "Kopia backup cache",
        description: "Refresh Kopia backup status cache.",
        cacheKey: "backup.kopia.status",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:05",
        cronExpression: null,
    },
    {
        id: "cache.backup-walg",
        name: "WAL-G backup cache",
        description: "Refresh Postgres WAL-G backup status cache.",
        cacheKey: "backup.walg.status",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:10",
        cronExpression: null,
    },
];

const obsoleteDefaultJobIds = [
    "cache.moltbook-home",
    "cache.moltbook-feed-hot",
    "cache.moltbook-feed-new",
    "cache.moltbook-profile",
    "cache.moltbook-my-content",
] as const;

const runningJobs = new Set<string>();
let scheduler: NodeJS.Timeout | null = null;
let schedulerTickRunning = false;
let schedulerTickPromise: Promise<void> | null = null;
let actionExecutor: ((job: ScheduledJob) => Promise<Record<string, unknown>>) | undefined;
let staleRunningRunsReconciled = false;
let cacheRefreshRunner: CacheRefreshRunner = refreshCacheProducer;
let dockerUpdaterRunner: DockerUpdaterRunner = runDockerUpdaterService;
let logRotationRunner: LogRotationRunner = runElevatedLogRotationService;
let openClawNotificationRunner: NotificationRunner = runOpenClawNotificationCheck;
let quotaNotificationRunner: NotificationRunner = runQuotaNotificationCheck;

function isOkFalse(value: unknown): boolean {
    return Boolean(
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { ok?: unknown }).ok === false
    );
}

function isLogRotationFailure(value: unknown): boolean {
    if (isOkFalse(value)) {
        return true;
    }
    return Boolean(
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        isOkFalse((value as { result?: unknown }).result)
    );
}

function logRotationFailureMessage(value: unknown): string {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const stderr = (value as { stderr?: unknown }).stderr;
        if (typeof stderr === "string" && stderr.trim()) {
            return stderr.trim();
        }
        const result = (value as { result?: unknown }).result;
        if (result && typeof result === "object" && !Array.isArray(result)) {
            const summary = (result as { summary?: unknown }).summary;
            if (typeof summary === "string" && summary.trim()) {
                return summary.trim();
            }
            const message = (result as { message?: unknown }).message;
            if (typeof message === "string" && message.trim()) {
                return message.trim();
            }
            const error = (result as { error?: unknown }).error;
            if (typeof error === "string" && error.trim()) {
                return error.trim();
            }
            const errors = (result as { errors?: unknown }).errors;
            if (Array.isArray(errors)) {
                const firstMessage = errors.find(
                    (entry): entry is { message: string } =>
                        Boolean(entry) &&
                        typeof entry === "object" &&
                        typeof (entry as { message?: unknown }).message === "string" &&
                        Boolean((entry as { message: string }).message.trim())
                )?.message;
                if (firstMessage) {
                    return firstMessage.trim();
                }
            }
            return JSON.stringify(result);
        }
    }
    return "Log rotation failed";
}

function nowIso(): string {
    return new Date().toISOString();
}

function parseObjectJson(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
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
        output: parseObjectJson(row.output_json),
    };
}

function requireRecordedRun(run: ScheduledJobRun | null): ScheduledJobRun {
    if (!run) {
        throw new Error("Scheduled job run was not recorded");
    }
    return run;
}

function latestRunForJob(jobId: string): ScheduledJobRun | null {
    const row = db
        .prepare(
            `SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`
        )
        .get(jobId) as ScheduledJobRunRow | undefined;
    return mapRun(row);
}

function latestRunsForJobs(jobIds: string[]): Map<string, ScheduledJobRun> {
    if (jobIds.length === 0) {
        return new Map();
    }
    const placeholders = jobIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT runs.*
             FROM scheduled_job_runs runs
             WHERE runs.job_id IN (${placeholders})
               AND NOT EXISTS (
                   SELECT 1
                   FROM scheduled_job_runs newer
                   WHERE newer.job_id = runs.job_id
                     AND (
                         newer.started_at > runs.started_at
                         OR (newer.started_at = runs.started_at AND newer.id > runs.id)
                     )
               )`
        )
        .all(...jobIds) as unknown as ScheduledJobRunRow[];
    return new Map(rows.map((row) => [row.job_id, requireRecordedRun(mapRun(row))]));
}

function mapJob(row: ScheduledJobRow, latestRun = latestRunForJob(row.id)): ScheduledJob {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        enabled: row.enabled === 1,
        scheduleType: row.schedule_type as ScheduledJobScheduleType,
        intervalSeconds: row.interval_seconds,
        timeOfDay: row.time_of_day,
        cronExpression: row.cron_expression,
        actionType: row.action_type as ScheduledJobActionType,
        actionTarget: row.action_target,
        settings: parseObjectJson(row.settings_json),
        nextRunAt: row.next_run_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastRun: latestRun,
        isRunning: runningJobs.has(row.id),
    };
}

function isValidTimeOfDay(value: string): boolean {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function nextIntervalRunIso(intervalSeconds: number, from = Date.now()): string {
    const targetMs = from + intervalSeconds * 1000;
    const maxDateMs = 8.64e15;
    if (!Number.isFinite(targetMs) || Math.abs(targetMs) > maxDateMs) {
        throw new RangeError(
            "intervalSeconds produces a next run outside JS Date bounds"
        );
    }
    return new Date(targetMs).toISOString();
}

function nextDailyRunIso(timeOfDay: string, from = new Date()): string {
    if (!isValidTimeOfDay(timeOfDay)) {
        throw new Error("timeOfDay must be HH:mm");
    }
    const [hourText, minuteText] = timeOfDay.split(":");
    const next = new Date(
        Date.UTC(
            from.getUTCFullYear(),
            from.getUTCMonth(),
            from.getUTCDate(),
            Number(hourText),
            Number(minuteText),
            0,
            0
        )
    );
    if (next.getTime() <= from.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.toISOString();
}

function parseCronNumber(value: string, min: number, max: number): number | null {
    if (!/^\d+$/u.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseCronField(
    field: string,
    min: number,
    max: number
): { any: boolean; values: Set<number> } | null {
    const values = new Set<number>();
    for (const rawPart of field.split(",")) {
        const [rangePart, stepPart] = rawPart.split("/");
        if (!rangePart || rawPart.split("/").length > 2) {
            return null;
        }
        const step =
            stepPart === undefined ? 1 : parseCronNumber(stepPart, 1, max - min + 1);
        if (!step) {
            return null;
        }

        let start: number;
        let end: number;
        if (rangePart === "*") {
            start = min;
            end = max;
        } else if (rangePart.includes("-")) {
            const [startText, endText] = rangePart.split("-");
            if (!startText || !endText || rangePart.split("-").length > 2) {
                return null;
            }
            const parsedStart = parseCronNumber(startText, min, max);
            const parsedEnd = parseCronNumber(endText, min, max);
            if (parsedStart === null || parsedEnd === null || parsedStart > parsedEnd) {
                return null;
            }
            start = parsedStart;
            end = parsedEnd;
        } else {
            const parsed = parseCronNumber(rangePart, min, max);
            if (parsed === null) {
                return null;
            }
            start = parsed;
            end = parsed;
        }

        for (let value = start; value <= end; value += step) {
            values.add(value);
        }
    }

    return { any: values.size === max - min + 1, values };
}

function parseCronExpression(expression: string): {
    dayOfMonth: { any: boolean; values: Set<number> };
    dayOfWeek: { any: boolean; values: Set<number> };
    hours: Set<number>;
    minutes: Set<number>;
    months: Set<number>;
} | null {
    const parts = expression.trim().split(/\s+/u);
    if (parts.length !== 5) {
        return null;
    }
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const minutes = parseCronField(minute, 0, 59);
    const hours = parseCronField(hour, 0, 23);
    const days = parseCronField(dayOfMonth, 1, 31);
    const months = parseCronField(month, 1, 12);
    const weekdays = parseCronField(dayOfWeek, 0, 7);
    if (!minutes || !hours || !days || !months || !weekdays) {
        return null;
    }
    if (weekdays.values.has(7)) {
        weekdays.values.add(0);
        weekdays.values.delete(7);
    }
    return {
        dayOfMonth: days,
        dayOfWeek: weekdays,
        hours: hours.values,
        minutes: minutes.values,
        months: months.values,
    };
}

function cronDayMatches(
    schedule: NonNullable<ReturnType<typeof parseCronExpression>>,
    candidate: Date
): boolean {
    const dayOfMonthMatches = schedule.dayOfMonth.values.has(candidate.getUTCDate());
    const dayOfWeekMatches = schedule.dayOfWeek.values.has(candidate.getUTCDay());
    if (schedule.dayOfMonth.any && schedule.dayOfWeek.any) {
        return true;
    }
    if (schedule.dayOfMonth.any) {
        return dayOfWeekMatches;
    }
    if (schedule.dayOfWeek.any) {
        return dayOfMonthMatches;
    }
    return dayOfMonthMatches || dayOfWeekMatches;
}

function nextCronRunIso(expression: string, from = new Date()): string {
    const schedule = parseCronExpression(expression);
    if (!schedule) {
        throw new Error("cronExpression must be a valid 5-field cron expression");
    }
    const candidate = new Date(from);
    candidate.setUTCSeconds(0, 0);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    const maxAttempts = 5 * 366 * 24 * 60;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (
            schedule.months.has(candidate.getUTCMonth() + 1) &&
            schedule.hours.has(candidate.getUTCHours()) &&
            schedule.minutes.has(candidate.getUTCMinutes()) &&
            cronDayMatches(schedule, candidate)
        ) {
            return candidate.toISOString();
        }
        candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    }
    throw new Error("cronExpression did not produce a run within five years");
}

function computeNextRunIso(
    job: {
        cronExpression: string | null;
        scheduleType: ScheduledJobScheduleType;
        intervalSeconds: number;
        timeOfDay: string | null;
    },
    referenceTime?: Date
): string {
    if (job.scheduleType === "daily" && job.timeOfDay) {
        return nextDailyRunIso(job.timeOfDay, referenceTime);
    }
    if (job.scheduleType === "cron") {
        if (!job.cronExpression) {
            throw new Error("cronExpression is required for cron jobs");
        }
        return nextCronRunIso(job.cronExpression, referenceTime);
    }
    return nextIntervalRunIso(job.intervalSeconds, referenceTime?.getTime());
}

function validateScheduledJobValues(job: {
    cronExpression: string | null;
    intervalSeconds: number;
    scheduleType: ScheduledJobScheduleType;
    timeOfDay: string | null;
}): string | null {
    if (!Number.isSafeInteger(job.intervalSeconds) || job.intervalSeconds < 60) {
        return "intervalSeconds must be an integer >= 60";
    }
    if (!["interval", "daily", "cron"].includes(job.scheduleType)) {
        return "scheduleType must be interval, daily, or cron";
    }
    if (
        job.scheduleType === "daily" &&
        (!job.timeOfDay || !isValidTimeOfDay(job.timeOfDay))
    ) {
        return "timeOfDay must be HH:mm for daily jobs";
    }
    if (job.scheduleType === "cron") {
        if (!job.cronExpression || !parseCronExpression(job.cronExpression)) {
            return "cronExpression must be a valid 5-field cron expression";
        }
        try {
            nextCronRunIso(job.cronExpression);
        } catch {
            return "cronExpression must be a valid 5-field cron expression";
        }
    }
    return null;
}

function rescheduleCompletedRun(
    jobId: string,
    triggerType: ScheduledJobTriggerType
): void {
    if (!shouldRescheduleCompletedRun(jobId, triggerType)) {
        return;
    }
    try {
        updateNextRunFromLatestJob(jobId);
    } catch (error) {
        console.error("[scheduledJobs] failed to update next run", {
            error: errorMessage(error, "Failed to update next run"),
            jobId,
        });
    }
}

export function validateScheduledJobPatch(
    existing: Pick<
        ScheduledJob,
        "cronExpression" | "intervalSeconds" | "scheduleType" | "timeOfDay"
    >,
    patch: {
        cronExpression?: string | null;
        intervalSeconds?: number;
        scheduleType?: ScheduledJobScheduleType;
        timeOfDay?: string | null;
    }
): string | null {
    return validateScheduledJobValues({
        cronExpression:
            patch.cronExpression === undefined
                ? existing.cronExpression
                : patch.cronExpression,
        intervalSeconds: patch.intervalSeconds ?? existing.intervalSeconds,
        scheduleType: patch.scheduleType ?? existing.scheduleType,
        timeOfDay: patch.timeOfDay === undefined ? existing.timeOfDay : patch.timeOfDay,
    });
}

function updateNextRunFromLatestJob(jobId: string): void {
    const row = db
        .prepare(`SELECT * FROM scheduled_jobs WHERE id = ? LIMIT 1`)
        .get(jobId) as ScheduledJobRow | undefined;
    if (!row) {
        return;
    }
    const freshJob = mapJob(row);
    db.prepare(
        `UPDATE scheduled_jobs SET next_run_at = ?, updated_at = ? WHERE id = ?`
    ).run(freshJob.enabled ? computeNextRunIso(freshJob) : null, nowIso(), freshJob.id);
}

function shouldRescheduleCompletedRun(
    jobId: string,
    triggerType: ScheduledJobTriggerType
): boolean {
    if (triggerType === "schedule") {
        return true;
    }
    const latest = getScheduledJob(jobId);
    const now = nowIso();
    return Boolean(latest?.enabled && latest.nextRunAt && latest.nextRunAt <= now);
}

function reconcileStaleRunningRuns(): void {
    if (staleRunningRunsReconciled) {
        return;
    }
    db.prepare(
        `UPDATE scheduled_job_runs
         SET status = 'failed',
             finished_at = COALESCE(finished_at, ?),
             message = COALESCE(message, 'Job was abandoned after backend restart')
         WHERE status = 'running'`
    ).run(nowIso());
    staleRunningRunsReconciled = true;
}

function getDefaultActionTarget(job: DefaultScheduledJob): string {
    const target = job.actionTarget ?? job.cacheKey;
    if (!target) {
        throw new Error(`Default scheduled job ${job.id} is missing an action target`);
    }
    return target;
}

function computeDefaultNextRunIso(
    job: DefaultScheduledJob,
    referenceTime = new Date()
): string {
    try {
        return computeNextRunIso(job, referenceTime);
    } catch {
        return nowIso();
    }
}

function shouldSeedAsDue(job: DefaultScheduledJob): boolean {
    const actionType = job.actionType ?? "cache.refresh";
    return (
        actionType === "cache.refresh" ||
        actionType === "cache.refreshMany" ||
        actionType === "notification.openclaw" ||
        actionType === "notification.quota"
    );
}

/** Seeds built-in scheduled jobs in SQLite. */
export function seedDefaultScheduledJobs(): void {
    reconcileStaleRunningRuns();
    db.exec("BEGIN IMMEDIATE");
    try {
        const deleteJob = db.prepare(`DELETE FROM scheduled_jobs WHERE id = ?`);
        for (const id of obsoleteDefaultJobIds) {
            deleteJob.run(id);
        }

        const insert = db.prepare(`
            INSERT OR IGNORE INTO scheduled_jobs (
                id, name, description, enabled, schedule_type, interval_seconds,
                time_of_day, cron_expression, action_type, action_target,
                settings_json, next_run_at, created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const timestamp = nowIso();
        const referenceTime = new Date(timestamp);
        for (const job of defaultJobs) {
            insert.run(
                job.id,
                job.name,
                job.description,
                job.scheduleType,
                job.intervalSeconds,
                job.timeOfDay,
                job.cronExpression,
                job.actionType ?? "cache.refresh",
                getDefaultActionTarget(job),
                JSON.stringify(job.settings ?? {}),
                shouldSeedAsDue(job)
                    ? timestamp
                    : computeDefaultNextRunIso(job, referenceTime),
                timestamp,
                timestamp
            );
        }
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

/** Lists scheduled jobs with latest run metadata. */
export function listScheduledJobs(): ScheduledJob[] {
    const rows = db
        .prepare(`SELECT * FROM scheduled_jobs ORDER BY name ASC`)
        .all() as unknown as ScheduledJobRow[];
    const latestRuns = latestRunsForJobs(rows.map((row) => row.id));
    return rows.map((row) => mapJob(row, latestRuns.get(row.id) ?? null));
}

/** Returns a scheduled job by ID. */
export function getScheduledJob(id: string): ScheduledJob | null {
    const row = db
        .prepare(`SELECT * FROM scheduled_jobs WHERE id = ? LIMIT 1`)
        .get(id) as ScheduledJobRow | undefined;
    return row ? mapJob(row) : null;
}

/** Updates scheduled job settings. */
export function updateScheduledJob(
    id: string,
    patch: {
        cronExpression?: string | null;
        enabled?: boolean;
        intervalSeconds?: number;
        scheduleType?: ScheduledJobScheduleType;
        timeOfDay?: string | null;
    }
): ScheduledJob | null {
    const existing = getScheduledJob(id);
    if (!existing) {
        return null;
    }

    const enabled = patch.enabled ?? existing.enabled;
    const intervalSeconds = patch.intervalSeconds ?? existing.intervalSeconds;
    const scheduleType = patch.scheduleType ?? existing.scheduleType;
    const timeOfDay =
        patch.timeOfDay === undefined ? existing.timeOfDay : patch.timeOfDay;
    const cronExpression =
        patch.cronExpression === undefined
            ? existing.cronExpression
            : patch.cronExpression;

    const validationError = validateScheduledJobValues({
        cronExpression,
        intervalSeconds,
        scheduleType,
        timeOfDay,
    });
    if (validationError) {
        throw new ScheduledJobValidationError(validationError);
    }

    const timestamp = nowIso();
    const scheduleChanged =
        scheduleType !== existing.scheduleType ||
        intervalSeconds !== existing.intervalSeconds ||
        timeOfDay !== existing.timeOfDay ||
        cronExpression !== existing.cronExpression;
    const nextRunAt = enabled
        ? existing.nextRunAt == null || scheduleChanged
            ? computeNextRunIso({
                  cronExpression,
                  intervalSeconds,
                  scheduleType,
                  timeOfDay,
              })
            : existing.nextRunAt
        : null;
    db.prepare(
        `UPDATE scheduled_jobs
         SET enabled = ?, schedule_type = ?, interval_seconds = ?, time_of_day = ?,
             cron_expression = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`
    ).run(
        enabled ? 1 : 0,
        scheduleType,
        intervalSeconds,
        timeOfDay,
        cronExpression,
        nextRunAt,
        timestamp,
        id
    );
    return getScheduledJob(id);
}

function createRun(job: ScheduledJob, triggerType: ScheduledJobTriggerType): number {
    const result = db
        .prepare(
            `INSERT INTO scheduled_job_runs (
                job_id, status, trigger_type, started_at, output_json
            ) VALUES (?, 'running', ?, ?, '{}')`
        )
        .run(job.id, triggerType, nowIso());
    return Number(result.lastInsertRowid);
}

function finishRun(
    runId: number,
    status: Exclude<ScheduledJobRunStatus, "running">,
    message: string,
    output: Record<string, unknown>
): void {
    db.prepare(
        `UPDATE scheduled_job_runs
         SET status = ?, finished_at = ?, message = ?, output_json = ?
         WHERE id = ?`
    ).run(status, nowIso(), message, JSON.stringify(output), runId);
}

async function executeScheduledJob(job: ScheduledJob): Promise<Record<string, unknown>> {
    if (actionExecutor) {
        return actionExecutor(job);
    }
    if (job.actionType === "cache.refresh") {
        const entry = await cacheRefreshRunner(job.actionTarget);
        return { entry };
    }
    if (job.actionType === "cache.refreshMany") {
        const keys = Array.isArray(job.settings.keys)
            ? job.settings.keys.filter((key): key is string => typeof key === "string")
            : [];
        if (keys.length === 0) {
            throw new Error("cache.refreshMany requires settings.keys");
        }
        const entries = [];
        for (const key of keys) {
            entries.push(await cacheRefreshRunner(key));
        }
        return { entries };
    }
    if (job.actionType === "docker.updater") {
        const steps = await dockerUpdaterRunner();
        if (steps.some((step) => !step.ok)) {
            throw new Error(
                steps
                    .filter((step) => !step.ok)
                    .map((step) => step.stderr || `${step.step} failed`)
                    .join("\n")
            );
        }
        return { steps };
    }
    if (job.actionType === "notification.openclaw") {
        await cacheRefreshRunner("system.host");
        if ((await openClawNotificationRunner()) === false) {
            throw new Error("OpenClaw notification check failed");
        }
        return { checked: true };
    }
    if (job.actionType === "notification.quota") {
        await cacheRefreshRunner("quotas.summary");
        if ((await quotaNotificationRunner()) === false) {
            throw new Error("Quota notification check failed");
        }
        return { checked: true };
    }
    if (job.actionType === "ops.logRotation") {
        const dryRun = job.settings.dryRun === true;
        const logRotation = await logRotationRunner({ dryRun });
        if (isLogRotationFailure(logRotation)) {
            throw new Error(logRotationFailureMessage(logRotation));
        }
        return { logRotation };
    }
    throw new Error(`Unsupported scheduled job action: ${job.actionType}`);
}

/** Runs a scheduled job immediately. */
export async function runScheduledJob(
    id: string,
    triggerType: ScheduledJobTriggerType = "manual"
): Promise<ScheduledJobRun> {
    const job = getScheduledJob(id);
    if (!job) {
        throw Object.assign(new Error("Scheduled job not found"), { statusCode: 404 });
    }
    if (runningJobs.has(job.id)) {
        throw Object.assign(new Error("Scheduled job is already running"), {
            statusCode: 409,
        });
    }
    if (triggerType === "schedule") {
        const freshJob = getScheduledJob(job.id);
        const now = nowIso();
        if (!freshJob?.enabled || !freshJob.nextRunAt || freshJob.nextRunAt > now) {
            throw Object.assign(new Error("Scheduled job not enabled or not due"), {
                statusCode: 409,
            });
        }
    }

    const runId = createRun(job, triggerType);
    runningJobs.add(job.id);
    try {
        const output = await executeScheduledJob(job);
        finishRun(runId, "success", "Job completed", output);
        rescheduleCompletedRun(job.id, triggerType);
    } catch (error) {
        finishRun(runId, "failed", errorMessage(error, "Job failed"), {});
        rescheduleCompletedRun(job.id, triggerType);
    } finally {
        runningJobs.delete(job.id);
    }

    return requireRecordedRun(
        mapRun(
            db
                .prepare(`SELECT * FROM scheduled_job_runs WHERE id = ? LIMIT 1`)
                .get(runId) as ScheduledJobRunRow | undefined
        )
    );
}

async function runDueJobs(): Promise<void> {
    const rows = db
        .prepare(
            `SELECT * FROM scheduled_jobs
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at ASC`
        )
        .all(nowIso()) as unknown as ScheduledJobRow[];

    for (const row of rows) {
        if (runningJobs.has(row.id)) {
            continue;
        }
        const latest = getScheduledJob(row.id);
        if (!latest?.nextRunAt || latest.nextRunAt > nowIso()) {
            continue;
        }
        try {
            await runScheduledJob(latest.id, "schedule");
        } catch (error) {
            if (isScheduledJobRaceError(error)) {
                console.debug("[scheduledJobs] skipped raced due job", {
                    latestId: latest.id,
                    rowId: row.id,
                    error: errorMessage(error, "Scheduled job race"),
                });
                continue;
            }
            throw error;
        }
    }
}

function isScheduledJobRaceError(error: unknown): boolean {
    const value = error as {
        code?: unknown;
        message?: unknown;
        status?: unknown;
        statusCode?: unknown;
    };
    const status = Number(value.status ?? value.statusCode ?? value.code);
    if (status === 404 || status === 409) {
        return true;
    }
    const message = typeof value.message === "string" ? value.message : "";
    return /not found|already running/iu.test(message);
}

/** Starts the backend-native scheduled job loop. */
export function startScheduledJobScheduler(): void {
    if (scheduler) {
        return;
    }
    seedDefaultScheduledJobs();
    scheduler = setInterval(() => {
        if (schedulerTickRunning) {
            return;
        }
        schedulerTickRunning = true;
        schedulerTickPromise = runDueJobs()
            .catch((error) => {
                console.error("[scheduledJobs] runDueJobs failed", error);
            })
            .finally(() => {
                schedulerTickRunning = false;
                schedulerTickPromise = null;
            });
    }, schedulerTickMs);
    scheduler.unref();
}

/** Stops the backend-native scheduled job loop. */
export async function stopScheduledJobScheduler(): Promise<void> {
    if (scheduler) {
        clearInterval(scheduler);
        scheduler = null;
    }
    if (!schedulerTickPromise) {
        schedulerTickRunning = false;
        return;
    }
    await schedulerTickPromise;
}

export const __testing = {
    defaultJobs,
    computeDefaultNextRunIso,
    nextCronRunIso,
    seedDefaultScheduledJobs,
    getDefaultActionTargetForTests: getDefaultActionTarget,
    isScheduledJobRaceError,
    nextDailyRunIso,
    nextIntervalRunIso,
    parseObjectJson,
    requireRecordedRun,
    reconcileStaleRunningRuns,
    runDueJobs,
    updateNextRunFromLatestJob,
    setActionExecutorForTests(
        executor: ((job: ScheduledJob) => Promise<Record<string, unknown>>) | undefined
    ): void {
        actionExecutor = executor;
    },
    resetStaleRunningRunReconciliationForTests(): void {
        staleRunningRunsReconciled = false;
    },
    logRotationFailureMessage,
    setActionRunnersForTests(runners?: {
        cacheRefresh?: CacheRefreshRunner;
        dockerUpdater?: DockerUpdaterRunner;
        logRotation?: LogRotationRunner;
        openClawNotification?: NotificationRunner;
        quotaNotification?: NotificationRunner;
    }): void {
        cacheRefreshRunner = runners?.cacheRefresh ?? refreshCacheProducer;
        dockerUpdaterRunner = runners?.dockerUpdater ?? runDockerUpdaterService;
        logRotationRunner = runners?.logRotation ?? runElevatedLogRotationService;
        openClawNotificationRunner =
            runners?.openClawNotification ?? runOpenClawNotificationCheck;
        quotaNotificationRunner = runners?.quotaNotification ?? runQuotaNotificationCheck;
    },
};
