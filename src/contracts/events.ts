import * as v from "valibot";

import {
    canonicalNonnegativeSafeIntegerStringSchema,
    hasUniqueArrayItems,
} from "../shared/validation.ts";
import {
    monitoringRealtimeChangeSchemas,
    monitoringRealtimeTopics,
} from "./monitoringRealtime.ts";
import { realtimeSubscriptionMaximumTopics } from "./realtime.ts";
import type { ProcedureContract } from "./registry.ts";
import { applicationCapabilities } from "./security.ts";

/** All topic definitions currently accepted by the realtime transport. */
export {
    findMonitoringRealtimeTopicDefinition as findRealtimeTopicDefinition,
    monitoringRealtimeTopicDefinitions as realtimeTopicDefinitions,
} from "./monitoringRealtime.ts";

const realtimeStreamTopics = [
    monitoringRealtimeTopics.incidents,
    monitoringRealtimeTopics.notifications,
    monitoringRealtimeTopics.reports,
] as const;

const realtimeCursorSchema = canonicalNonnegativeSafeIntegerStringSchema(
    "Realtime resume cursor is invalid"
);

const realtimeStreamTopicsSchema = v.pipe(
    v.array(
        v.picklist(realtimeStreamTopics, "Realtime subscription topic is not registered"),
        "Realtime subscription topics are invalid"
    ),
    v.minLength(1, "Realtime subscription topics cannot be empty"),
    v.maxLength(
        realtimeSubscriptionMaximumTopics,
        "Realtime subscription topic count is outside its budget"
    ),
    v.check(
        hasUniqueArrayItems<(typeof realtimeStreamTopics)[number]>,
        "Realtime subscription topics must be unique"
    ),
    v.transform((topics) => Object.freeze([...topics]))
);

/** Input accepted by the authenticated tracked-SSE procedure. */
export const realtimeStreamInputSchema = v.strictObject({
    lastEventId: v.optional(realtimeCursorSchema, "0"),
    topics: realtimeStreamTopicsSchema,
});

/** Data inside one tRPC tracked SSE envelope. */
export const realtimeStreamDataSchema = v.variant("kind", [
    v.strictObject({
        event: v.variant("topic", monitoringRealtimeChangeSchemas),
        kind: v.literal("change"),
    }),
    v.strictObject({
        kind: v.literal("resync-required"),
        reason: v.literal("cursor-outside-retention"),
    }),
]);

/** Client-visible shape produced by tRPC's tracked SSE helper. */
export const realtimeStreamOutputSchema = v.strictObject({
    data: realtimeStreamDataSchema,
    id: realtimeCursorSchema,
});

/** Authenticated resumable realtime stream contract. */
export const eventsStreamContract = {
    access: {
        capabilities: applicationCapabilities,
        capabilityPolicy: "per-topic",
        kind: "authenticated",
    },
    domain: "events",
    errors: [
        "BAD_REQUEST",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    input: realtimeStreamInputSchema,
    inputSchemaId: "events.stream.input",
    kind: "subscription",
    name: "events.stream",
    output: realtimeStreamOutputSchema,
    outputSchemaId: "events.stream.output",
    summary: "Streams authorized durable changes with tracked resume cursors.",
} as const satisfies ProcedureContract;

export type RealtimeStreamData = v.InferOutput<typeof realtimeStreamDataSchema>;
export type RealtimeStreamInput = v.InferOutput<typeof realtimeStreamInputSchema>;
export type RealtimeStreamOutput = v.InferOutput<typeof realtimeStreamOutputSchema>;
