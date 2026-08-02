import { parseDockerStackActionRequest } from "../../../../contracts/docker.ts";
import { json } from "../../http/core.ts";
import { outputString, runQueuedDockerAction } from "./mutationExecution.ts";
import { readDockerJson } from "./request.ts";

export async function runStackAction(request: Request): Promise<Response> {
    const body = await readDockerJson(request, parseDockerStackActionRequest);
    if (body instanceof Response) return body;
    const result = await runQueuedDockerAction({
        actionKey: "docker.stack.action",
        displayName: `Docker stack ${body.action}`,
        payload: { action: body.action, service: body.service },
        timeoutMs: 2 * 60 * 1000,
    });
    return json({
        output: outputString(result, "output"),
    });
}

export const dockerStackRoutes = {
    "/api/docker/stack/action": {
        POST: runStackAction,
    },
} as const;
