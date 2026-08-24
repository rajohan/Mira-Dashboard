import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { cacheEntryKeySchema } from "./cache.ts";
import { realtimeEventRetentionLabel, type RealtimeTopicDefinition } from "./realtime.ts";
import type { RealtimeEventContract } from "./registry.ts";

/** Durable invalidation topic for provider-owned cache projections. */
export const cacheRealtimeTopic = "cache.entries";

const cacheEntityType = "cache-entry";
const cacheOperations = ["created", "updated"] as const;
const cacheRealtimeRoutingEntries = {
    entityType: v.literal(cacheEntityType),
    operation: v.picklist(cacheOperations),
    topic: v.literal(cacheRealtimeTopic),
};

/** Producer routing accepted for cache-entry outbox writes. */
export const cacheRealtimeRoutingSchema = v.strictObject(cacheRealtimeRoutingEntries);

/** Compact cache invalidation payload; the key must match the envelope entity id. */
export const cacheChangePayloadSchema = v.strictObject({ key: cacheEntryKeySchema });

/** Exact capability, entity, operation, and payload policy for cache invalidations. */
export const cacheRealtimeTopicDefinition = {
    capability: "cache:read",
    entityTypes: [cacheEntityType],
    operations: cacheOperations,
    payload: cacheChangePayloadSchema,
    topic: cacheRealtimeTopic,
} as const satisfies RealtimeTopicDefinition;

/** Standalone cache invalidation topic tied to the bounded status snapshot. */
export const cacheRealtimeEventContract = {
    payload: cacheChangePayloadSchema,
    payloadSchemaId: "cache.entries.realtime.payload",
    retention: realtimeEventRetentionLabel,
    snapshotProcedure: "cache.getStatus",
    summary: "Invalidates one cache projection after a claim-fenced refresh attempt.",
    topic: cacheRealtimeTopic,
} as const satisfies RealtimeEventContract;

/**
 * @param event Compact cache invalidation envelope.
 * @returns Whether routing and payload identities name the same cache entry.
 */
export function cacheRealtimeIdentityMatches(event: {
    readonly entityId: string;
    readonly payload: { readonly key: string };
}): boolean {
    return event.payload.key === event.entityId;
}

const cacheRealtimeChangeObjectSchema = v.strictObject({
    entityId: cacheEntryKeySchema,
    entityType: cacheRealtimeRoutingEntries.entityType,
    occurredAtMs: timestampMillisecondsSchema("Cache realtime timestamp is invalid"),
    operation: cacheRealtimeRoutingEntries.operation,
    payload: cacheChangePayloadSchema,
    topic: cacheRealtimeRoutingEntries.topic,
});
const cacheRealtimeIdentityMessage = "Cache realtime entity identity is inconsistent";

/** Topic-specific client change schema with matching cache identities. */
export const cacheRealtimeChangeSchema = v.pipe(
    cacheRealtimeChangeObjectSchema,
    v.check<
        v.InferOutput<typeof cacheRealtimeChangeObjectSchema>,
        typeof cacheRealtimeIdentityMessage
    >(cacheRealtimeIdentityMatches, cacheRealtimeIdentityMessage)
);
