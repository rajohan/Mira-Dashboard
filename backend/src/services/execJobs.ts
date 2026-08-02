import type {
    ExecJobStatus,
    ExecJobResponse,
    ExecResponse,
    ExecStartResponse,
    ExecStopResponse,
} from "../../../contracts/exec.ts";
import { database } from "../database/connection.ts";
import { ApiRouteError, mapApiError, type MappedApiError } from "../http/apiErrors.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { runExecCommand, trimExecOutput } from "./execJobs/processRunner.ts";
import { type ExecRequestMode, validateExecRequest } from "./execJobs/requestPolicy.ts";
import {
    enqueueJobExecution,
    getJobExecution,
    type JobExecutionRecord,
} from "./jobExecutionQueue/repository.ts";
import { cancelJobExecution } from "./jobExecutionQueue/worker.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "./queuedJobExecution.ts";
import {
    registerScheduledJobAction,
    ScheduledJobActionError,
} from "./scheduledJobs/actionRegistry.ts";

const MAX_JOBS = 100;
const EXEC_ONCE_TIMEOUT_MS = 60_000;
const TRACKED_EXEC_TIMEOUT_MS = 7 * 60 * 60 * 1000;
const STREAM_UPDATE_INTERVAL_MS = 250;

/**
 * Maps a queued execution to the exec-job API status vocabulary.
 *
 * @param execution - Persisted job execution.
 * @param isTerminal - Whether the execution reached a terminal state.
 * @returns Exec-job status exposed through the API contract.
 */
function execJobStatus(
    execution: JobExecutionRecord,
    isTerminal: boolean
): ExecJobStatus {
    if (isTerminal) {
        return "done";
    }
    return execution.cancelRequestedAt ? "signaled" : "running";
}

export function execErrorResponse(error: unknown): MappedApiError {
    const status = httpStatusCode(error);
    let code = "exec_request_failed";
    if (status === 400 || status === 413) {
        code = "exec_invalid_request";
    }
    if (status === 500) {
        code = "exec_internal_error";
    }
    return mapApiError(error, {
        code,
        message: status === 500 ? "internal server error" : "request failed",
    });
}

function outputString(output: Record<string, unknown>, key: string): string {
    return typeof output[key] === "string" ? output[key] : "";
}

function outputNumber(output: Record<string, unknown>, key: string): number | undefined {
    return typeof output[key] === "number" && Number.isFinite(output[key])
        ? output[key]
        : undefined;
}

function execResponseFromExecution(execution: JobExecutionRecord): ExecResponse {
    const output = execution.output;
    if (typeof output.stdout !== "string" || typeof output.stderr !== "string") {
        successfulJobExecutionOutput(execution);
    }
    return {
        code: outputNumber(output, "code"),
        stderr: outputString(output, "stderr").slice(-10_000),
        stdout: outputString(output, "stdout").slice(-10_000),
    };
}

