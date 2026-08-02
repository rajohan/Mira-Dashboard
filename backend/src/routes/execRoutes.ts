import { parseExecRequest } from "../../../contracts/exec.ts";
import { apiErrorResponse } from "../http/apiErrors.ts";
import { json } from "../http/core.ts";
import { type ParametersRequest, readApiJson } from "../http/routeSupport.ts";
import {
    execErrorResponse,
    getExecJob,
    runExecOnce,
    startExecJob,
    stopExecJob,
} from "../services/execJobs.ts";

function errorResponse(request: Request, error: unknown): Response {
    return apiErrorResponse(request, execErrorResponse(error), "exec");
}

export const execRoutes = {
    "/api/exec": {
        POST: async (request: Request) => {
            try {
                return json(
                    await runExecOnce(await readApiJson(request, parseExecRequest))
                );
            } catch (error) {
                return errorResponse(request, error);
            }
        },
    },

    "/api/exec/:jobId": {
        GET: (request: ParametersRequest<"jobId">) => {
            try {
                return json(getExecJob(String(request.params.jobId)));
            } catch (error) {
                return errorResponse(request, error);
            }
        },
    },

    "/api/exec/:jobId/stop": {
        POST: (request: ParametersRequest<"jobId">) => {
            try {
                return json(stopExecJob(String(request.params.jobId)));
            } catch (error) {
                return errorResponse(request, error);
            }
        },
    },

    "/api/exec/start": {
        POST: async (request: Request) => {
            try {
                return json(startExecJob(await readApiJson(request, parseExecRequest)));
            } catch (error) {
                return errorResponse(request, error);
            }
        },
    },
} as const;
