import { Effect } from "effect";

import type { AgentStatus } from "../../../../contracts/agentModel.ts";
import { dashboardAgentConfiguration, findDashboardAgent } from "../directory.ts";
import { AgentNotFoundError } from "../errors.ts";
import { AgentService } from "../service.ts";

function missingAgent(agentId: string): AgentNotFoundError {
    return new AgentNotFoundError({ agentId, message: "Agent was not found" });
}

function testStatus(agentId: string, currentTask: string | null): AgentStatus {
    if (currentTask === null) return { agentId, state: "idle" };
    return {
        agentId,
        currentTask,
        lastActivityAtMs: 0,
        startedAtMs: 0,
        state: "working",
    };
}

/**
 * Creates a deterministic non-persistent service for unrelated context/router tests.
 * @returns Inert agent service with reviewed configuration and idle statuses.
 */
export function createTestAgentService(): AgentService["Service"] {
    return AgentService.of({
        getConfiguration: () => Effect.succeed(dashboardAgentConfiguration),
        getStatus: ({ id }) =>
            findDashboardAgent(id) === undefined
                ? Effect.fail(missingAgent(id))
                : Effect.succeed({ agentId: id, state: "idle" }),
        listStatuses: () =>
            Effect.succeed({
                statuses: dashboardAgentConfiguration.agents.map(({ id }) => ({
                    agentId: id,
                    state: "idle" as const,
                })),
            }),
        listTaskHistory: ({ agentId }) =>
            agentId !== undefined && findDashboardAgent(agentId) === undefined
                ? Effect.fail(missingAgent(agentId))
                : Effect.succeed({ runs: [] }),
        updateMetadata: (_principal, input) =>
            findDashboardAgent(input.agentId) === undefined
                ? Effect.fail(missingAgent(input.agentId))
                : Effect.succeed(testStatus(input.agentId, input.currentTask)),
    });
}
