import * as v from "valibot";

import {
    type AgentConfiguration,
    type AgentDefinition,
    agentConfigurationSchema,
} from "../../../contracts/agentModel.ts";

const configuredAgentsInput = {
    agents: [
        {
            description: "Owns the operator conversation and coordinates work.",
            displayName: "Mira",
            id: "main",
            role: "primary",
        },
        {
            description: "Implements bounded code, debugging, test, and file tasks.",
            displayName: "Coder",
            id: "coder",
            role: "specialist",
        },
        {
            description: "Drafts reviewed operator communication without sending it.",
            displayName: "Communicator",
            id: "communicator",
            role: "specialist",
        },
        {
            description: "Runs bounded system checks and reports operational status.",
            displayName: "Monitor",
            id: "monitor",
            role: "specialist",
        },
        {
            description: "Researches sources, verifies claims, and compares options.",
            displayName: "Researcher",
            id: "researcher",
            role: "specialist",
        },
    ],
} as const;

/** Reviewed Dashboard-owned directory; it does not claim live Gateway availability. */
export const dashboardAgentConfiguration: AgentConfiguration = Object.freeze(
    v.parse(agentConfigurationSchema, configuredAgentsInput)
);

const agentsById = new Map(
    dashboardAgentConfiguration.agents.map((agent) => [agent.id, agent])
);

/**
 * Finds one reviewed agent definition without consulting mutable external config.
 * @param id Stable Dashboard agent identifier.
 * @returns The reviewed definition when configured.
 */
export function findDashboardAgent(id: string): AgentDefinition | undefined {
    return agentsById.get(id);
}
