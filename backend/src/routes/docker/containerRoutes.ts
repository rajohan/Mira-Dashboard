import { type DockerContainersResponse } from "../../../../contracts/docker/inventory.ts";
import { parseDockerContainerActionRequest } from "../../../../contracts/docker/operations.ts";
import { json } from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { isDevelopmentSafeMode } from "../../requestPolicy/evaluator.ts";
import {
    getContainerDetails,
    getContainerLogs,
} from "../../services/docker/inventory.ts";
import { runQueuedDockerAction } from "./mutationExecution.ts";
import {
    dockerIdentifier,
    invalidDockerIdentifier,
    parameters,
    queryNumber,
    readDockerJson,
} from "./request.ts";
import {
    dockerSnapshotJson,
    getDockerContainersSnapshot,
    getDockerStatsSnapshot,
    getIsolatedDockerContainers,
} from "./snapshots.ts";

const MIN_LOG_TAIL = 50;
const MAX_LOG_TAIL = 5000;

export const dockerContainerRoutes = {
    "/api/docker/containers": {
        GET: async (request?: Request) => {
            const mode = isDevelopmentSafeMode() ? "isolated" : "live";
            const response = {
                containers:
                    mode === "isolated"
                        ? getIsolatedDockerContainers()
                        : await getDockerContainersSnapshot(),
                mode,
            } satisfies DockerContainersResponse;
            return dockerSnapshotJson(request, response);
        },
    },
    "/api/docker/containers/stats": {
        GET: async (request?: Request) => {
            const statsRows = await getDockerStatsSnapshot();
            return dockerSnapshotJson(request, {
                stats: statsRows.map((row) => ({
                    blockIO: row.BlockIO,
                    cpu: row.CPUPerc,
                    id: row.ID,
                    memory: row.MemUsage,
                    memoryPercent: row.MemPerc,
                    netIO: row.NetIO,
                    pids: row.PIDs,
                })),
            });
        },
    },
    "/api/docker/containers/:containerId": {
        GET: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const details = await getContainerDetails(containerId);
            return details
                ? json(details)
                : routeFailureResponse({
                      context: "docker",
                      message: "Container not found",
                      status: 404,
                  });
        },
    },
    "/api/docker/containers/:containerId/action": {
        POST: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const body = await readDockerJson(request, parseDockerContainerActionRequest);
            if (body instanceof Response) return body;
            const action = body.action;
            const details = await getContainerDetails(containerId);
            if (!details)
                return routeFailureResponse({
                    context: "docker",
                    message: "Container not found",
                    status: 404,
                });
            await runQueuedDockerAction({
                actionKey: "docker.container.action",
                displayName: `Docker container ${action}`,
                payload: { action, containerId: details.id },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ output: `${action} sent to ${details.name}` });
        },
    },
    "/api/docker/containers/:containerId/logs": {
        GET: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const requestedTail = Math.trunc(queryNumber(request, "tail", 200)) || 200;
            const tail = Math.min(MAX_LOG_TAIL, Math.max(MIN_LOG_TAIL, requestedTail));
            return json({ content: await getContainerLogs(containerId, tail) });
        },
    },
} as const;
