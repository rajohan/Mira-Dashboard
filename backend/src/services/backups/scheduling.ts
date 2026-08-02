import type { BackupJobStatus, BackupType } from "../../../../contracts/backups.ts";
import { database } from "../../database/connection.ts";
import { errorMessage } from "../../lib/errors.ts";
import { refreshCacheProducer } from "../cacheRefresh/cacheRefreshRuntime.ts";
import {
    enqueueJobExecution,
    getJobExecution,
    getLatestScheduledJobExecution,
    getPreviousScheduledJobExecution,
    type JobExecutionRecord,
} from "../jobExecutionQueue/repository.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "../queuedJobExecution.ts";
import {
    registerScheduledJobAction,
    type ScheduledJobActionContext,
    ScheduledJobActionError,
} from "../scheduledJobs/actionRegistry.ts";
import { enqueueScheduledJob } from "../scheduledJobs/enqueue.ts";
import {
    getScheduledJob,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "../scheduledJobs/repository.ts";
import {
    type ActiveBackupJob,
    backupStatusCacheKey,
    clearNeedsAttentionBackupJob,
    getCurrentBackupJob,
    getScheduledBackupType,
    mapBackupJob,
    trimBackupOutput,
} from "./backupJobs.ts";
import { startManualBackup } from "./backupProviders.ts";

const SCHEDULED_BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function scheduledBackupJobId(type: BackupType) {
    return type === "kopia" ? "backup.kopia" : "backup.walg";
}

async function startScheduledBackup(
    type: BackupType,
    signal: AbortSignal | undefined,
    context: ScheduledJobActionContext
) {
    if (signal?.aborted) {
        throw new Error("Backup aborted by scheduler");
    }
    const previousExecution = getPreviousScheduledJobExecution(
        scheduledBackupJobId(type),
        context.executionId
    );
    const persistedJob = persistedBackupViewFromExecution(type, previousExecution);
    if (persistedJob?.status === "needs_attention") {
        throw Object.assign(
            new ScheduledJobActionError(`${type.toUpperCase()} backup needs attention`, {
                backup: persistedJob,
            }),
            { statusCode: 409 }
        );
    }
    const currentJob = getCurrentBackupJob(type);
    if (currentJob?.status === "needs_attention") {
        throw Object.assign(
            new ScheduledJobActionError(`${type.toUpperCase()} backup needs attention`, {
                backup: mapBackupJob(currentJob),
            }),
            { statusCode: 409 }
        );
    }
    if (currentJob?.status === "running") {
        throw Object.assign(
            new Error(`${type.toUpperCase()} backup is already running`),
            { statusCode: 409 }
        );
    }
    let job: ActiveBackupJob;
    try {
        job = await startManualBackup(type, signal);
    } catch (error) {
        const attentionJob = getCurrentBackupJob(type);
        if (attentionJob?.status === "needs_attention") {
            const message = errorMessage(
                error,
                `${type.toUpperCase()} backup needs attention`
            );
            throw Object.assign(
                new ScheduledJobActionError(message, {
                    backup: mapBackupJob(attentionJob),
                }),
                { statusCode: 409 }
            );
        }
        throw error;
    }
    const publish = () => context.updateOutput({ backup: mapBackupJob(job) });
    publish();
    const progress = setInterval(publish, 1000);
    progress.unref();
    let completedJob: ActiveBackupJob;
    try {
        completedJob = await job.completed;
    } finally {
        clearInterval(progress);
        publish();
    }
    if (completedJob.code !== 0) {
        const details = completedJob.stderr || completedJob.stdout;
        throw new Error(
            `${type.toUpperCase()} backup failed with code ${completedJob.code}${
                details ? `: ${details}` : ""
            }`
        );
    }
    return { backup: mapBackupJob(completedJob) };
}

function backupViewFromExecution(
    type: BackupType,
    execution: JobExecutionRecord | undefined
) {
    if (!execution) return;
    const backup = execution.output.backup;
    if (backup && typeof backup === "object" && !Array.isArray(backup)) {
        const backupView = backup as NonNullable<ReturnType<typeof mapBackupJob>>;
        if (
            backupView.status === "running" &&
            (execution.status === "failed" || execution.status === "cancelled")
        ) {
            return {
                ...backupView,
                endedAt: execution.finishedAt
                    ? Date.parse(execution.finishedAt)
                    : backupView.endedAt,
                status: execution.status,
                stderr: execution.message ?? backupView.stderr,
            };
        }
        return backupView;
    }
    let status: BackupJobStatus = execution.finishedAt ? "done" : "running";
    if (execution.status === "failed" || execution.status === "cancelled") {
        status = execution.status;
    }
    return {
        code: undefined,
        endedAt: execution.finishedAt ? Date.parse(execution.finishedAt) : undefined,
        id: execution.id,
        startedAt: Date.parse(execution.startedAt ?? execution.queuedAt),
        status,
        stderr: execution.message ?? "",
        stdout: "",
        type,
    } as const;
}

function persistedBackupViewFromExecution(
    type: BackupType,
    execution: JobExecutionRecord | undefined
) {
    if (!execution || wasBackupAttentionClearedAfter(type, execution)) return;
    return backupViewFromExecution(type, execution);
}

export function getPersistedBackupJob(type: BackupType) {
    return persistedBackupViewFromExecution(
        type,
        getLatestScheduledJobExecution(scheduledBackupJobId(type))
    );
}

function wasBackupAttentionClearedAfter(
    type: BackupType,
    execution: JobExecutionRecord
): boolean {
    return Boolean(
        database
            .prepare(
                `SELECT 1
                 FROM job_executions
                 WHERE action_key = 'backup.clear-attention'
                   AND status = 'success'
                   AND json_valid(payload_json)
                   AND json_extract(payload_json, '$.type') = ?
                   AND json_extract(payload_json, '$.backupExecutionId') = ?
                 ORDER BY queued_at DESC, id DESC
                 LIMIT 1`
            )
            .get(type, execution.id)
    );
}

export function queueManualBackup(type: BackupType) {
    if (getPersistedBackupJob(type)?.status === "needs_attention") {
        throw Object.assign(new Error(`${type.toUpperCase()} backup needs attention`), {
            statusCode: 409,
        });
    }
    const scheduledRun = enqueueScheduledJob(scheduledBackupJobId(type), "manual");
    return backupViewFromExecution(
        type,
        scheduledRun.executionId ? getJobExecution(scheduledRun.executionId) : undefined
    );
}

export async function clearPersistedBackupAttention(type: BackupType) {
    let execution: JobExecutionRecord;
    database.run("BEGIN IMMEDIATE");
    try {
        const backupExecutionId = getLatestScheduledJobExecution(
            scheduledBackupJobId(type)
        )?.id;
        if (!backupExecutionId) {
            throw Object.assign(new Error(`${type.toUpperCase()} backup job not found`), {
                statusCode: 404,
            });
        }
        execution = enqueueJobExecution({
            actionKey: "backup.clear-attention",
            displayName: `Clear ${type.toUpperCase()} backup attention`,
            payload: { backupExecutionId, type },
            resourceClass: "light",
            timeoutMs: 5 * 60 * 1000,
        });
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the queue error.
        }
        throw error;
    }
    const completed = await waitForJobExecution(execution.id, {
        timeoutMs: 15 * 60 * 1000,
    });
    const output = successfulJobExecutionOutput(completed);
    return output.backup as ReturnType<typeof mapBackupJob>;
}

