import * as v from "valibot";

import { finiteNumberSchema, parseContract, strictJsonObjectSchema } from "./runtime";

export const AGENT_LIFECYCLE_STATUSES = [
    "active",
    "thinking",
    "idle",
    "offline",
] as const;
export const agentLifecycleStatusSchema = v.picklist(AGENT_LIFECYCLE_STATUSES);

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const currentTaskSchema = v.pipe(
    trimmedNonEmptyStringSchema,
    v.transform((value) => value.slice(0, 100))
);

export const agentSchema = v.strictObject({
    channel: v.optional(v.string()),
    currentActivity: v.optional(v.string()),
    currentTask: v.optional(v.string()),
    id: trimmedNonEmptyStringSchema,
    lastActivity: v.optional(v.string()),
    model: v.string(),
    sessionKey: v.optional(v.string()),
    status: agentLifecycleStatusSchema,
});

export const agentTaskHistoryItemSchema = v.strictObject({
    agentId: trimmedNonEmptyStringSchema,
    completedAt: v.optional(trimmedNonEmptyStringSchema),
    id: finiteNumberSchema,
    lastActivityAt: trimmedNonEmptyStringSchema,
    startedAt: trimmedNonEmptyStringSchema,
    status: trimmedNonEmptyStringSchema,
    task: v.string(),
});

export const agentModelConfigSchema = v.object({
    fallbacks: v.optional(v.array(v.string())),
    primary: v.optional(trimmedNonEmptyStringSchema),
});

const agentToolsSchema = v.object({
    allow: v.optional(v.array(v.string())),
    alsoAllow: v.optional(v.array(v.string())),
    deny: v.optional(v.array(v.string())),
    profile: v.optional(trimmedNonEmptyStringSchema),
});

export const agentConfigSchema = v.looseObject({
    default: v.optional(v.boolean()),
    id: trimmedNonEmptyStringSchema,
    model: v.optional(agentModelConfigSchema),
    name: v.optional(v.string()),
    skills: v.optional(v.array(v.string())),
    subagents: v.optional(
        v.object({
            allowAgents: v.optional(v.array(v.string())),
        })
    ),
    tools: v.optional(agentToolsSchema),
});

const configuredModelSchema = v.object({
    alias: v.optional(trimmedNonEmptyStringSchema),
});

export const agentsConfigSchema = v.strictObject({
    defaults: v.object({
        model: v.optional(agentModelConfigSchema),
        models: v.optional(v.record(v.string(), configuredModelSchema)),
    }),
    list: v.array(agentConfigSchema),
});

export const agentsStatusResponseSchema = v.strictObject({
    agents: v.array(agentSchema),
    timestamp: finiteNumberSchema,
});

export const agentTaskHistoryResponseSchema = v.strictObject({
    tasks: v.array(agentTaskHistoryItemSchema),
    timestamp: finiteNumberSchema,
});

export const agentMetadataUpdateRequestSchema = strictJsonObjectSchema({
    currentTask: currentTaskSchema,
});

export const agentMetadataSchema = v.strictObject({
    currentTask: v.optional(v.string()),
    updatedAt: v.optional(v.string()),
});

/** Agent descriptor emitted by the OpenClaw Gateway WebSocket. */
export const gatewayAgentInfoSchema = v.object({
    id: trimmedNonEmptyStringSchema,
    model: v.optional(v.string()),
    name: v.string(),
    status: v.optional(v.string()),
});

export type AgentLifecycleStatus = v.InferOutput<typeof agentLifecycleStatusSchema>;
export type Agent = v.InferOutput<typeof agentSchema>;
export type AgentTaskHistoryItem = v.InferOutput<typeof agentTaskHistoryItemSchema>;
export type AgentModelConfig = v.InferOutput<typeof agentModelConfigSchema>;
export type AgentConfig = v.InferOutput<typeof agentConfigSchema>;
export type AgentsConfig = v.InferOutput<typeof agentsConfigSchema>;
export type AgentsStatusResponse = v.InferOutput<typeof agentsStatusResponseSchema>;
export type AgentTaskHistoryResponse = v.InferOutput<
    typeof agentTaskHistoryResponseSchema
>;
export type AgentMetadataUpdateRequest = v.InferOutput<
    typeof agentMetadataUpdateRequestSchema
>;
export type AgentMetadata = v.InferOutput<typeof agentMetadataSchema>;
export type GatewayAgentInfo = v.InferOutput<typeof gatewayAgentInfoSchema>;

/**
 * Parses an agent current-task update at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed agent current-task update.
 */
export function parseAgentMetadataUpdateRequest(
    value: unknown
): AgentMetadataUpdateRequest {
    return parseContract(agentMetadataUpdateRequestSchema, value);
}

/**
 * Parses one Gateway agent descriptor at the WebSocket trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one Gateway agent descriptor at the WebSocket trust boundary.
 */
export function parseGatewayAgentInfo(value: unknown, path = "agent"): GatewayAgentInfo {
    return parseContract(gatewayAgentInfoSchema, value, path);
}

/**
 * Parses the Gateway agents event payload at the WebSocket trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the Gateway agents event payload at the WebSocket trust boundary.
 */
export function parseGatewayAgentInfos(
    value: unknown,
    path = "agents"
): GatewayAgentInfo[] {
    return parseContract(v.array(gatewayAgentInfoSchema), value, path);
}

/**
 * Parses one Dashboard agent status.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one Dashboard agent status.
 */
export function parseAgent(value: unknown, path = "agent"): Agent {
    return parseContract(agentSchema, value, path);
}

/**
 * Parses the Dashboard agent-status collection.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the Dashboard agent-status collection.
 */
export function parseAgentsStatusResponse(
    value: unknown,
    path = "agentsStatus"
): AgentsStatusResponse {
    return parseContract(agentsStatusResponseSchema, value, path);
}

/**
 * Parses the Dashboard agent configuration projection.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the Dashboard agent configuration projection.
 */
export function parseAgentsConfig(value: unknown, path = "agentsConfig"): AgentsConfig {
    return parseContract(agentsConfigSchema, value, path);
}

/**
 * Parses the recent task history for agents.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the recent task history for agents.
 */
export function parseAgentTaskHistoryResponse(
    value: unknown,
    path = "agentTaskHistory"
): AgentTaskHistoryResponse {
    return parseContract(agentTaskHistoryResponseSchema, value, path);
}
