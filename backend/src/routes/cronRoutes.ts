import type {
    CronJob,
    CronJobsResponse,
    CronMutationResponse,
} from "../../../contracts/cron.ts";
import {
    parseCronToggleRequest,
    parseCronUpdateRequest,
} from "../../../contracts/cron.ts";
import type { JobDisableIntent } from "../../../contracts/jobs/scheduled.ts";
import { json } from "../http/core.ts";
import {
    type ParametersRequest,
    readApiJsonOrError,
    routeErrorResponse,
    routeFailureResponse,
} from "../http/routeSupport.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import gateway from "../services/gateway/runtime.ts";
import { assertJobDisableIntentIsCurrent } from "../services/jobDisableIntent.ts";
import {
    getOpenClawCronDisableIntent,
    setOpenClawCronDisableIntent,
} from "../services/openClawCronMetadata.ts";
import {
    getOpenClawCronListSnapshot,
    invalidateOpenClawCronListSnapshot,
    normalizeOpenClawCronJobs,
} from "../services/openClawCronSnapshot.ts";
import { withCronTaskLinks } from "../services/taskAutomation.ts";

const logger = createStructuredLogger("cron");
const MAX_CRON_JOB_ID_LENGTH = 512;

function hasUnsafeCronJobIdCharacter(id: string): boolean {
    if (/[/?#\\]/u.test(id)) {
        return true;
    }
    for (const character of id) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
            return true;
        }
    }
    return false;
}

function cronJobId(request: ParametersRequest<"id">): string | Response {
    const id = request.params.id.trim();
    if (!id || id.length > MAX_CRON_JOB_ID_LENGTH || hasUnsafeCronJobIdCharacter(id)) {
        return routeFailureResponse({
            code: "invalid_cron_job_id",
            context: "cron.job-id",
            message: "Invalid cron job ID",
            status: 400,
        });
    }
    return id;
}

function cronError(error: unknown, fallback: string): Response {
    return routeErrorResponse(undefined, error, {
        code: "cron_request_failed",
        context: "cron",
        message: fallback,
    });
}

async function runCronMutation<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } finally {
        invalidateOpenClawCronListSnapshot();
    }
}

async function updateCronWithDisableIntent(
    jobId: string,
    patch: Record<string, unknown>,
    disableIntent?: JobDisableIntent
): Promise<void> {
    const previousIntent = getOpenClawCronDisableIntent(jobId);
    setOpenClawCronDisableIntent(jobId, disableIntent);
    try {
        await gateway.request("cron.update", { jobId, patch });
    } catch (error) {
        try {
            setOpenClawCronDisableIntent(jobId, previousIntent);
        } catch (rollbackError) {
            logger.error("cron.metadata_restore_failed", { error: rollbackError });
        }
        throw error;
    }
}

export const cronRoutes = {
    "/api/cron/jobs": {
        GET: async () => {
            try {
                const payload = await getOpenClawCronListSnapshot();
                return json({
                    jobs: withCronTaskLinks(normalizeOpenClawCronJobs<CronJob>(payload)),
                } satisfies CronJobsResponse);
            } catch (error) {
                return cronError(error, "Failed to list cron jobs");
            }
        },
    },

    "/api/cron/jobs/:id/delete": {
        POST: async (request: ParametersRequest<"id">) => {
            const jobId = cronJobId(request);
            if (jobId instanceof Response) return jobId;
            let previousIntent: JobDisableIntent | undefined;
            try {
                previousIntent = getOpenClawCronDisableIntent(jobId);
                setOpenClawCronDisableIntent(jobId, undefined);
                const payload = await runCronMutation(() =>
                    gateway.request("cron.remove", {
                        jobId,
                    })
                );
                return json({ isOk: true, payload } satisfies CronMutationResponse);
            } catch (error) {
                try {
                    setOpenClawCronDisableIntent(jobId, previousIntent);
                } catch (rollbackError) {
                    logger.error("cron.deleted_metadata_restore_failed", {
                        error: rollbackError,
                    });
                }
                return cronError(error, "Failed to delete cron job");
            }
        },
    },

    "/api/cron/jobs/:id/run": {
        POST: async (request: ParametersRequest<"id">) => {
            const jobId = cronJobId(request);
            if (jobId instanceof Response) return jobId;
            try {
                const payload = await runCronMutation(() =>
                    gateway.request("cron.run", {
                        jobId,
                    })
                );
                return json({ isOk: true, payload } satisfies CronMutationResponse);
            } catch (error) {
                return cronError(error, "Failed to run cron job");
            }
        },
    },

    "/api/cron/jobs/:id/toggle": {
        POST: async (request: ParametersRequest<"id">) => {
            const jobId = cronJobId(request);
            if (jobId instanceof Response) return jobId;
            try {
                const body = await readApiJsonOrError(request, parseCronToggleRequest, {
                    code: "invalid_cron_toggle",
                    context: "cron.toggle",
                    message: "Invalid cron toggle request",
                });
                if (body instanceof Response) return body;
                const disableIntent = body.enabled ? undefined : body.disableIntent;
                if (disableIntent) assertJobDisableIntentIsCurrent(disableIntent);
                await runCronMutation(() =>
                    updateCronWithDisableIntent(
                        jobId,
                        { enabled: body.enabled },
                        disableIntent
                    )
                );
                return json({ isOk: true } satisfies CronMutationResponse);
            } catch (error) {
                return cronError(error, "Failed to toggle cron job");
            }
        },
    },

    "/api/cron/jobs/:id/update": {
        POST: async (request: ParametersRequest<"id">) => {
            const jobId = cronJobId(request);
            if (jobId instanceof Response) return jobId;
            try {
                const body = await readApiJsonOrError(request, parseCronUpdateRequest, {
                    code: "invalid_cron_update",
                    context: "cron.update",
                    message: "Invalid cron update request",
                });
                if (body instanceof Response) return body;
                const cronPatch = body.patch;
                await runCronMutation(
                    cronPatch.enabled === true
                        ? () => updateCronWithDisableIntent(jobId, cronPatch)
                        : () =>
                              gateway.request("cron.update", {
                                  jobId,
                                  patch: cronPatch,
                              })
                );
                return json({ isOk: true } satisfies CronMutationResponse);
            } catch (error) {
                return cronError(error, "Failed to update cron job");
            }
        },
    },
} as const;
