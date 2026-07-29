import * as v from "valibot";

import {
    finiteNumberSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const sessionTimestampSchema = v.union([finiteNumberSchema, v.string()]);
const sessionFastModeSchema = v.union([v.boolean(), v.literal("auto")]);

export const sessionThinkingLevelSchema = v.object({
    id: trimmedNonEmptyStringSchema,
    label: trimmedNonEmptyStringSchema,
});

/**
 * OpenClaw owns this evolving shape, so known fields are validated while unknown
 * fields are deliberately discarded at the Dashboard trust boundary.
 */
export const sessionSchema = v.object({
    activeRunId: v.optional(v.string()),
    agentType: v.string(),
    channel: v.string(),
    createdAt: v.optional(v.string()),
    currentRunId: v.optional(v.string()),
    displayLabel: v.string(),
    displayName: v.string(),
    effectiveFastMode: v.optional(sessionFastModeSchema),
    elevatedLevel: v.optional(v.string()),
    endedAt: v.optional(sessionTimestampSchema),
    fastMode: v.optional(sessionFastModeSchema),
    hasActiveRun: v.optional(v.boolean()),
    hookName: v.string(),
    id: trimmedNonEmptyStringSchema,
    isRunning: v.optional(v.boolean()),
    key: v.string(),
    kind: v.optional(v.string()),
    label: v.string(),
    maxTokens: finiteNumberSchema,
    model: v.string(),
    modelProvider: v.optional(v.string()),
    reasoningLevel: v.optional(v.string()),
    runId: v.optional(v.string()),
    running: v.optional(v.boolean()),
    sessionId: v.optional(v.string()),
    startedAt: v.optional(sessionTimestampSchema),
    status: v.optional(v.string()),
    thinkingDefault: v.optional(v.string()),
    thinkingLevel: v.optional(v.string()),
    thinkingLevels: v.optional(v.array(sessionThinkingLevelSchema)),
    thinkingOptions: v.optional(v.array(v.string())),
    tokenCount: finiteNumberSchema,
    totalTokensFresh: v.optional(v.boolean()),
    type: trimmedNonEmptyStringSchema,
    updatedAt: v.optional(finiteNumberSchema),
    verboseLevel: v.optional(v.string()),
});

export const sessionListResponseSchema = v.strictObject({
    sessions: v.array(sessionSchema),
});

export const SESSION_ACTIONS = ["compact", "reset", "stop"] as const;
export const sessionActionSchema = v.picklist(SESSION_ACTIONS);

export const sessionActionRequestSchema = strictJsonObjectSchema({
    action: sessionActionSchema,
});

export const sessionActionResponseSchema = v.strictObject({
    action: sessionActionSchema,
    isSuccess: successLiteralSchema,
});

export const sessionDeleteResponseSchema = v.strictObject({
    isSuccess: successLiteralSchema,
    result: v.unknown(),
});

export const sessionStatsSchema = v.strictObject({
    activeInLastHour: finiteNumberSchema,
    byModel: v.record(v.string(), finiteNumberSchema),
    byType: v.record(v.string(), finiteNumberSchema),
    total: finiteNumberSchema,
    totalTokens: finiteNumberSchema,
});

export type SessionThinkingLevel = v.InferOutput<typeof sessionThinkingLevelSchema>;
export type Session = v.InferOutput<typeof sessionSchema>;
export type SessionListResponse = v.InferOutput<typeof sessionListResponseSchema>;
export type SessionAction = v.InferOutput<typeof sessionActionSchema>;
export type SessionActionRequest = v.InferOutput<typeof sessionActionRequestSchema>;
export type SessionActionResponse = v.InferOutput<typeof sessionActionResponseSchema>;
export type SessionDeleteResponse = v.InferOutput<typeof sessionDeleteResponseSchema>;
export type SessionStats = v.InferOutput<typeof sessionStatsSchema>;

/**
 * Parses a session lifecycle action at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed session lifecycle action.
 */
export function parseSessionActionRequest(value: unknown): SessionActionRequest {
    return parseContract(sessionActionRequestSchema, value);
}

/**
 * Parses one normalized Dashboard session at an HTTP or WebSocket boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one normalized Dashboard session at an HTTP or WebSocket boundary.
 */
export function parseSession(value: unknown, path = "session"): Session {
    return parseContract(sessionSchema, value, path);
}

/**
 * Parses a normalized session array at an HTTP or WebSocket boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a normalized session array at an HTTP or WebSocket boundary.
 */
export function parseSessions(value: unknown, path = "sessions"): Session[] {
    return parseContract(v.array(sessionSchema), value, path);
}

export function parseSessionActionResponse(
    value: unknown,
    path = "sessionAction"
): SessionActionResponse {
    return parseContract(sessionActionResponseSchema, value, path);
}

export function parseSessionDeleteResponse(
    value: unknown,
    path = "sessionDelete"
): SessionDeleteResponse {
    return parseContract(sessionDeleteResponseSchema, value, path);
}
