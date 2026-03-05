import express, { type RequestHandler } from "express";

import gateway from "../gateway.js";

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

interface CronListResponse {
    jobs?: CronJob[];
    items?: CronJob[];
}

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

export default function cronRoutes(app: express.Application): void {
    app.get("/api/cron/jobs", (async (_req, res) => {
        try {
            const payload = await gateway.request("cron.list", { includeDisabled: true });
            const jobs = normalizeJobs(payload);
            res.json({ jobs });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/cron/jobs/:id/toggle", express.json(), (async (req, res) => {
        const jobId = req.params.id;
        const enabled = req.body?.enabled;

        if (typeof enabled !== "boolean") {
            res.status(400).json({ error: "enabled must be a boolean" });
            return;
        }

        try {
            await gateway.request("cron.update", {
                jobId,
                patch: { enabled },
            });
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/cron/jobs/:id/update", express.json(), (async (req, res) => {
        const jobId = req.params.id;
        const patch = req.body?.patch;

        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            res.status(400).json({ error: "patch must be an object" });
            return;
        }

        try {
            await gateway.request("cron.update", { jobId, patch });
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/cron/jobs/:id/run", (async (req, res) => {
        const jobId = req.params.id;

        try {
            const payload = await gateway.request("cron.run", { jobId });
            res.json({ ok: true, payload });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
