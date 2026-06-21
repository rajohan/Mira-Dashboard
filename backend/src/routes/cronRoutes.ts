import gateway from "../gateway.ts";
import { json, readJson } from "../http.ts";
import { httpStatusCode } from "../lib/errors.ts";

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
    return json({ error: fallback }, { status: httpStatusCode(error) });
}

export const cronRoutes = {
    "/api/cron/jobs": {
        GET: async () => {
            try {
                const payload = await gateway.request("cron.list", {
                    includeDisabled: true,
                });
                return json({ jobs: normalizeJobs(payload) });
            } catch (error) {
                return cronError(error, "Failed to list cron jobs");
            }
        },
    },

    "/api/cron/jobs/:id/delete": {
        POST: async (request: ParametersRequest<"id">) => {
            try {
                const payload = await gateway.request("cron.remove", {
                    jobId: request.params.id,
                });
                return json({ isOk: true, payload });
            } catch (error) {
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
                const body = await readJson<{ enabled?: unknown }>(request);
                if (!body || typeof body !== "object" || Array.isArray(body)) {
                    return json(
                        { error: "Request body must be an object" },
                        { status: 400 }
                    );
                }
                if (typeof body.enabled !== "boolean") {
                    return json({ error: "enabled must be a boolean" }, { status: 400 });
                }
                await gateway.request("cron.update", {
                    jobId: request.params.id,
                    patch: { enabled: body.enabled },
                });
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
                await gateway.request("cron.update", { jobId: request.params.id, patch });
                return json({ isOk: true });
            } catch (error) {
                return cronError(error, "Failed to update cron job");
            }
        },
    },
} as const;
