import express, { type RequestHandler } from "express";

import gateway from "../gateway.ts";
import { httpStatusCode } from "../lib/errors.ts";

/** Represents cron job. */
interface CronJob {
    id?: string;
    jobId?: string;
    name?: string;
    enabled?: boolean;
    schedule?: { kind?: string; [key: string]: unknown };
    payload?: { kind?: string; [key: string]: unknown };
    delivery?: { mode?: string; [key: string]: unknown };
    [key: string]: unknown;
}

/** Represents the cron list API response. */
interface CronListResponse {
    jobs?: CronJob[];
    items?: CronJob[];
}

/** Normalizes jobs. */
function normalizeJobs(payload: unknown): CronJob[] {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    const value = payload as CronListResponse;
    if (Array.isArray(value.jobs)) {
        return value.jobs;
    }

    if (Array.isArray(value.items)) {
        return value.items;
    }

    return [];
}

function handleCronError(
    response: express.Response,
    error: unknown,
    fallback = "Cron request failed"
): void {
    response.status(httpStatusCode(error)).json({ error: fallback });
}

/** Registers cron API routes. */
export default function cronRoutes(app: express.Application): void {
    app.get("/api/cron/jobs", (async (_request, response) => {
        try {
            const payload = await gateway.request("cron.list", { includeDisabled: true });
            const jobs = normalizeJobs(payload);
            response.json({ jobs });
        } catch (error) {
            handleCronError(response, error, "Failed to list cron jobs");
        }
    }) as RequestHandler);

    app.post("/api/cron/jobs/:id/toggle", express.json(), (async (request, response) => {
        const jobId = request.params.id;
        const enabled = request.body?.enabled;

        if (typeof enabled !== "boolean") {
            response.status(400).json({ error: "enabled must be a boolean" });
            return;
        }

        try {
            await gateway.request("cron.update", {
                jobId,
                patch: { enabled },
            });
            response.json({ isOk: true });
        } catch (error) {
            handleCronError(response, error, "Failed to toggle cron job");
        }
    }) as RequestHandler);

    app.post("/api/cron/jobs/:id/update", express.json(), (async (request, response) => {
        const jobId = request.params.id;
        const patch = request.body?.patch;

        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            response.status(400).json({ error: "patch must be an object" });
            return;
        }

        try {
            await gateway.request("cron.update", { jobId, patch });
            response.json({ isOk: true });
        } catch (error) {
            handleCronError(response, error, "Failed to update cron job");
        }
    }) as RequestHandler);

    app.post("/api/cron/jobs/:id/run", (async (request, response) => {
        const jobId = request.params.id;

        try {
            const payload = await gateway.request("cron.run", { jobId });
            response.json({ isOk: true, payload });
        } catch (error) {
            handleCronError(response, error, "Failed to run cron job");
        }
    }) as RequestHandler);

    app.post("/api/cron/jobs/:id/delete", (async (request, response) => {
        const jobId = request.params.id;

        try {
            const payload = await gateway.request("cron.remove", { jobId });
            response.json({ isOk: true, payload });
        } catch (error) {
            handleCronError(response, error, "Failed to delete cron job");
        }
    }) as RequestHandler);
}