async function clearBackupAttention(type: BackupType, backupExecutionId: string) {
    const latestExecution = getLatestScheduledJobExecution(scheduledBackupJobId(type));
    if (!latestExecution) {
        throw Object.assign(new Error(`${type.toUpperCase()} backup job not found`), {
            statusCode: 404,
        });
    }
    if (latestExecution.id !== backupExecutionId) {
        throw Object.assign(
            new Error(`${type.toUpperCase()} backup attention changed before clearing`),
            { statusCode: 409 }
        );
    }

    const current = getCurrentBackupJob(type);
    if (current) {
        return mapBackupJob(await clearNeedsAttentionBackupJob(type));
    }

    const persisted = getPersistedBackupJob(type);
    if (!persisted) {
        throw Object.assign(new Error(`${type.toUpperCase()} backup job not found`), {
            statusCode: 404,
        });
    }
    if (persisted.status !== "needs_attention") {
        throw Object.assign(
            new Error(`${type.toUpperCase()} backup does not need attention`),
            { statusCode: 409 }
        );
    }

    const cleared = { ...persisted };
    try {
        await refreshCacheProducer(backupStatusCacheKey(type), undefined, {
            force: true,
        });
    } catch (error) {
        const stderr = typeof cleared.stderr === "string" ? cleared.stderr : "";
        cleared.stderr = trimBackupOutput(
            `${stderr}\nStatus refresh failed: ${errorMessage(
                error,
                "Unknown error"
            )}`.trim()
        );
    }
    return cleared;
}

