import type {
    ScheduledJobRun,
    ScheduledJobTriggerType,
} from "../../../../contracts/jobs.ts";
import { database, sqlNullable } from "../../database/connection.ts";
import { errorMessage } from "../../lib/errors.ts";
import { insertJobExecution } from "../jobExecutionQueue/repository.ts";
import { waitForJobExecution } from "../queuedJobExecution.ts";
import { registeredScheduledJobAction } from "./actionRegistry.ts";
import { ScheduledJobValidationError } from "./errors.ts";
import { getScheduledJob, insertScheduledRun, scheduledRunById } from "./repository.ts";
import { calculateNextRunAt } from "./schedule.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

export function nowIso(): string {
    return dateToISOString(new Date());
}

interface EnqueueScheduledJobOptions {
    availableAt?: string;
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
    const action = registeredScheduledJobAction(job.actionKey);
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
