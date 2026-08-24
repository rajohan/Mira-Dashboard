import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { agentIdSchema } from "./agentModel.ts";
import { realtimeEventRetentionLabel, type RealtimeTopicDefinition } from "./realtime.ts";
import type { RealtimeEventContract } from "./registry.ts";

/** Durable topic carrying compact agent current-task invalidations. */
export const agentRealtimeTopic = "agents.status";

const agentEntityType = "agent";
const agentOperations = ["updated"] as const;

/** Producer routing metadata accepted by agent-domain outbox writes. */
export const agentRealtimeRoutingSchema = v.strictObject({
    entityType: v.literal(agentEntityType),
    operation: v.picklist(agentOperations),
    topic: v.literal(agentRealtimeTopic),
});

/** Compact invalidation payload; clients refetch the authoritative status. */
export const agentChangePayloadSchema = v.strictObject({ id: agentIdSchema });

/** Topic-specific capability, entity, operation, and payload policy. */
export const agentRealtimeTopicDefinition = {
    capability: "agents:read",
    entityTypes: [agentEntityType],
    operations: agentOperations,
    payload: agentChangePayloadSchema,
    topic: agentRealtimeTopic,
} as const satisfies RealtimeTopicDefinition;

/** Standalone agent invalidation topic tied to its authoritative snapshot query. */
export const agentRealtimeEventContract = {
    payload: agentChangePayloadSchema,
    payloadSchemaId: "agents.status.realtime.payload",
    retention: realtimeEventRetentionLabel,
    snapshotProcedure: "agents.listStatuses",
    summary: "Invalidates one agent status row after a durable metadata change.",
    topic: agentRealtimeTopic,
} as const satisfies RealtimeEventContract;

/** Client-visible validated agent status change event. */
export const agentRealtimeChangeSchema = v.strictObject({
    entityId: agentIdSchema,
    entityType: v.literal(agentEntityType),
    occurredAtMs: timestampMillisecondsSchema("Agent realtime timestamp is invalid"),
    operation: v.picklist(agentOperations),
    payload: agentChangePayloadSchema,
    topic: v.literal(agentRealtimeTopic),
});
