import * as v from "valibot";

import { agentConfigSchema } from "./agents";
import {
    finiteNumberSchema,
    looseJsonObjectSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

export const OPENCLAW_SKILL_SOURCES = ["builtin", "extra", "workspace"] as const;
export const openClawSkillSourceSchema = v.picklist(OPENCLAW_SKILL_SOURCES);

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const modelSelectionSchema = v.looseObject({
    fallbacks: v.optional(v.array(v.string())),
    primary: v.optional(v.string()),
});
const contextSettingsSchema = v.looseObject({
    maxTokens: v.optional(finiteNumberSchema),
    temperature: v.optional(finiteNumberSchema),
});
const agentDefaultsSchema = v.looseObject({
    contextSettings: v.optional(contextSettingsSchema),
    imageGenerationModel: v.optional(modelSelectionSchema),
    imageModel: v.optional(modelSelectionSchema),
    model: v.optional(modelSelectionSchema),
    skills: v.optional(v.array(v.string())),
});
const agentsSchema = v.looseObject({
    contextSettings: v.optional(contextSettingsSchema),
    defaultModel: v.optional(v.string()),
    defaults: v.optional(agentDefaultsSchema),
    fallbacks: v.optional(v.array(v.string())),
    list: v.optional(v.array(agentConfigSchema)),
});
const authSchema = v.looseObject({
    profiles: v.optional(v.record(v.string(), v.unknown())),
});
const channelSchema = v.looseObject({
    allowFrom: v.optional(v.array(v.string())),
    botId: v.optional(v.string()),
    dmPolicy: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    groupPolicy: v.optional(v.string()),
});
const commandsSchema = v.looseObject({
    ownerAllowFrom: v.optional(v.array(v.string())),
    restart: v.optional(v.boolean()),
});
const enabledSchema = v.looseObject({
    enabled: v.optional(v.boolean()),
});
const gatewayAuthSchema = v.looseObject({
    enabled: v.optional(v.boolean()),
    type: v.optional(v.string()),
});
const gatewaySchema = v.looseObject({
    auth: v.optional(gatewayAuthSchema),
    mode: v.optional(v.string()),
    port: v.optional(finiteNumberSchema),
});
const heartbeatSchema = v.looseObject({
    every: v.optional(v.union([finiteNumberSchema, v.string()])),
    target: v.optional(v.string()),
});
const loggingSchema = v.looseObject({
    redactSensitive: v.optional(v.string()),
});
const metaSchema = v.looseObject({
    lastTouchedAt: v.optional(v.string()),
    lastTouchedVersion: v.optional(v.string()),
});
const sessionResetSchema = v.looseObject({
    idleMinutes: v.optional(finiteNumberSchema),
});
const sessionSchema = v.looseObject({
    reset: v.optional(sessionResetSchema),
});
const toolsExecSchema = v.looseObject({
    ask: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    mode: v.optional(v.string()),
    security: v.optional(v.string()),
});
const toolsSessionsSchema = v.looseObject({
    visibility: v.optional(v.string()),
});
const toolsWebProviderSchema = v.looseObject({
    enabled: v.optional(v.boolean()),
    provider: v.optional(v.string()),
});
const toolsWebSchema = v.looseObject({
    fetch: v.optional(enabledSchema),
    search: v.optional(toolsWebProviderSchema),
});
const toolsSchema = v.looseObject({
    agentToAgent: v.optional(enabledSchema),
    elevated: v.optional(enabledSchema),
    exec: v.optional(toolsExecSchema),
    profile: v.optional(v.string()),
    sessions: v.optional(toolsSessionsSchema),
    web: v.optional(toolsWebSchema),
    webSearch: v.optional(toolsWebProviderSchema),
});
const wizardSchema = v.looseObject({
    lastRunAt: v.optional(v.string()),
    lastRunVersion: v.optional(v.string()),
});

/**
 * OpenClaw owns this evolving configuration schema. Known Dashboard fields are
 * validated while unknown external fields remain round-trippable.
 */
export const openClawConfigSchema = v.looseObject({
    __hash: v.optional(trimmedNonEmptyStringSchema),
    __masked: v.optional(v.boolean()),
    agents: v.optional(agentsSchema),
    auth: v.optional(authSchema),
    channels: v.optional(v.record(v.string(), channelSchema)),
    commands: v.optional(commandsSchema),
    gateway: v.optional(gatewaySchema),
    heartbeat: v.optional(heartbeatSchema),
    logging: v.optional(loggingSchema),
    meta: v.optional(metaSchema),
    session: v.optional(sessionSchema),
    tools: v.optional(toolsSchema),
    wizard: v.optional(wizardSchema),
});

export const openClawSkillSchema = v.strictObject({
    description: v.optional(v.string()),
    enabled: v.boolean(),
    name: trimmedNonEmptyStringSchema,
    path: trimmedNonEmptyStringSchema,
    source: openClawSkillSourceSchema,
});

export const openClawSkillsResponseSchema = v.strictObject({
    skills: v.array(openClawSkillSchema),
});

export const openClawConfigUpdateResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    result: v.strictObject({
        hash: v.optional(trimmedNonEmptyStringSchema),
        parsed: v.optional(openClawConfigSchema),
    }),
});

