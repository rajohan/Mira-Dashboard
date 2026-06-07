import express, { type RequestHandler } from "express";

import { asyncRoute as baseAsyncRoute, errorMessage } from "../lib/errors.js";
import {
    getScheduledJob,
    listScheduledJobs,
    runScheduledJob,
    type ScheduledJobScheduleType,
    updateScheduledJob,
    validateScheduledJobPatch,
} from "../services/scheduledJobs.js";

interface HttpStatusError extends Error {
    statusCode?: number;
}

function httpStatusCode(error: unknown): number {
    if (typeof error === "object" && error !== null) {
        const statusCode = (error as HttpStatusError).statusCode;
        if (typeof statusCode === "number") {
            return statusCode;
        }
    }
    return 500;
}

function asyncRoute(handler: RequestHandler): RequestHandler {
    return baseAsyncRoute(handler, {
        fallback: "Scheduled jobs route failed",
        logLabel: "[jobsRoutes]",
    });
}

const scheduleTypes = new Set<ScheduledJobScheduleType>(["interval", "daily", "cron"]);
const allowedPatchFields = new Set([
    "enabled",
    "intervalSeconds",
    "scheduleType",
    "timeOfDay",
]);
const validationErrorPattern =
    /intervalSeconds must be an integer >= 60|scheduleType must be interval, daily, or cron|timeOfDay must be HH:mm|cron schedule is not implemented yet/u;

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
        asyncRoute(async (_req, res) => {
            res.json({ jobs: listScheduledJobs() });
        })
    );

    app.get(
        "/api/jobs/:id",
        asyncRoute(async (req, res) => {
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
        express.json(),
        asyncRoute(async (req, res) => {
            const patch = req.body?.patch;
            if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
                res.status(400).json({ error: "patch must be an object" });
                return;
            }
            const invalidField = invalidPatchField(patch as Record<string, unknown>);
            if (invalidField) {
                res.status(400).json({
                    error: `invalid patch field: ${invalidField}`,
                });
                return;
            }
            const existingJob = getScheduledJob(String(req.params.id));
            if (!existingJob) {
                res.status(404).json({ error: "Scheduled job not found" });
                return;
            }
            const semanticError = validateScheduledJobPatch(existingJob, {
                intervalSeconds:
                    typeof patch.intervalSeconds === "number"
                        ? patch.intervalSeconds
                        : undefined,
                scheduleType: patch.scheduleType as ScheduledJobScheduleType | undefined,
                timeOfDay:
                    typeof patch.timeOfDay === "string" || patch.timeOfDay === null
                        ? patch.timeOfDay
                        : undefined,
            });
            if (semanticError) {
                res.status(400).json({ error: semanticError });
                return;
            }

            const enabled =
                typeof patch.enabled === "boolean" ? patch.enabled : undefined;
            const intervalSeconds =
                typeof patch.intervalSeconds === "number"
                    ? patch.intervalSeconds
                    : undefined;
            const scheduleType = patch.scheduleType as
                | ScheduledJobScheduleType
                | undefined;
            const timeOfDay =
                typeof patch.timeOfDay === "string" || patch.timeOfDay === null
                    ? patch.timeOfDay
                    : undefined;

            let job;
            try {
                job = updateScheduledJob(String(req.params.id), {
                    enabled,
                    intervalSeconds,
                    scheduleType,
                    timeOfDay,
                });
            } catch (error) {
                const message = errorMessage(error, "Invalid scheduled job patch");
                if (validationErrorPattern.test(message)) {
                    res.status(400).json({ error: message });
                    return;
                }
                throw error;
            }
            if (!job) {
                res.status(404).json({ error: "Scheduled job not found" });
                return;
            }

            res.json({ ok: true, job });
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
    invalidPatchField,
};
