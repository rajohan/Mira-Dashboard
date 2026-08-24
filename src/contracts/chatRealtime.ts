import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { realtimeEventRetentionLabel, type RealtimeTopicDefinition } from "./realtime.ts";
import type { RealtimeEventContract } from "./registry.ts";

export const chatRealtimeTopic = "chat.runtime" as const;
export const chatHistoryRealtimeTopic = "chat.history" as const;

/** Payload-free durable marker: runtime content is read only through cursor queries. */
export const chatRuntimeSnapshotRequiredPayloadSchema = v.strictObject({
    kind: v.literal("snapshot-required"),
});

export const chatRealtimeTopicDefinition = {
    capability: "chat:read",
    entityTypes: ["chat-runtime"],
    operations: ["snapshot-required"],
    payload: chatRuntimeSnapshotRequiredPayloadSchema,
    topic: chatRealtimeTopic,
} as const satisfies RealtimeTopicDefinition;

export const chatRealtimeEventContract = {
    payload: chatRuntimeSnapshotRequiredPayloadSchema,
    payloadSchemaId: "chat.runtime.realtime.payload",
    retention: realtimeEventRetentionLabel,
    snapshotProcedure: "chat.runtime",
    summary: "Advances the cursor for the bounded durable chat runtime snapshot.",
    topic: chatRealtimeTopic,
} as const satisfies RealtimeEventContract;

export const chatHistoryRealtimeTopicDefinition = {
    capability: "chat:read",
    entityTypes: ["chat-history"],
    operations: ["snapshot-required"],
    payload: chatRuntimeSnapshotRequiredPayloadSchema,
    topic: chatHistoryRealtimeTopic,
} as const satisfies RealtimeTopicDefinition;

export const chatHistoryRealtimeEventContract = {
    payload: chatRuntimeSnapshotRequiredPayloadSchema,
    payloadSchemaId: "chat.history.realtime.payload",
    retention: realtimeEventRetentionLabel,
    snapshotProcedure: "chat.history",
    summary:
        "Invalidates canonical chat history after provider-origin terminal activity.",
    topic: chatHistoryRealtimeTopic,
} as const satisfies RealtimeEventContract;

export const chatRealtimeRoutingSchema = v.strictObject({
    entityType: v.literal("chat-runtime"),
    operation: v.literal("snapshot-required"),
    topic: v.literal(chatRealtimeTopic),
});

export const chatRealtimeChangeSchema = v.strictObject({
    entityId: v.literal("current"),
    entityType: v.literal("chat-runtime"),
    occurredAtMs: timestampMillisecondsSchema("Chat realtime timestamp is invalid"),
    operation: v.literal("snapshot-required"),
    payload: chatRuntimeSnapshotRequiredPayloadSchema,
    topic: v.literal(chatRealtimeTopic),
});

export const chatHistoryRealtimeRoutingSchema = v.strictObject({
    entityType: v.literal("chat-history"),
    operation: v.literal("snapshot-required"),
    topic: v.literal(chatHistoryRealtimeTopic),
});

export const chatHistoryRealtimeChangeSchema = v.strictObject({
    entityId: v.literal("current"),
    entityType: v.literal("chat-history"),
    occurredAtMs: timestampMillisecondsSchema(
        "Chat history realtime timestamp is invalid"
    ),
    operation: v.literal("snapshot-required"),
    payload: chatRuntimeSnapshotRequiredPayloadSchema,
    topic: v.literal(chatHistoryRealtimeTopic),
});
