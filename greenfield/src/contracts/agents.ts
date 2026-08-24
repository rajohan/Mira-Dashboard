import * as v from "valibot";

import { hasUniqueArrayItems } from "../shared/validation.ts";
import {
    type AgentStatusProjection,
    type AgentTaskRun,
    agentConfigurationSchema,
    agentIdSchema,
    agentStatusProjectionSchema,
    agentStatusSchema,
    agentTimestampSchema,
    agentTaskRunIdSchema,
    agentTaskRunSchema,
    agentCurrentTaskSchema,
    dashboardAgentMaximum,
} from "./agentModel.ts";
import type { ProcedureContract } from "./registry.ts";

/** Default agent-task history rows returned by one request. */
export const agentTaskHistoryPageDefault = 50;

/** Hard agent-task history budget for one response. */
export const agentTaskHistoryPageMaximum = 100;

export const emptyAgentInputSchema = v.strictObject({});

/** Exact configured-agent lookup request. */
export const getAgentStatusInputSchema = v.strictObject({ id: agentIdSchema });

/** Stable newest-first cursor for durable task-run history. */
export const agentTaskHistoryCursorSchema = v.strictObject({
    id: agentTaskRunIdSchema,
    startedAtMs: agentTimestampSchema,
});

const agentTaskHistoryLimitSchema = v.pipe(
    v.number("Agent task history limit is invalid"),
    v.safeInteger("Agent task history limit is invalid"),
    v.minValue(1, "Agent task history limit is invalid"),
    v.maxValue(
        agentTaskHistoryPageMaximum,
        "Agent task history limit is outside its budget"
    )
);

/** Bounded, optional-agent task history request. */
export const listAgentTaskHistoryInputSchema = v.strictObject({
    agentId: v.optional(agentIdSchema),
    cursor: v.optional(agentTaskHistoryCursorSchema),
    limit: v.optional(agentTaskHistoryLimitSchema, agentTaskHistoryPageDefault),
});

/**
 * Returns whether task-run rows use the canonical newest-first keyset order.
 * @param runs Task-run rows to inspect.
 * @returns Whether the rows use strict descending start time and ID order.
 */
export function newestAgentTaskRunOrderIsStable(runs: AgentTaskRun[]): boolean {
    return runs.every((run, index) => {
        const previous = runs[index - 1];
        return (
            previous === undefined ||
            run.startedAtMs < previous.startedAtMs ||
            (run.startedAtMs === previous.startedAtMs && run.id < previous.id)
        );
    });
}

const agentTaskHistoryRowsSchema = v.pipe(
    v.array(agentTaskRunSchema, "Agent task history is invalid"),
    v.maxLength(agentTaskHistoryPageMaximum, "Agent task history is outside its budget"),
    v.check(newestAgentTaskRunOrderIsStable, "Agent task history order is invalid")
);

const listAgentTaskHistoryResultObjectSchema = v.strictObject({
    nextCursor: v.optional(agentTaskHistoryCursorSchema),
    runs: agentTaskHistoryRowsSchema,
});

type AgentTaskHistoryResultValue = v.InferOutput<
    typeof listAgentTaskHistoryResultObjectSchema
>;

/**
 * Returns whether a continuation cursor identifies the returned final row.
 * @param result Task-history page to inspect.
 * @returns Whether an optional cursor matches the page's final row.
 */
export function agentTaskHistoryCursorIsConsistent(
    result: AgentTaskHistoryResultValue
): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.runs.at(-1);
    return (
        last !== undefined &&
        last.id === result.nextCursor.id &&
        last.startedAtMs === result.nextCursor.startedAtMs
    );
}

/** One bounded task-run history page plus an exact continuation cursor. */
export const listAgentTaskHistoryResultSchema = v.pipe(
    listAgentTaskHistoryResultObjectSchema,
    v.check(
        agentTaskHistoryCursorIsConsistent,
        "Agent task history cursor is inconsistent"
    )
);

/**
 * Returns whether statuses contain unique IDs in canonical code-unit order.
 * @param statuses Agent statuses to inspect.
 * @returns Whether IDs are unique and strictly sorted.
 */
