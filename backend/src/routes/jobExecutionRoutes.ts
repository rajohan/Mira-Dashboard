import type {
    JobExecution as PublicJobExecution,
    JobExecutionCancelResponse,
    JobExecutionResponse,
    JobExecutionsResponse,
    JobWorkerClaimsMutationResponse,
} from "../../../contracts/jobs.ts";
import { parseJobWorkerClaimsPatch } from "../../../contracts/jobs.ts";
import { json } from "../http.ts";
import { httpStatusCode } from "../lib/errors.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    type ParametersRequest,
    readApiJson,
    routeErrorResponse,
    routeFailureResponse,
} from "../routeSupport.ts";
import {
    cancelJobExecution,
    getJobExecution,
    getJobExecutionSummary,
    type JobExecutionRecord,
    listJobExecutions,
} from "../services/jobExecutionQueue.ts";
import { setJobWorkerClaimsPaused } from "../services/jobWorkerControl.ts";

const logger = createStructuredLogger("job-execution-route");

function publicExecution(
    execution: JobExecutionRecord,
    options: { includeOutput?: boolean } = {}
): PublicJobExecution {
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

function includeClaimsState(request: Request): boolean {
    return (
        new URL(request.url).searchParams
            .get("include")
            ?.split(",")
            .includes("claims") === true
    );
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
                const summary = getJobExecutionSummary();
                const backwardCompatibleSummary = { ...summary };
                delete backwardCompatibleSummary.claimsPaused;
                delete backwardCompatibleSummary.claimsPausedAt;
                return json({
                    executions: listJobExecutions(executionLimit(request)).map(
                        (execution) => publicExecution(execution)
                    ),
                    summary: includeClaimsState(request)
                        ? summary
                        : backwardCompatibleSummary,
                } satisfies JobExecutionsResponse);
            } catch (error) {
                logger.error("job_execution.queue_lookup_failed", { error });
                return routeFailureResponse({
                    context: "job-execution",
                    message: "Job execution queue lookup failed",
                    status: 500,
                });
            }
        },
    },
    "/api/job-executions/claims": {
        PATCH: async (request: Request) => {
            try {
                const patch = await readApiJson(request, parseJobWorkerClaimsPatch);
                return json({
                    isOk: true,
                    state: setJobWorkerClaimsPaused(patch.paused),
                } satisfies JobWorkerClaimsMutationResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "job_worker_claims_update_failed",
                    context: "job-execution.claims",
                    message: "Job worker claim state update failed",
                });
            }
        },
    },
    "/api/job-executions/:id": {
        GET: (request: ParametersRequest<"id">) => {
            const id = String(request.params.id);
            if (!isValidExecutionId(id)) {
                return routeFailureResponse({
                    context: "job-execution",
                    message: "Invalid job execution id",
                    status: 400,
                });
            }
            try {
                const execution = getJobExecution(id);
                return execution
                    ? json({
                          execution: publicExecution(execution, {
                              includeOutput: true,
                          }),
                      } satisfies JobExecutionResponse)
                    : routeFailureResponse({
                          context: "job-execution",
                          message: "Job execution not found",
                          status: 404,
                      });
            } catch (error) {
                logger.error("job_execution.detail_lookup_failed", { error });
                return routeFailureResponse({
                    context: "job-execution",
                    message: "Job execution queue lookup failed",
                    status: 500,
                });
            }
        },
    },
    "/api/job-executions/:id/cancel": {
        POST: (request: ParametersRequest<"id">) => {
            const id = String(request.params.id);
            if (!isValidExecutionId(id)) {
                return routeFailureResponse({
                    context: "job-execution",
                    message: "Invalid job execution id",
                    status: 400,
                });
            }
            try {
                const execution = cancelJobExecution(id);
                return json({
                    execution: publicExecution(execution),
                    isOk: true,
                } satisfies JobExecutionCancelResponse);
            } catch (error) {
                const status = httpStatusCode(error);
                if (status === 500) {
                    logger.error("job_execution.cancel_failed", { error });
                }
                return routeErrorResponse(request, error, {
                    code: "job_execution_cancel_failed",
                    context: "job-execution.cancel",
                    message: "Job execution cancellation failed",
                });
            }
        },
    },
} as const;
