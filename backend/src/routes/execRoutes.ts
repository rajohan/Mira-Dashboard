import { json, readJson } from "../http.ts";
import {
    execErrorResponse,
    getExecJob,
    runExecOnce,
    startExecJob,
    stopExecJob,
} from "../services/execJobs.ts";

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

function errorResponse(error: unknown): Response {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    if ([400, 404, 413, 429].includes(statusCode)) {
        return json({ error: (error as Error).message }, { status: statusCode });
    }
    const mapped = execErrorResponse(error);
    return json({ error: mapped.error }, { status: mapped.status });
}

export const execRoutes = {
    "/api/exec": {
        POST: async (request: Request) => {
            try {
                return json(await runExecOnce(await readJson(request)));
            } catch (error) {
                return errorResponse(error);
            }
        },
    },

    "/api/exec/:jobId": {
        GET: (request: ParametersRequest<"jobId">) => {
            try {
                return json(getExecJob(String(request.params.jobId)));
            } catch (error) {
                return errorResponse(error);
            }
        },
    },

    "/api/exec/:jobId/stop": {
        POST: (request: ParametersRequest<"jobId">) => {
            try {
                return json(stopExecJob(String(request.params.jobId)));
            } catch (error) {
                return errorResponse(error);
            }
        },
    },

    "/api/exec/start": {
        POST: async (request: Request) => {
            try {
                return json(startExecJob(await readJson(request)));
            } catch (error) {
                return errorResponse(error);
            }
        },
    },
} as const;