export function canonicalAgentStatuses(statuses: AgentStatusProjection[]): boolean {
    return (
        hasUniqueArrayItems(statuses.map(({ agentId }) => agentId)) &&
        statuses.every((status, index) => {
            const previous = statuses[index - 1];
            return previous === undefined || status.agentId > previous.agentId;
        })
    );
}

/** Complete operational projection for every configured agent. */
export const listAgentStatusesResultSchema = v.strictObject({
    statuses: v.pipe(
        v.array(agentStatusProjectionSchema, "Agent statuses are invalid"),
        v.minLength(1, "Agent statuses cannot be empty"),
        v.maxLength(dashboardAgentMaximum, "Agent statuses are outside their budget"),
        v.check(canonicalAgentStatuses, "Agent statuses are not canonical")
    ),
});

/** Scoped current-task update; null explicitly clears the active task. */
export const updateAgentMetadataInputSchema = v.strictObject({
    agentId: agentIdSchema,
    currentTask: v.nullable(agentCurrentTaskSchema),
});

const agentReadAccess = {
    capabilities: ["agents:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const agentGatewayStatusReadAccess = {
    capabilities: ["agents:read", "gateway-sessions:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const agentWriteAccess = {
    capabilities: ["agents:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["automation"],
} as const;
const agentQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const agentMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;

/** Implemented Dashboard-owned agent status and task-history procedure metadata. */
export const agentProcedureContracts = [
    {
        access: agentReadAccess,
        domain: "agents",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: emptyAgentInputSchema,
        inputSchemaId: "agents.getConfiguration.input",
        kind: "query",
        name: "agents.getConfiguration",
        output: agentConfigurationSchema,
        outputSchemaId: "agents.getConfiguration.output",
        summary: "Returns the reviewed Dashboard-owned agent directory.",
        transport: agentQueryTransport,
    },
    {
        access: agentGatewayStatusReadAccess,
        domain: "agents",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: getAgentStatusInputSchema,
        inputSchemaId: "agents.getStatus.input",
        kind: "query",
        name: "agents.getStatus",
        output: agentStatusProjectionSchema,
        outputSchemaId: "agents.getStatus.output",
        summary:
            "Returns Dashboard task state and separate Gateway session availability for one configured agent.",
        transport: agentQueryTransport,
    },
    {
        access: agentGatewayStatusReadAccess,
        domain: "agents",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: emptyAgentInputSchema,
        inputSchemaId: "agents.listStatuses.input",
        kind: "query",
        name: "agents.listStatuses",
        output: listAgentStatusesResultSchema,
        outputSchemaId: "agents.listStatuses.output",
        summary:
            "Returns Dashboard task state and separate Gateway session availability for all configured agents.",
        transport: agentQueryTransport,
    },
    {
        access: agentReadAccess,
        domain: "agents",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: listAgentTaskHistoryInputSchema,
        inputSchemaId: "agents.listTaskHistory.input",
        kind: "query",
        name: "agents.listTaskHistory",
        output: listAgentTaskHistoryResultSchema,
        outputSchemaId: "agents.listTaskHistory.output",
        summary: "Lists durable newest-first agent current-task history.",
        transport: agentQueryTransport,
    },
    {
        access: agentWriteAccess,
        domain: "agents",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: updateAgentMetadataInputSchema,
        inputSchemaId: "agents.updateMetadata.input",
        kind: "mutation",
        name: "agents.updateMetadata",
        output: agentStatusSchema,
        outputSchemaId: "agents.updateMetadata.output",
        summary:
            "Atomically starts, touches, replaces, or clears one agent current task.",
        transport: agentMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type GetAgentStatusInput = v.InferOutput<typeof getAgentStatusInputSchema>;
export type ListAgentTaskHistoryInput = v.InferOutput<
    typeof listAgentTaskHistoryInputSchema
>;
export type ListAgentTaskHistoryResult = v.InferOutput<
    typeof listAgentTaskHistoryResultSchema
>;
export type ListAgentStatusesResult = v.InferOutput<typeof listAgentStatusesResultSchema>;
export type UpdateAgentMetadataInput = v.InferOutput<
    typeof updateAgentMetadataInputSchema
>;
