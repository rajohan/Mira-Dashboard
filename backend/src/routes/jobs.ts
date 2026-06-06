import express, { type RequestHandler } from "express";

import { asyncRoute as baseAsyncRoute, errorMessage } from "../lib/errors.js";
import {
    getScheduledJob,
    listScheduledJobs,
    runScheduledJob,
    type ScheduledJobScheduleType,
    updateScheduledJob,
} from "../services/scheduledJobs.js";

interface HttpStatusError extends Error {
    statusCode?: number;
}

function httpStatusCode(error: unknown): number {
    return (error as HttpStatusError).statusCode || 500;
}

function asyncRoute(handler: RequestHandler): RequestHandler {
    return baseAsyncRoute(handler, {
        fallback: "Scheduled jobs route failed",
        logLabel: "[jobsRoutes]",
    });
}

const scheduleTypes = new Set<ScheduledJobScheduleType>(["interval", "daily", "cron"]);

function invalidPatchField(patch: Record<string, unknown>): string | null {
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

            const enabled =
                typeof patch.enabled === "boolean" ? patch.enabled : undefined;
            const intervalSeconds =
                typeof patch.intervalSeconds === "number"
                    ? patch.intervalSeconds
                    : undefined;
            const scheduleType =
                patch.scheduleType === "interval" ||
                patch.scheduleType === "daily" ||
                patch.scheduleType === "cron"
                    ? patch.scheduleType
                    : undefined;
            const timeOfDay =
                typeof patch.timeOfDay === "string" || patch.timeOfDay === null
                    ? patch.timeOfDay
                    : undefined;

            const job = updateScheduledJob(String(req.params.id), {
                enabled,
                intervalSeconds,
                scheduleType,
                timeOfDay,
            });
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
