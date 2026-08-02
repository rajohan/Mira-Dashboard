import type { ScheduledJob, ScheduledJobRun } from "../../../../contracts/jobs.ts";
import { errorMessage } from "../../lib/errors.ts";
import { withJobResourceClass } from "../../lib/jobResources.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    finishJobExecution,
    getJobExecution,
    heartbeatJobExecution,
    type JobExecutionRecord,
    protectRunningJobExecutionFromCancellation,
    updateJobExecutionOutput,
} from "../jobExecutionQueue.ts";
import {
    registeredScheduledJobAction,
    ScheduledJobActionError,
    type ScheduledJobActionContext,
    type ScheduledJobActionRegistration,
    ScheduledJobInterruptionError,
} from "./actionRegistry.ts";
import { ScheduledJobValidationError } from "./errors.ts";
import { getScheduledJob, scheduledRunById } from "./repository.ts";

const logger = createStructuredLogger("scheduled-jobs");
export const executorHeartbeatMs = 1000;
const interruptedHandlerGraceMs = 30_000;

export async function executeClaimedJobExecution(
    execution: JobExecutionRecord,
    workerId: string,
    pauseWorkerClaims: () => () => void,
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
    const action = registeredScheduledJobAction(execution.actionKey);
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
                        pauseWorkerClaims,
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