async function executeCommandInWorker(
    payload: Record<string, unknown>,
    mode: ExecRequestMode,
    signal: AbortSignal | undefined,
    updateOutput: (output: Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
    const request = validateExecRequest(payload.request, mode);
    const startedAt = Date.now();
    let lastPublishedAt = 0;
    let latestOutput = { stderr: "", stdout: "" };
    const publish = (
        update: Pick<ExecResponse, "stderr" | "stdout">,
        isForced = false
    ) => {
        const timestamp = Date.now();
        if (!isForced && timestamp - lastPublishedAt < STREAM_UPDATE_INTERVAL_MS) return;
        lastPublishedAt = timestamp;
        updateOutput({
            endedAt: undefined,
            startedAt,
            status: "running",
            stderr: update.stderr,
            stdout: update.stdout,
        });
    };
    publish(latestOutput, true);
    let result: ExecResponse;
    try {
        result = await runExecCommand(
            request,
            (update) => {
                latestOutput = update;
                publish(update);
            },
            mode === "once" ? EXEC_ONCE_TIMEOUT_MS : undefined,
            signal
        );
    } catch (error) {
        const output = {
            code: 1,
            endedAt: Date.now(),
            startedAt,
            status: "done",
            stderr: trimExecOutput(
                `${latestOutput.stderr}\n${errorMessage(error, "Tracked command failed")}`.trim()
            ),
            stdout: latestOutput.stdout,
        };
        throw new ScheduledJobActionError("Tracked command failed", output);
    }
    const output = {
        code: result.code,
        endedAt: Date.now(),
        startedAt,
        status: "done",
        stderr: result.stderr,
        stdout: result.stdout,
    };
    publish(result, true);
    if (result.code !== 0) {
        throw new ScheduledJobActionError("Tracked command exited non-zero", output);
    }
    return output;
}

export function registerExecExecutionActions(): void {
    registerScheduledJobAction(
        "exec.once",
        (job, signal, context) =>
            executeCommandInWorker(
                job.actionPayload,
                "once",
                signal,
                context.updateOutput
            ),
        { timeoutMs: EXEC_ONCE_TIMEOUT_MS }
    );
    registerScheduledJobAction(
        "exec.tracked",
        (job, signal, context) =>
            executeCommandInWorker(
                job.actionPayload,
                "start",
                signal,
                context.updateOutput
            ),
        { timeoutMs: TRACKED_EXEC_TIMEOUT_MS }
    );
}

export async function runExecOnce(payload?: unknown): Promise<ExecResponse> {
    const request = validateExecRequest(payload, "once");
    const execution = enqueueJobExecution({
        actionKey: "exec.once",
        displayName: "Tracked ops command",
        payload: { request },
        resourceClass: "exclusive",
        timeoutMs: EXEC_ONCE_TIMEOUT_MS,
    });
    return execResponseFromExecution(
        await waitForJobExecution(execution.id, {
            timeoutMs: EXEC_ONCE_TIMEOUT_MS + 30 * 60 * 1000,
        })
    );
}

function activeTrackedExecCount(): number {
    const row = database
        .prepare(
            `SELECT COUNT(*) AS count
             FROM job_executions
             WHERE action_key = 'exec.tracked'
               AND status IN ('queued', 'running')`
        )
        .get() as { count: number };
    return row.count;
}

export function startExecJob(payload: unknown): ExecStartResponse {
    if (activeTrackedExecCount() >= MAX_JOBS) {
        throw new ApiRouteError("exec_capacity_exceeded", "Too many exec jobs", 429, {
            retryAfterSeconds: 5,
        });
    }
    const request = validateExecRequest(payload, "start");
    const execution = enqueueJobExecution({
        actionKey: "exec.tracked",
        displayName: "Tracked shell job",
        payload: { request },
        resourceClass: "exclusive",
        timeoutMs: TRACKED_EXEC_TIMEOUT_MS,
    });
    return { jobId: execution.id };
}

function trackedExecExecution(jobId: string): JobExecutionRecord {
    const execution = getJobExecution(jobId);
    if (!execution || execution.actionKey !== "exec.tracked") {
        throw new ApiRouteError("exec_job_not_found", "Exec job not found", 404);
    }
    return execution;
}

export function stopExecJob(jobId: string): ExecStopResponse {
    const execution = trackedExecExecution(jobId);
    if (execution.status !== "queued" && execution.status !== "running") {
        throw new ApiRouteError("exec_job_not_running", "Job is not running", 400);
    }
    cancelJobExecution(jobId);
    return { isSuccess: true, message: "Stop signal sent" };
}

export function getExecJob(jobId: string): ExecJobResponse {
    const execution = trackedExecExecution(jobId);
    const output = execution.output;
    const isTerminal = ["success", "failed", "cancelled"].includes(execution.status);
    return {
        code: outputNumber(output, "code"),
        endedAt: isTerminal
            ? (outputNumber(output, "endedAt") ??
              (execution.finishedAt ? Date.parse(execution.finishedAt) : undefined))
            : undefined,
        jobId: execution.id,
        startedAt:
            outputNumber(output, "startedAt") ??
            Date.parse(execution.startedAt ?? execution.queuedAt),
        status: execJobStatus(execution, isTerminal),
        stderr: outputString(output, "stderr"),
        stdout: outputString(output, "stdout"),
    };
}
