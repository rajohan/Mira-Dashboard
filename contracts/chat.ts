import * as v from "valibot";

import { canonicalChatEventSchema } from "./chatCanonical";
import {
    nonNegativeIntegerSchema,
    parseContract,
    strictJsonObjectSchema,
} from "./runtime";

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

/** Current Dashboard-owned format for bounded OpenClaw runtime replay snapshots. */
export const OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 2;

export const chatTransportAttachmentSchema = v.strictObject({
    content: v.string(),
    fileName: nonEmptyStringSchema,
    mimeType: nonEmptyStringSchema,
    type: nonEmptyStringSchema,
});

export const chatSendRequestSchema = strictJsonObjectSchema({
    attachments: v.optional(v.array(chatTransportAttachmentSchema)),
    idempotencyKey: v.optional(nonEmptyStringSchema),
    message: v.string(),
    sessionId: v.optional(nonEmptyStringSchema),
    sessionKey: nonEmptyStringSchema,
});

/**
 * OpenClaw owns this response, so the Dashboard validates its known field and
 * deliberately discards provider extensions.
 */
export const chatSendResponseSchema = v.object({
    runId: v.optional(nonEmptyStringSchema),
});

export const chatSessionPreferencesSchema = v.strictObject({
    fastMode: v.optional(v.nullable(v.union([v.boolean(), v.literal("auto")]))),
    model: v.optional(nonEmptyStringSchema),
    thinkingLevel: v.optional(v.nullable(nonEmptyStringSchema)),
    verboseLevel: v.optional(v.literal("full")),
});

export const chatSessionPatchRequestSchema = strictJsonObjectSchema({
    key: nonEmptyStringSchema,
    ...chatSessionPreferencesSchema.entries,
});

export const openClawRuntimeEnvelopeSchema = v.strictObject({
    canonicalEvents: v.array(canonicalChatEventSchema),
    event: v.unknown(),
    payload: v.unknown(),
    runtimeRecordedAt: nonNegativeIntegerSchema,
    runtimeRunAliases: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
    runtimeSequence: nonNegativeIntegerSchema,
    type: v.literal("event"),
});

const sequenceRecordSchema = v.record(v.string(), nonNegativeIntegerSchema);

export const openClawRuntimeSnapshotSchema = v.strictObject({
    acknowledgedRequestIds: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
    completed: v.boolean(),
    events: v.array(openClawRuntimeEnvelopeSchema),
    firstSequenceByRun: v.optional(sequenceRecordSchema),
    interruptedAtByRun: v.optional(sequenceRecordSchema),
    pendingRequestBoundaries: v.optional(sequenceRecordSchema),
    replayScope: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    requestBoundary: v.optional(nonNegativeIntegerSchema),
    runtimeGeneration: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    schemaVersion: v.literal(OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION),
    throughSequence: nonNegativeIntegerSchema,
});

/** A sequenced OpenClaw runtime event retained and forwarded by the Dashboard. */
export type OpenClawRuntimeEnvelope = v.InferOutput<typeof openClawRuntimeEnvelopeSchema>;
export type { CanonicalChatEvent } from "./chatCanonical";

export type OpenClawRuntimeSnapshot = v.InferOutput<typeof openClawRuntimeSnapshotSchema>;
export type ChatTransportAttachment = v.InferOutput<typeof chatTransportAttachmentSchema>;
export type ChatSendRequest = v.InferOutput<typeof chatSendRequestSchema>;
export type ChatSendResponse = v.InferOutput<typeof chatSendResponseSchema>;
export type ChatSessionPreferences = v.InferOutput<typeof chatSessionPreferencesSchema>;
export type ChatSessionPatchRequest = v.InferOutput<typeof chatSessionPatchRequestSchema>;

/**
 * Parses the result returned by OpenClaw's chat.send RPC.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the result returned by OpenClaw's chat.send RPC.
 */
export function parseChatSendResponse(
    value: unknown,
    path = "chatSendResponse"
): ChatSendResponse {
    return parseContract(chatSendResponseSchema, value, path);
}

/**
 * Parses the Dashboard-owned sessions.patch request payload.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the Dashboard-owned sessions.patch request payload.
 */
export function parseChatSessionPatchRequest(
    value: unknown,
    path = "chatSessionPatchRequest"
): ChatSessionPatchRequest {
    return parseContract(chatSessionPatchRequestSchema, value, path);
}

/**
 * Parses one Dashboard-sequenced OpenClaw runtime event.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one Dashboard-sequenced OpenClaw runtime event.
 */
export function parseOpenClawRuntimeEnvelope(
    value: unknown,
    path = "runtimeEvent"
): OpenClawRuntimeEnvelope {
    return parseContract(openClawRuntimeEnvelopeSchema, value, path);
}

/**
 * Parses the bounded runtime replay returned by chat.runtimeSnapshot.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the bounded runtime replay returned by chat.runtimeSnapshot.
 */
export function parseOpenClawRuntimeSnapshot(
    value: unknown,
    path = "runtimeSnapshot"
): OpenClawRuntimeSnapshot {
    return parseContract(openClawRuntimeSnapshotSchema, value, path);
}
