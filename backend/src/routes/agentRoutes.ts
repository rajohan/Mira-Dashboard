import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    buildAgentStatuses,
    buildSingleAgentStatus,
    closeStaleActiveTasks,
    getLatestCompletedTasks,
    isValidAgentId,
    parseAgentsConfig,
    updateAgentCurrentTask,
} from "../services/agents.ts";

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

function agentError(error: unknown, fallback = "Agent route failed"): Response {
    return json(
        { error: errorMessage(error, fallback) },
        { status: httpStatusCode(error) }
    );
}

function missingConfig(): Response {
    return json({ error: "Agent configuration not found" }, { status: 404 });
}

export const agentRoutes = {
    "/api/agents/:id/metadata": {
        PUT: async (request: ParametersRequest<"id">) => {
            const agentId = request.params.id;
            if (!isValidAgentId(agentId)) {
                return json({ error: "Invalid agent ID" }, { status: 400 });
            }
            try {
                const body = await readJson<{ currentTask?: unknown } | null>(request);
                return json(await updateAgentCurrentTask(agentId, body?.currentTask));
            } catch (error) {
                return agentError(error, "Agent metadata update failed");
            }
        },
    },
    "/api/agents/:id/status": {
        GET: async (request: ParametersRequest<"id">) => {
            const agentId = request.params.id;
            if (!isValidAgentId(agentId)) {
                return json({ error: "Invalid agent ID" }, { status: 400 });
            }
            try {
                closeStaleActiveTasks();
                const config = parseAgentsConfig();
                if (!config) return missingConfig();
                const status = await buildSingleAgentStatus(agentId, config);
                if (!status) {
                    return json(
                        { error: `Agent '${agentId}' not found` },
                        { status: 404 }
                    );
                }
                return json(status);
            } catch (error) {
                return agentError(error, "Agent status failed");
            }
        },
    },
    "/api/agents/config": {
        GET: () => {
            try {
                const config = parseAgentsConfig();
                return config ? json(config) : missingConfig();
            } catch (error) {
                return agentError(error, "Agent config failed");
            }
        },
    },
    "/api/agents/status": {
        GET: async () => {
            try {
                closeStaleActiveTasks();
                const config = parseAgentsConfig();
                if (!config) return missingConfig();
                return json({
                    agents: await buildAgentStatuses(config),
                    timestamp: Date.now(),
                });
            } catch (error) {
                return agentError(error, "Agent status failed");
            }
        },
    },
    "/api/agents/tasks/history": {
        GET: (request: Request) => {
            try {
                const query = new URL(request.url).searchParams;
                const rawLimit = query.get("limit");
                const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
                const requestedLimit = Number.isNaN(parsedLimit) ? 8 : parsedLimit;
                const limit = Math.max(1, Math.min(20, requestedLimit));
                closeStaleActiveTasks();
                return json({
                    tasks: getLatestCompletedTasks(limit),
                    timestamp: Date.now(),
                });
            } catch (error) {
                return agentError(error, "Agent task history failed");
            }
        },
    },
} as const;
