import { json } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    cancelJobExecution,
    getJobExecution,
    getJobExecutionSummary,
    type JobExecution,
    listJobExecutions,
} from "../services/jobExecutionQueue.ts";

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

function publicExecution(
    execution: JobExecution,
    options: { includeOutput?: boolean } = {}
) {
    return {
        id: execution.id,
        scheduledJobId: execution.scheduledJobId,
        scheduledRunId: execution.scheduledRunId,
        actionKey: execution.actionKey,
        displayName: execution.displayName,
        resourceClass: execution.resourceClass,
        status: execution.status,
        triggerType: execution.triggerType,
        queuedAt: execution.queuedAt,
        availableAt: execution.availableAt,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        heartbeatAt: execution.heartbeatAt,
        cancelRequestedAt: execution.cancelRequestedAt,
        cancellable: execution.cancellable,
        attempt: execution.attempt,
        message: execution.message,
        ...(options.includeOutput && { output: execution.output }),
    };
}

function executionLimit(request: Request): number {
    const value = new URL(request.url).searchParams.get("limit");
    if (!value || !/^\d{1,3}$/u.test(value)) return 50;
    return Number(value);
}

function isValidExecutionId(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        id
    );
}

export const jobExecutionRoutes = {
    "/api/job-executions": {
        GET: (request: Request) => {
            try {
                return json({
                    executions: listJobExecutions(executionLimit(request)).map(
                        (execution) => publicExecution(execution)
                    ),
                    summary: getJobExecutionSummary(),
                });
            } catch (error) {
                console.error("[jobExecutionRoutes] Queue lookup failed", error);
                return json(
                    { error: "Job execution queue lookup failed" },
                    { status: 500 }
                );
            }
        },
    },
    "/api/job-executions/:id": {
        GET: (request: ParametersRequest<"id">) => {
            const id = String(request.params.id);
            if (!isValidExecutionId(id)) {
                return json({ error: "Invalid job execution id" }, { status: 400 });
            }
            try {
                const execution = getJobExecution(id);
                return execution
                    ? json({
                          execution: publicExecution(execution, {
                              includeOutput: true,
                          }),
                      })
                    : json({ error: "Job execution not found" }, { status: 404 });
            } catch (error) {
                console.error("[jobExecutionRoutes] Queue detail lookup failed", error);
                return json(
                    { error: "Job execution queue lookup failed" },
                    { status: 500 }
                );
            }
        },
    },
    "/api/job-executions/:id/cancel": {
        POST: (request: ParametersRequest<"id">) => {
            const id = String(request.params.id);
            if (!isValidExecutionId(id)) {
                return json({ error: "Invalid job execution id" }, { status: 400 });
            }
            try {
                const execution = cancelJobExecution(id);
                return json({
                    execution: publicExecution(execution),
                    isOk: true,
                });
            } catch (error) {
                const status = httpStatusCode(error);
                if (status === 500) {
                    console.error(
                        "[jobExecutionRoutes] Queue cancellation failed",
                        error
                    );
                }
                return json(
                    {
                        error:
                            status === 500
                                ? "Job execution cancellation failed"
                                : errorMessage(
                                      error,
                                      "Job execution cancellation failed"
                                  ),
                    },
                    { status }
                );
            }
        },
    },
} as const;