export const openClawConfigBackupResponseSchema = v.strictObject({
    config: openClawConfigSchema,
    createdAt: trimmedNonEmptyStringSchema,
    hash: v.optional(trimmedNonEmptyStringSchema),
});

export const openClawConfigUpdateRequestSchema = looseJsonObjectSchema({
    ...openClawConfigSchema.entries,
    __hash: trimmedNonEmptyStringSchema,
});

export const openClawSkillUpdateRequestSchema = strictJsonObjectSchema({
    __hash: trimmedNonEmptyStringSchema,
    enabled: v.boolean(),
});

export const openClawMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
});

export type OpenClawSkillSource = v.InferOutput<typeof openClawSkillSourceSchema>;
export type OpenClawSkill = v.InferOutput<typeof openClawSkillSchema>;
export type OpenClawConfig = v.InferOutput<typeof openClawConfigSchema>;
export type OpenClawConfigUpdateRequest = v.InferOutput<
    typeof openClawConfigUpdateRequestSchema
>;
export type OpenClawSkillUpdateRequest = v.InferOutput<
    typeof openClawSkillUpdateRequestSchema
>;
export type OpenClawMutationResponse = v.InferOutput<
    typeof openClawMutationResponseSchema
>;
export type OpenClawConfigUpdateResponse = v.InferOutput<
    typeof openClawConfigUpdateResponseSchema
>;
export type OpenClawConfigBackupResponse = v.InferOutput<
    typeof openClawConfigBackupResponseSchema
>;

/**
 * Parses an OpenClaw config update at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed OpenClaw config update.
 */
export function parseOpenClawConfigUpdateRequest(
    value: unknown
): OpenClawConfigUpdateRequest {
    return parseContract(openClawConfigUpdateRequestSchema, value);
}

/**
 * Parses an OpenClaw skill toggle at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed OpenClaw skill toggle.
 */
export function parseOpenClawSkillUpdateRequest(
    value: unknown
): OpenClawSkillUpdateRequest {
    return parseContract(openClawSkillUpdateRequestSchema, value);
}

/**
 * Parses a common OpenClaw mutation result.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed common OpenClaw mutation result.
 */
export function parseOpenClawMutationResponse(
    value: unknown,
    path = "openClawMutation"
): OpenClawMutationResponse {
    return parseContract(openClawMutationResponseSchema, value, path);
}

/**
 * Parses an OpenClaw config object while preserving its externally owned fields.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed an OpenClaw config object while preserving its externally owned fields.
 */
export function parseOpenClawConfig(
    value: unknown,
    path = "openClawConfig"
): OpenClawConfig {
    return parseContract(openClawConfigSchema, value, path);
}

/**
 * Parses the discovered OpenClaw skills list.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the discovered OpenClaw skills list.
 */
export function parseOpenClawSkillsResponse(
    value: unknown,
    path = "skillsResponse"
): { skills: OpenClawSkill[] } {
    return parseContract(openClawSkillsResponseSchema, value, path);
}

/**
 * Parses the result of a config.patch operation.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the result of a config.patch operation.
 */
export function parseOpenClawConfigUpdateResponse(
    value: unknown,
    path = "configUpdate"
): OpenClawConfigUpdateResponse {
    return parseContract(openClawConfigUpdateResponseSchema, value, path);
}

/**
 * Parses an exported OpenClaw config backup.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed an exported OpenClaw config backup.
 */
export function parseOpenClawConfigBackupResponse(
    value: unknown,
    path = "configBackup"
): OpenClawConfigBackupResponse {
    return parseContract(openClawConfigBackupResponseSchema, value, path);
}
