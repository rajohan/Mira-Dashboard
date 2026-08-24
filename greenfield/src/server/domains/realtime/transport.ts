import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    findRealtimeTopicDefinition,
    realtimeStreamOutputSchema,
    type RealtimeStreamOutput,
} from "../../../contracts/events.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import type { RealtimeEventDelivery } from "../../platform/realtime/eventPump.ts";

/**
 * Verifies every requested topic against the authenticated principal.
 * @param principal Validated request principal.
 * @param topics Registered requested topics.
 * @returns The unchanged authorized topic filter.
 */
export function authorizeRealtimeTopics(
    principal: AuthenticatedPrincipal,
    topics: readonly string[]
): readonly string[] {
    for (const topic of topics) {
        const definition = findRealtimeTopicDefinition(topic);
        if (definition === undefined) {
            throw new TRPCError({
                code: "BAD_REQUEST",
                message: "Realtime subscription topic is not registered",
            });
        }
        if (!principal.capabilities.includes(definition.capability)) {
            throw new TRPCError({
                code: "FORBIDDEN",
                message: "Realtime topic access is forbidden",
            });
        }
    }
    return topics;
}

function parsePayload(payloadJson: string, schema: v.GenericSchema): unknown {
    let payload: unknown;
    try {
        payload = JSON.parse(payloadJson) as unknown;
    } catch (error) {
        throw new Error("Realtime event payload is not valid JSON", { cause: error });
    }
    const result = v.safeParse(schema, payload, { abortEarly: true });
    if (!result.success) {
        throw new Error("Realtime event payload violates its topic contract", {
            cause: result.issues,
        });
    }
    return result.output;
}

function realtimeDeliveryData(delivery: RealtimeEventDelivery): unknown {
    if (delivery.kind === "resync-required") {
        return {
            kind: delivery.kind,
            reason: delivery.reason,
        };
    }

    const definition = findRealtimeTopicDefinition(delivery.event.topic);
    if (definition === undefined) {
        throw new Error("Realtime event violates its registered topic contract");
    }

    return {
        event: {
            entityId: delivery.event.entityId,
            entityType: delivery.event.entityType,
            occurredAtMs: delivery.event.occurredAtMs,
            operation: delivery.event.operation,
            payload: parsePayload(delivery.event.payloadJson, definition.payload),
            topic: delivery.event.topic,
        },
        kind: delivery.kind,
    };
}

/**
 * Converts one durable delivery into the exact client-visible tracked envelope.
 * @param delivery Internal pump delivery containing canonical plain JSON.
 * @returns Valibot-validated cursor and topic-specific client data.
 */
export function realtimeDeliveryToStreamOutput(
    delivery: RealtimeEventDelivery
): RealtimeStreamOutput {
    return v.parse(realtimeStreamOutputSchema, {
        data: realtimeDeliveryData(delivery),
        id: delivery.id,
    });
}
