import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    getScheduledJob,
    isScheduledJobValidationError,
    listScheduledJobRuns,
    listScheduledJobs,
    runScheduledJob,
    type ScheduledJobScheduleType,
    updateScheduledJob,
} from "../services/scheduledJobs.ts";

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

const scheduleTypes = new Set<ScheduledJobScheduleType>(["cron", "daily", "interval"]);
const allowedPatchFields = new Set([
    "cronExpression",
    "enabled",
    "intervalSeconds",
    "scheduleType",
    "timeOfDay",
]);

function invalidPatchField(patch: Record<string, unknown>): string | null {
    for (const key of Object.keys(patch)) {
        if (!allowedPatchFields.has(key)) return key;
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
        return "enabled";
    }
    if (
        patch.intervalSeconds !== undefined &&
        typeof patch.intervalSeconds !== "number"
    ) {
        return "intervalSeconds";
    }
    if (
        patch.scheduleType !== undefined &&
        (typeof patch.scheduleType !== "string" ||
            !scheduleTypes.has(patch.scheduleType as ScheduledJobScheduleType))
    ) {
        return "scheduleType";
    }
    if (
        patch.cronExpression !== undefined &&
        patch.cronExpression !== null &&
        typeof patch.cronExpression !== "string"
    ) {
        return "cronExpression";
    }
    if (
        patch.timeOfDay !== undefined &&
        patch.timeOfDay !== null &&
        typeof patch.timeOfDay !== "string"
    ) {
        return "timeOfDay";
    }
    return null;
}

export const jobRoutes = {
    "/api/jobs": {
        GET: () => json({ jobs: listScheduledJobs() }),
    },

    "/api/jobs/:id": {
        GET: (request: ParametersRequest<"id">) => {
            try {
                const job = getScheduledJob(String(request.params.id));
                if (!job) {
                    return json({ error: "Scheduled job not found" }, { status: 404 });
                }
                return json({ job });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Scheduled job lookup failed") },
                    { status: httpStatusCode(error) }
                );
            }
        },
        PATCH: async (request: ParametersRequest<"id">) => {
            let body: { patch?: unknown };
            try {
                body = await readJson<{ patch?: unknown }>(request);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Invalid JSON") },
                    { status: httpStatusCode(error) }
                );
            }
            const patch = body?.patch;
            if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
                return json({ error: "patch must be an object" }, { status: 400 });
            }
            const invalidField = invalidPatchField(patch as Record<string, unknown>);
            if (invalidField) {
                return json(
                    { error: `invalid patch field: ${invalidField}` },
                    { status: 400 }
                );
            }
            const jobPatch = patch as Record<string, unknown>;

            try {
                const job = updateScheduledJob(String(request.params.id), {
                    cronExpression:
                        typeof jobPatch.cronExpression === "string" ||
                        jobPatch.cronExpression === null
                            ? jobPatch.cronExpression
                            : undefined,
                    enabled:
                        typeof jobPatch.enabled === "boolean"
                            ? jobPatch.enabled
                            : undefined,
                    intervalSeconds:
                        typeof jobPatch.intervalSeconds === "number"
                            ? jobPatch.intervalSeconds
                            : undefined,
                    scheduleType: jobPatch.scheduleType as
                        | ScheduledJobScheduleType
                        | undefined,
                    timeOfDay:
                        typeof jobPatch.timeOfDay === "string" ||
                        jobPatch.timeOfDay === null
                            ? jobPatch.timeOfDay
                            : undefined,
                });
                if (!job) {
                    return json({ error: "Scheduled job not found" }, { status: 404 });
                }
                return json({ isOk: true, job });
            } catch (error) {
                if (isScheduledJobValidationError(error)) {
                    return json({ error: error.message }, { status: error.statusCode });
                }
                console.error("[jobsRoutes] Scheduled jobs route failed", error);
                return json({ error: "Scheduled jobs route failed" }, { status: 500 });
            }
        },
    },

    "/api/jobs/:id/run": {
        POST: async (request: ParametersRequest<"id">) => {
            try {
                const run = await runScheduledJob(String(request.params.id), "manual");
                return json({ isOk: run.status === "success", run });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Scheduled job run failed") },
                    { status: httpStatusCode(error) }
                );
            }
        },
    },

    "/api/jobs/:id/runs": {
        GET: (request: ParametersRequest<"id">) => {
            try {
                const job = getScheduledJob(String(request.params.id));
                if (!job) {
                    return json({ error: "Scheduled job not found" }, { status: 404 });
                }
                return json({ runs: listScheduledJobRuns(job.id) });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Scheduled job run lookup failed") },
                    { status: httpStatusCode(error) }
                );
            }
        },
    },
} as const;
