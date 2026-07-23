import { errorMessage } from "../lib/errors.ts";
import {
    enqueueJobExecution,
    type EnqueueJobExecutionInput,
    getJobExecution,
    type JobExecution,
} from "./jobExecutionQueue.ts";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export interface WaitForJobExecutionOptions {
    pollIntervalMs?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new DOMException("Request aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, delayMs);
        const abort = () => {
            clearTimeout(timeout);
            reject(new DOMException("Request aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        timeout.unref();
    });
}

export function isTerminalJobExecution(execution: JobExecution): boolean {
    return ["success", "failed", "cancelled"].includes(execution.status);
}

/** Observes a persisted result. Aborting the observer never cancels the execution. */
export async function waitForJobExecution(
    id: string,
    options: WaitForJobExecutionOptions = {}
): Promise<JobExecution> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    while (true) {
        const execution = getJobExecution(id);
        if (!execution) {
            throw Object.assign(new Error("Job execution not found"), {
                statusCode: 404,
            });
        }
        if (isTerminalJobExecution(execution)) return execution;
        if (Date.now() - startedAt >= timeoutMs) {
            throw Object.assign(
                new Error("Timed out while waiting for the queued job result"),
                { executionId: id, statusCode: 504 }
            );
        }
        await waitForDelay(pollIntervalMs, options.signal);
    }
}

export async function enqueueAndWaitForJobExecution(
    input: EnqueueJobExecutionInput,
    options: WaitForJobExecutionOptions = {}
): Promise<JobExecution> {
    const execution = enqueueJobExecution(input);
    return await waitForJobExecution(execution.id, options);
}

/** Returns a successful result or rethrows the worker's persisted failure. */
export function successfulJobExecutionOutput(
    execution: JobExecution
): Record<string, unknown> {
    if (execution.status === "success") return execution.output;
    const statusCode = Number(execution.output.statusCode);
    throw Object.assign(
        new Error(
            execution.message ||
                (execution.status === "cancelled"
                    ? "Job execution was cancelled"
                    : "Job execution failed")
        ),
        {
            executionId: execution.id,
            statusCode:
                Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode < 600
                    ? statusCode
                    : execution.status === "cancelled"
                      ? 409
                      : 500,
        }
    );
}

export function jobExecutionFailureOutput(
    error: unknown,
    fallback = "Job execution failed"
): Record<string, unknown> {
    const statusCode = Number(
        (error as { statusCode?: unknown } | undefined)?.statusCode
    );
    return {
        error: errorMessage(error, fallback),
        ...(Number.isSafeInteger(statusCode) &&
            statusCode >= 400 &&
            statusCode < 600 && { statusCode }),
    };
}
