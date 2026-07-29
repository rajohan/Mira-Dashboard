import type {
    AgentsStatusResponse,
    AgentTaskHistoryResponse,
} from "../../../contracts/agents.ts";
import { parseAgentMetadataUpdateRequest } from "../../../contracts/agents.ts";
import { HttpError, json } from "../http.ts";
import { CoalescedSnapshot } from "../lib/coalescedSnapshot.ts";
import {
    type ParametersRequest,
    readApiJsonOrError,
    routeErrorResponse,
    routeFailureResponse,
} from "../routeSupport.ts";
import {
    buildAgentStatuses,
    buildSingleAgentStatus,
    closeStaleActiveTasks,
    getLatestCompletedTasks,
    isValidAgentId,
    parseAgentsConfig,
    updateAgentCurrentTask,
} from "../services/agents.ts";

function agentError(error: unknown, fallback = "Agent route failed"): Response {
    return routeErrorResponse(undefined, error, {
        code: "agent_request_failed",
        context: "agent",
        message: fallback,
    });
}

function missingConfig(): Response {
    return routeFailureResponse({
        context: "agent",
        message: "Agent configuration not found",
        status: 404,
    });
}

const agentStatusesSnapshot = new CoalescedSnapshot<AgentsStatusResponse>({
    freshForMs: 1500,
    load: async () => {
        closeStaleActiveTasks();
        const config = parseAgentsConfig();
        if (!config) throw new HttpError("Agent configuration not found", 404);
        return {
            agents: await buildAgentStatuses(config),
            timestamp: Date.now(),
        } satisfies AgentsStatusResponse;
    },
    name: "openclaw.agent-statuses",
    staleForMs: 5000,
});

export const agentRoutes = {
    "/api/agents/:id/metadata": {
        PUT: async (request: ParametersRequest<"id">) => {
            const agentId = request.params.id;
            if (!isValidAgentId(agentId)) {
                return routeFailureResponse({
                    context: "agent",
                    message: "Invalid agent ID",
                    status: 400,
                });
            }
            try {
                const body = await readApiJsonOrError(
                    request,
                    parseAgentMetadataUpdateRequest,
                    {
                        code: "invalid_agent_metadata",
                        context: "agent.metadata",
                        message: "Invalid agent metadata",
                    }
                );
                if (body instanceof Response) return body;
                try {
                    return json(await updateAgentCurrentTask(agentId, body.currentTask));
                } finally {
                    agentStatusesSnapshot.invalidate();
                }
            } catch (error) {
                return agentError(error, "Agent metadata update failed");
            }
        },
    },
    "/api/agents/:id/status": {
        GET: async (request: ParametersRequest<"id">) => {
            const agentId = request.params.id;
            if (!isValidAgentId(agentId)) {
                return routeFailureResponse({
                    context: "agent",
                    message: "Invalid agent ID",
                    status: 400,
                });
            }
            try {
                closeStaleActiveTasks();
                const config = parseAgentsConfig();
                if (!config) return missingConfig();
                const status = await buildSingleAgentStatus(agentId, config);
                if (!status) {
                    return routeFailureResponse({
                        context: "agent",
                        message: `Agent '${agentId}' not found`,
                        status: 404,
                    });
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
                return json(await agentStatusesSnapshot.read());
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
                const parsedLimit = rawLimit == undefined ? Number.NaN : Number(rawLimit);
                const requestedLimit = Number.isNaN(parsedLimit) ? 8 : parsedLimit;
                const limit = Math.max(1, Math.min(20, Math.floor(requestedLimit)));
                closeStaleActiveTasks();
                return json({
                    tasks: getLatestCompletedTasks(limit),
                    timestamp: Date.now(),
                } satisfies AgentTaskHistoryResponse);
            } catch (error) {
                return agentError(error, "Agent task history failed");
            }
        },
    },
} as const;
