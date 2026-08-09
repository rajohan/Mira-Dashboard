import { TRPCError } from "@trpc/server";
import { Effect } from "effect";

import {
    agentConfigurationSchema,
    agentStatusProjectionSchema,
    agentStatusSchema,
} from "../../../contracts/agentModel.ts";
import {
    getAgentStatusInputSchema,
    emptyAgentInputSchema,
    listAgentStatusesResultSchema,
    listAgentTaskHistoryInputSchema,
    listAgentTaskHistoryResultSchema,
    updateAgentMetadataInputSchema,
} from "../../../contracts/agents.ts";
import { capabilityProcedure, principalKindProcedure } from "../../trpc/trpc.ts";
import { AgentNotFoundError } from "./errors.ts";

async function runAgentEffect<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    try {
        return await Effect.runPromise(effect);
    } catch (error) {
        if (error instanceof AgentNotFoundError) {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Agent resource was not found",
            });
        }
        throw error;
    }
}

const readProcedure = capabilityProcedure("agents:read");
const writeProcedure = principalKindProcedure(
    "agents:write",
    "automation",
    "An automation principal is required"
);

/** Capability-scoped Dashboard agent status and task-history routes. */
export const agentRoutes = {
    getConfiguration: readProcedure
        .input(emptyAgentInputSchema)
        .output(agentConfigurationSchema)
        .query(async ({ ctx }) => {
            const configuration = await runAgentEffect(
                ctx.agentService.getConfiguration()
            );
            return { agents: configuration.agents.map((agent) => ({ ...agent })) };
        }),
    getStatus: readProcedure
        .input(getAgentStatusInputSchema)
        .output(agentStatusProjectionSchema)
        .query(({ ctx, input, signal }) =>
            runAgentEffect(ctx.agentService.getStatus(input, signal))
        ),
    listStatuses: readProcedure
        .input(emptyAgentInputSchema)
        .output(listAgentStatusesResultSchema)
        .query(({ ctx, signal }) =>
            runAgentEffect(ctx.agentService.listStatuses(signal))
        ),
    listTaskHistory: readProcedure
        .input(listAgentTaskHistoryInputSchema)
        .output(listAgentTaskHistoryResultSchema)
        .query(({ ctx, input }) =>
            runAgentEffect(ctx.agentService.listTaskHistory(input))
        ),
    updateMetadata: writeProcedure
        .input(updateAgentMetadataInputSchema)
        .output(agentStatusSchema)
        .mutation(({ ctx, input }) =>
            runAgentEffect(ctx.agentService.updateMetadata(ctx.principal, input))
        ),
};