const backupScheduledJobs = [
    {
        id: "backup.walg",
        name: "WAL-G backup",
        description: "Run a WAL-G PostgreSQL base backup.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:20",
        actionKey: "backup.run",
        actionPayload: { type: "walg" },
        resourceClass: "host-heavy",
    },
    {
        id: "backup.kopia",
        name: "Kopia backup",
        description: "Run a Kopia filesystem backup.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:50",
        actionKey: "backup.run",
        actionPayload: { type: "kopia" },
        resourceClass: "host-heavy",
    },
] as const;

export function registerBackupScheduledJobs(): void {
    registerScheduledJobAction(
        "backup.run",
        (job, signal, context) => {
            const type = getScheduledBackupType(job.actionPayload);
            if (type !== "kopia" && type !== "walg") {
                throw Object.assign(
                    new Error(`Scheduled backup job ${job.id} has invalid backup type`),
                    { statusCode: 400 }
                );
            }
            return startScheduledBackup(type, signal, context);
        },
        { timeoutMs: SCHEDULED_BACKUP_TIMEOUT_MS }
    );
    registerScheduledJobAction(
        "backup.clear-attention",
        async (job, _signal, context) => {
            const type = getScheduledBackupType(job.actionPayload);
            if (type !== "kopia" && type !== "walg") {
                throw Object.assign(new Error("Invalid backup type"), {
                    statusCode: 400,
                });
            }
            const backupExecutionId = job.actionPayload.backupExecutionId;
            if (
                typeof backupExecutionId !== "string" ||
                backupExecutionId.trim() === ""
            ) {
                throw Object.assign(new Error("Backup execution id is missing"), {
                    statusCode: 400,
                });
            }
            context.protectFromCancellation();
            return { backup: await clearBackupAttention(type, backupExecutionId) };
        }
    );
    database.run("BEGIN IMMEDIATE");
    try {
        removeScheduledJobsNotInAction(
            "backup.run",
            backupScheduledJobs.map((job) => job.id)
        );

        for (const job of backupScheduledJobs) {
            const existing = getScheduledJob(job.id);
            let cronExpression: string | undefined;
            if (existing) {
                cronExpression = existing.cronExpression;
            } else if (
                "cronExpression" in job &&
                typeof job.cronExpression === "string"
            ) {
                cronExpression = job.cronExpression;
            }
            upsertScheduledJob({
                ...job,
                enabled: existing?.enabled ?? true,
                scheduleType: existing?.scheduleType ?? job.scheduleType,
                intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
                timeOfDay: existing ? existing.timeOfDay : job.timeOfDay,
                cronExpression,
            });
        }
        database.run("COMMIT");
    } catch (error) {
        database.run("ROLLBACK");
        throw error;
    }
}
