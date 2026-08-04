import * as v from "valibot";

import { utf8ByteLength } from "../shared/encoding.ts";

/** Default upper bound for one serialized realtime delivery envelope. */
export const realtimeEventDeliveryMaximumBytes = 8 * 1024;
/** Canonical upper bound for one durable realtime topic. */
export const realtimeTopicMaximumCharacters = 128;

/** Canonical topic accepted by durable storage, page filters, and subscriptions. */
export const realtimeTopicSchema = v.pipe(
    v.string("Realtime topic is invalid"),
    v.minLength(1, "Realtime topic is invalid"),
    v.maxLength(realtimeTopicMaximumCharacters, "Realtime topic is invalid"),
    v.check((topic) => topic.trim() === topic, "Realtime topic is invalid")
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
