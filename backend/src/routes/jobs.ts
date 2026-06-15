import express, { type ErrorRequestHandler, type RequestHandler } from "express";

import {
    asyncRoute as baseAsyncRoute,
    errorMessage,
    httpStatusCode,
} from "../lib/errors.js";
import {
    getScheduledJob,
    isScheduledJobValidationError,
    listScheduledJobs,
    runScheduledJob,
    type ScheduledJobScheduleType,
    updateScheduledJob,
} from "../services/scheduledJobs.js";

const JOBS_JSON_LIMIT = "2097152b";
const scheduleTypes = new Set<ScheduledJobScheduleType>(["cron", "daily", "interval"]);
const allowedPatchFields = new Set([
    "cronExpression",
    "enabled",
    "intervalSeconds",
    "scheduleType",
    "timeOfDay",
]);

const invalidJobsJsonHandler: ErrorRequestHandler = (error, _req, res, next) => {
    const status = Number((error as { status?: unknown }).status);
    const type = String((error as { type?: unknown }).type ?? "");
    if (status === 413 || type === "entity.too.large") {
        res.status(413).json({ error: "Scheduled job patch is too large" });
        return;
    }
    if (error instanceof SyntaxError && status === 400) {
        res.status(400).json({ error: "Invalid scheduled job patch" });
        return;
    }
    next(error);
};

function asyncRoute(handler: RequestHandler): RequestHandler {
    return baseAsyncRoute(handler, {
        fallback: "Scheduled jobs route failed",
        logLabel: "[jobsRoutes]",
    });
}

function invalidPatchField(patch: Record<string, unknown>): string | null {
    for (const key of Object.keys(patch)) {
        if (!allowedPatchFields.has(key)) {
            return key;
        }
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

/** Registers backend-native scheduled job routes. */
export default function jobsRoutes(app: express.Application): void {
    app.get(
        "/api/jobs",
        asyncRoute((_req, res) => {
            res.json({ jobs: listScheduledJobs() });
        })
    );

    app.get(
        "/api/jobs/:id",
        asyncRoute((req, res) => {
            const job = getScheduledJob(String(req.params.id));
            if (!job) {
                res.status(404).json({ error: "Scheduled job not found" });
                return;
            }
            res.json({ job });
        })
    );

    app.patch(
        "/api/jobs/:id",
        express.json({ limit: JOBS_JSON_LIMIT, strict: false }),
        invalidJobsJsonHandler,
        asyncRoute((req, res) => {
            const patch = req.body?.patch;
            if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
                res.status(400).json({ error: "patch must be an object" });
                return;
            }
            const invalidField = invalidPatchField(patch as Record<string, unknown>);
            if (invalidField) {
                res.status(400).json({ error: `invalid patch field: ${invalidField}` });
                return;
            }
            try {
                const job = updateScheduledJob(String(req.params.id), {
                    enabled:
                        typeof patch.enabled === "boolean" ? patch.enabled : undefined,
                    cronExpression:
                        typeof patch.cronExpression === "string" ||
                        patch.cronExpression === null
                            ? patch.cronExpression
                            : undefined,
                    intervalSeconds:
                        typeof patch.intervalSeconds === "number"
                            ? patch.intervalSeconds
                            : undefined,
                    scheduleType: patch.scheduleType as
                        | ScheduledJobScheduleType
                        | undefined,
                    timeOfDay:
                        typeof patch.timeOfDay === "string" || patch.timeOfDay === null
                            ? patch.timeOfDay
                            : undefined,
                });
                if (!job) {
                    res.status(404).json({ error: "Scheduled job not found" });
                    return;
                }
                res.json({ ok: true, job });
            } catch (error) {
                if (isScheduledJobValidationError(error)) {
                    res.status(error.statusCode).json({ error: error.message });
                    return;
                }
                throw error;
            }
        })
    );

    app.post(
        "/api/jobs/:id/run",
        asyncRoute(async (req, res) => {
            try {
                const run = await runScheduledJob(String(req.params.id), "manual");
                res.json({ ok: run.status === "success", run });
            } catch (error) {
                res.status(httpStatusCode(error)).json({
                    error: errorMessage(error, "Scheduled job run failed"),
                });
            }
        })
    );
}

export const __testing = {
    httpStatusCode,
    invalidJobsJsonHandler,
    invalidPatchField,
    JOBS_JSON_LIMIT,
};
