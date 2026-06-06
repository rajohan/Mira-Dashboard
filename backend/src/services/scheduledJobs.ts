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
        settings: { dryRun: false },
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

function mapJob(row: ScheduledJobRow): ScheduledJob {
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
        lastRun: latestRunForJob(row.id),
        isRunning: runningJobs.has(row.id),
    };
}

function isValidTimeOfDay(value: string): boolean {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function nextIntervalRunIso(intervalSeconds: number, from = Date.now()): string {
    return new Date(from + intervalSeconds * 1000).toISOString();
}

function nextDailyRunIso(timeOfDay: string, from = new Date()): string {
    if (!isValidTimeOfDay(timeOfDay)) {
        throw new Error("timeOfDay must be HH:mm");
    }
    const [hourText, minuteText] = timeOfDay.split(":");
    const next = new Date(from);
    next.setHours(Number(hourText), Number(minuteText), 0, 0);
    if (next.getTime() <= from.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
}

function computeNextRunIso(job: {
    scheduleType: ScheduledJobScheduleType;
    intervalSeconds: number;
    timeOfDay: string | null;
}): string {
    if (job.scheduleType === "daily" && job.timeOfDay) {
        return nextDailyRunIso(job.timeOfDay);
    }
    return nextIntervalRunIso(job.intervalSeconds);
}

function validateScheduledJobValues(job: {
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
        return "cron schedule is not implemented yet";
    }
    return null;
}

export function validateScheduledJobPatch(
    existing: Pick<ScheduledJob, "intervalSeconds" | "scheduleType" | "timeOfDay">,
    patch: {
        intervalSeconds?: number;
        scheduleType?: ScheduledJobScheduleType;
        timeOfDay?: string | null;
    }
): string | null {
    return validateScheduledJobValues({
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

function reconcileStaleRunningRuns(): void {
    if (staleRunningRunsReconciled) {
        return;
    }
    staleRunningRunsReconciled = true;
    db.prepare(
        `UPDATE scheduled_job_runs
         SET status = 'failed',
             finished_at = COALESCE(finished_at, ?),
             message = COALESCE(message, 'Job was abandoned after backend restart')
         WHERE status = 'running'`
    ).run(nowIso());
}

function getDefaultActionTarget(job: DefaultScheduledJob): string {
    const target = job.actionTarget ?? job.cacheKey;
    if (!target) {
        throw new Error(`Default scheduled job ${job.id} is missing an action target`);
    }
    return target;
}

/** Ensures built-in scheduled jobs exist in SQLite. */
export function ensureDefaultScheduledJobs(): void {
    reconcileStaleRunningRuns();
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
    for (const job of defaultJobs) {
        const initialNextRunAt = computeNextRunIso(job);
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
            initialNextRunAt,
            timestamp,
            timestamp
        );
    }
}

/** Lists scheduled jobs with latest run metadata. */
export function listScheduledJobs(): ScheduledJob[] {
    ensureDefaultScheduledJobs();
    const rows = db
        .prepare(`SELECT * FROM scheduled_jobs ORDER BY name ASC`)
        .all() as unknown as ScheduledJobRow[];
    return rows.map(mapJob);
}

/** Returns a scheduled job by ID. */
export function getScheduledJob(id: string): ScheduledJob | null {
    ensureDefaultScheduledJobs();
    const row = db
        .prepare(`SELECT * FROM scheduled_jobs WHERE id = ? LIMIT 1`)
        .get(id) as ScheduledJobRow | undefined;
    return row ? mapJob(row) : null;
}

/** Updates scheduled job settings. */
export function updateScheduledJob(
    id: string,
    patch: {
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

    const validationError = validateScheduledJobValues({
        intervalSeconds,
        scheduleType,
        timeOfDay,
    });
    if (validationError) {
        throw new Error(validationError);
    }

    const timestamp = nowIso();
    const scheduleChanged =
        scheduleType !== existing.scheduleType ||
        intervalSeconds !== existing.intervalSeconds ||
        timeOfDay !== existing.timeOfDay;
    const nextRunAt = enabled
        ? existing.nextRunAt == null || scheduleChanged
            ? computeNextRunIso({ scheduleType, intervalSeconds, timeOfDay })
            : existing.nextRunAt
        : null;
    db.prepare(
        `UPDATE scheduled_jobs
         SET enabled = ?, schedule_type = ?, interval_seconds = ?, time_of_day = ?,
             next_run_at = ?, updated_at = ?
         WHERE id = ?`
    ).run(
        enabled ? 1 : 0,
        scheduleType,
        intervalSeconds,
        timeOfDay,
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
        if ((await openClawNotificationRunner()) === false) {
            throw new Error("OpenClaw notification check failed");
        }
        return { checked: true };
    }
    if (job.actionType === "notification.quota") {
        if ((await quotaNotificationRunner()) === false) {
            throw new Error("Quota notification check failed");
        }
        return { checked: true };
    }
    if (job.actionType === "ops.logRotation") {
        const dryRun = job.settings.dryRun === true;
        const logRotation = await logRotationRunner({ dryRun });
        if (isLogRotationFailure(logRotation)) {
            throw new Error("Log rotation failed");
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

    const runId = createRun(job, triggerType);
    runningJobs.add(job.id);
    try {
        const output = await executeScheduledJob(job);
        finishRun(runId, "success", "Job completed", output);
        if (triggerType === "schedule") {
            updateNextRunFromLatestJob(job.id);
        }
    } catch (error) {
        finishRun(runId, "failed", errorMessage(error, "Job failed"), {});
        if (triggerType === "schedule") {
            updateNextRunFromLatestJob(job.id);
        }
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
    ensureDefaultScheduledJobs();
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
    ensureDefaultScheduledJobs();
    scheduler = setInterval(() => {
        if (schedulerTickRunning) {
            return;
        }
        schedulerTickRunning = true;
        runDueJobs()
            .catch((error) => {
                console.error("[scheduledJobs] runDueJobs failed", error);
            })
            .finally(() => {
                schedulerTickRunning = false;
            });
    }, schedulerTickMs);
    scheduler.unref();
}

/** Stops the backend-native scheduled job loop. */
export function stopScheduledJobScheduler(): void {
    if (!scheduler) {
        return;
    }
    clearInterval(scheduler);
    scheduler = null;
    schedulerTickRunning = false;
}

export const __testing = {
    defaultJobs,
    ensureDefaultScheduledJobs,
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
