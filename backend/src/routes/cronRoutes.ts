import type {
    CronJob,
    CronJobsResponse,
    CronMutationResponse,
} from "../../../contracts/cron.ts";
import {
    parseCronToggleRequest,
    parseCronUpdateRequest,
} from "../../../contracts/cron.ts";
import type { JobDisableIntent } from "../../../contracts/jobs.ts";
import gateway from "../gateway.ts";
import { json } from "../http.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    type ParametersRequest,
    readApiJsonOrError,
    routeErrorResponse,
} from "../routeSupport.ts";
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
            let previousIntent: JobDisableIntent | undefined;
            try {
                previousIntent = getOpenClawCronDisableIntent(request.params.id);
                setOpenClawCronDisableIntent(request.params.id, undefined);
                const payload = await runCronMutation(() =>
                    gateway.request("cron.remove", {
                        jobId: request.params.id,
                    })
                );
                return json({ isOk: true, payload } satisfies CronMutationResponse);
            } catch (error) {
                try {
                    setOpenClawCronDisableIntent(request.params.id, previousIntent);
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
            try {
                const payload = await runCronMutation(() =>
                    gateway.request("cron.run", {
                        jobId: request.params.id,
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
                        request.params.id,
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
                        ? () => updateCronWithDisableIntent(request.params.id, cronPatch)
                        : () =>
                              gateway.request("cron.update", {
                                  jobId: request.params.id,
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
