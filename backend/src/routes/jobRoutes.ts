import type {
    ScheduledJobMutationResponse,
    ScheduledJobResponse,
    ScheduledJobRunResponse,
    ScheduledJobRunsResponse,
    ScheduledJobsResponse,
} from "../../../contracts/jobs/scheduled.ts";
import { parseScheduledJobUpdateRequest } from "../../../contracts/jobs/scheduled.ts";
import { json } from "../http/core.ts";
import {
    type ParametersRequest,
    readApiJson,
    routeErrorResponse,
    routeFailureResponse,
} from "../http/routeSupport.ts";
import { assertJobDisableIntentIsCurrent } from "../services/jobDisableIntent.ts";
import { enqueueScheduledJob } from "../services/scheduledJobs/enqueue.ts";
import {
    getScheduledJob,
    listScheduledJobRuns,
    listScheduledJobs,
    updateScheduledJob,
} from "../services/scheduledJobs/repository.ts";

export const jobRoutes = {
    "/api/jobs": {
        GET: (request: Request) => {
            try {
                return json({
                    jobs: listScheduledJobs(),
                } satisfies ScheduledJobsResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "scheduled_jobs_list_failed",
                    context: "scheduled-jobs.list",
                    message: "Scheduled job list failed",
                });
            }
        },
    },

    "/api/jobs/:id": {
        GET: (request: ParametersRequest<"id">) => {
            try {
                const job = getScheduledJob(String(request.params.id));
                if (!job) {
                    return routeFailureResponse({
                        context: "job",
                        message: "Scheduled job not found",
                        status: 404,
                    });
                }
                return json({ job } satisfies ScheduledJobResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "scheduled_job_lookup_failed",
                    context: "scheduled-jobs.get",
                    message: "Scheduled job lookup failed",
                });
            }
        },
        PATCH: async (request: ParametersRequest<"id">) => {
            try {
                const { patch: jobPatch } = await readApiJson(
                    request,
                    parseScheduledJobUpdateRequest
                );
                const hasDisableIntent = Object.hasOwn(jobPatch, "disableIntent");
                if (hasDisableIntent && jobPatch.enabled !== false) {
                    return routeFailureResponse({
                        context: "job",
                        message: "disableIntent is only valid when disabling a job",
                        status: 400,
                    });
                }
                const disableIntent = jobPatch.disableIntent;
                if (disableIntent) assertJobDisableIntentIsCurrent(disableIntent);
                const job = updateScheduledJob(String(request.params.id), {
                    cronExpression: jobPatch.cronExpression,
                    disableIntent,
                    enabled: jobPatch.enabled,
                    intervalSeconds: jobPatch.intervalSeconds,
                    scheduleType: jobPatch.scheduleType,
                    timeOfDay: jobPatch.timeOfDay,
                });
                if (!job) {
                    return routeFailureResponse({
                        context: "job",
                        message: "Scheduled job not found",
                        status: 404,
                    });
                }
                return json({
                    isOk: true,
                    job,
                } satisfies ScheduledJobMutationResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "scheduled_job_update_failed",
                    context: "scheduled-jobs.update",
                    message: "Scheduled jobs route failed",
                });
            }
        },
    },

    "/api/jobs/:id/run": {
        POST: (request: ParametersRequest<"id">) => {
            try {
                const run = enqueueScheduledJob(String(request.params.id), "manual");
                return json(
                    {
                        isOk: true,
                        run,
                    } satisfies ScheduledJobRunResponse,
                    { status: 202 }
                );
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "scheduled_job_run_failed",
                    context: "scheduled-jobs.run",
                    message: "Scheduled job run failed",
                });
            }
        },
    },

    "/api/jobs/:id/runs": {
        GET: (request: ParametersRequest<"id">) => {
            try {
                const job = getScheduledJob(String(request.params.id));
                if (!job) {
                    return routeFailureResponse({
                        context: "job",
                        message: "Scheduled job not found",
                        status: 404,
                    });
                }
                return json({
                    runs: listScheduledJobRuns(job.id),
                } satisfies ScheduledJobRunsResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "scheduled_job_runs_lookup_failed",
                    context: "scheduled-jobs.runs",
                    message: "Scheduled job run lookup failed",
                });
            }
        },
    },
} as const;
