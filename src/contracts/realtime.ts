import * as v from "valibot";

import { utf8ByteLength } from "../shared/encoding.ts";
import type { ApplicationCapability } from "./security.ts";

/** Default upper bound for one serialized realtime delivery envelope. */
export const realtimeEventDeliveryMaximumBytes = 8 * 1024;
/** Maximum number of unique topics accepted by one browser subscription. */
export const realtimeSubscriptionMaximumTopics = 64;
/** Canonical upper bound for one durable realtime topic. */
export const realtimeTopicMaximumCharacters = 128;
/** Runtime retention shared by durable producers and client-facing documentation. */
export const realtimeEventRetentionMilliseconds = 7 * 24 * 60 * 60 * 1000;
/** Human-readable form of the reviewed durable retention policy. */
export const realtimeEventRetentionLabel = "7 days";

/** Runtime and documentation metadata for one authorized realtime topic. */
export interface RealtimeTopicDefinition {
    readonly capability: ApplicationCapability;
    readonly entityTypes: readonly string[];
    readonly operations: readonly (
        | "created"
        | "deleted"
        | "snapshot-required"
        | "updated"
    )[];
    readonly payload: v.GenericSchema;
    readonly principalKinds?: readonly ("automation" | "session")[];
    readonly topic: string;
}

/** Canonical topic accepted by durable storage, page filters, and subscriptions. */
export const realtimeTopicSchema = v.pipe(
    v.string("Realtime topic is invalid"),
    v.minLength(1, "Realtime topic is invalid"),
    v.maxLength(realtimeTopicMaximumCharacters, "Realtime topic is invalid"),
    v.regex(/^\S(?:[\s\S]*\S)?$/, "Realtime topic is invalid")
);

export interface RealtimeChangeDeliveryEnvelope {
    readonly event: {
        readonly entityId: string;
        readonly entityType: string;
        readonly occurredAtMs: number;
        readonly operation: "created" | "deleted" | "snapshot-required" | "updated";
        readonly payloadJson: string;
        readonly topic: string;
    };
    readonly id: string;
    readonly kind: "change";
}

/**
 * Returns the exact wire-size budget consumed by one realtime change delivery.
 * @param delivery Delivery envelope to serialize.
 * @returns Encoded plain-JSON byte length.
 */
export function realtimeChangeDeliveryByteLength(
    delivery: RealtimeChangeDeliveryEnvelope
): number {
    return utf8ByteLength(JSON.stringify(delivery));
}
