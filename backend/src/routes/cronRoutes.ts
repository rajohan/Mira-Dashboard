import gateway from "../gateway.ts";
import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    assertJobDisableIntentIsCurrent,
    type JobDisableIntent,
    normalizeJobDisableIntent,
} from "../services/jobDisableIntent.ts";
import {
    getOpenClawCronDisableIntent,
    setOpenClawCronDisableIntent,
} from "../services/openClawCronMetadata.ts";
import { withCronTaskLinks } from "../services/taskAutomation.ts";

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

interface CronJob {
    delivery?: { mode?: string; [key: string]: unknown };
    enabled?: boolean;
    id?: string;
    jobId?: string;
    name?: string;
    payload?: { kind?: string; [key: string]: unknown };
    schedule?: { kind?: string; [key: string]: unknown };
    [key: string]: unknown;
}

interface CronListResponse {
    items?: CronJob[];
    jobs?: CronJob[];
}

function normalizeJobs(payload: unknown): CronJob[] {
    if (!payload || typeof payload !== "object") return [];
    const value = payload as CronListResponse;
    if (Array.isArray(value.jobs)) return value.jobs;
    if (Array.isArray(value.items)) return value.items;
    return [];
}

function cronError(error: unknown, fallback: string): Response {
    return json(
        { error: errorMessage(error, fallback) },
        { status: httpStatusCode(error) }
    );
}

async function updateCronWithDisableIntent(
    jobId: string,
    patch: Record<string, unknown>,
    disableIntent: JobDisableIntent | undefined
): Promise<void> {
    const previousIntent = getOpenClawCronDisableIntent(jobId);
    setOpenClawCronDisableIntent(jobId, disableIntent);
    try {
        await gateway.request("cron.update", { jobId, patch });
    } catch (error) {
        try {
            setOpenClawCronDisableIntent(jobId, previousIntent);
        } catch (rollbackError) {
            console.error(
                "[cronRoutes] Failed to restore OpenClaw cron metadata",
                rollbackError
            );
        }
        throw error;
    }
}

export const cronRoutes = {
    "/api/cron/jobs": {
        GET: async () => {
            try {
                const payload = await gateway.request("cron.list", {
                    includeDisabled: true,
                });
                return json({ jobs: withCronTaskLinks(normalizeJobs(payload)) });
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
                const payload = await gateway.request("cron.remove", {
                    jobId: request.params.id,
                });
                return json({ isOk: true, payload });
            } catch (error) {
                try {
                    setOpenClawCronDisableIntent(request.params.id, previousIntent);
                } catch (rollbackError) {
                    console.error(
                        "[cronRoutes] Failed to restore deleted cron metadata",
                        rollbackError
                    );
                }
                return cronError(error, "Failed to delete cron job");
            }
        },
    },

    "/api/cron/jobs/:id/run": {
        POST: async (request: ParametersRequest<"id">) => {
            try {
                const payload = await gateway.request("cron.run", {
                    jobId: request.params.id,
                });
                return json({ isOk: true, payload });
            } catch (error) {
                return cronError(error, "Failed to run cron job");
            }
        },
    },

    "/api/cron/jobs/:id/toggle": {
        POST: async (request: ParametersRequest<"id">) => {
            try {
                const body = await readJson<{
                    disableIntent?: unknown;
                    enabled?: unknown;
                }>(request);
                if (!body || typeof body !== "object" || Array.isArray(body)) {
                    return json(
                        { error: "Request body must be an object" },
                        { status: 400 }
                    );
                }
                if (typeof body.enabled !== "boolean") {
                    return json({ error: "enabled must be a boolean" }, { status: 400 });
                }
                if (body.enabled && body.disableIntent !== undefined) {
                    return json(
                        { error: "disableIntent is only valid when disabling a job" },
                        { status: 400 }
                    );
                }
                const disableIntent = body.enabled
                    ? undefined
                    : normalizeJobDisableIntent(body.disableIntent);
                if (disableIntent) assertJobDisableIntentIsCurrent(disableIntent);
                await updateCronWithDisableIntent(
                    request.params.id,
                    { enabled: body.enabled },
                    disableIntent
                );
                return json({ isOk: true });
            } catch (error) {
                return cronError(error, "Failed to toggle cron job");
            }
        },
    },

    "/api/cron/jobs/:id/update": {
        POST: async (request: ParametersRequest<"id">) => {
            try {
                const body = await readJson<{ patch?: unknown }>(request);
                if (!body || typeof body !== "object" || Array.isArray(body)) {
                    return json(
                        { error: "Request body must be an object" },
                        { status: 400 }
                    );
                }
                const patch = body.patch;
                if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
                    return json({ error: "patch must be an object" }, { status: 400 });
                }
                const cronPatch = patch as Record<string, unknown>;
                if (cronPatch.enabled === true) {
                    await updateCronWithDisableIntent(
                        request.params.id,
                        cronPatch,
                        undefined
                    );
                } else {
                    await gateway.request("cron.update", {
                        jobId: request.params.id,
                        patch: cronPatch,
                    });
                }
                return json({ isOk: true });
            } catch (error) {
                return cronError(error, "Failed to update cron job");
            }
        },
    },
} as const;
