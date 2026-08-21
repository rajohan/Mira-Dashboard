import * as v from "valibot";

import {
    canonicalNonnegativeSafeIntegerStringSchema,
    hasUniqueArrayItems,
} from "../shared/validation.ts";
import {
    agentRealtimeChangeSchema,
    agentRealtimeTopic,
    agentRealtimeTopicDefinition,
} from "./agentRealtime.ts";
import {
    cacheRealtimeChangeSchema,
    cacheRealtimeTopic,
    cacheRealtimeTopicDefinition,
} from "./cacheRealtime.ts";
import {
    chatHistoryRealtimeChangeSchema,
    chatHistoryRealtimeTopic,
    chatHistoryRealtimeTopicDefinition,
    chatRealtimeChangeSchema,
    chatRealtimeTopic,
    chatRealtimeTopicDefinition,
} from "./chatRealtime.ts";
import {
    gatewayRealtimeChangeSchemas,
    gatewayRealtimeTopicDefinitions,
    gatewayRealtimeTopics,
} from "./gatewayRealtime.ts";
import {
    jobRealtimeChangeSchemas,
    jobRealtimeTopicDefinitions,
    jobRealtimeTopics,
} from "./jobRealtime.ts";
import {
    monitoringRealtimeChangeSchemas,
    monitoringRealtimeTopicDefinitions,
    monitoringRealtimeTopics,
} from "./monitoringRealtime.ts";
import {
    openClawTasksRealtimeChangeSchema,
    openClawTasksRealtimeTopic,
    openClawTasksRealtimeTopicDefinition,
} from "./openClawTasksRealtime.ts";
import { realtimeSubscriptionMaximumTopics } from "./realtime.ts";
import type { ProcedureContract } from "./registry.ts";
import type { ApplicationCapability } from "./security.ts";
import {
    taskRealtimeChangeSchema,
    taskRealtimeTopic,
    taskRealtimeTopicDefinition,
} from "./taskRealtime.ts";

/** All topic definitions currently accepted by the realtime transport. */
export const realtimeTopicDefinitions = Object.freeze([
    agentRealtimeTopicDefinition,
    cacheRealtimeTopicDefinition,
    chatHistoryRealtimeTopicDefinition,
    chatRealtimeTopicDefinition,
    ...gatewayRealtimeTopicDefinitions,
    ...jobRealtimeTopicDefinitions,
    ...monitoringRealtimeTopicDefinitions,
    openClawTasksRealtimeTopicDefinition,
    taskRealtimeTopicDefinition,
] as const);

/**
 * Finds one exact durable realtime topic policy.
 * @param topic Candidate durable topic.
 * @returns Its registered definition, when present.
 */
export function findRealtimeTopicDefinition(topic: string) {
    return realtimeTopicDefinitions.find((definition) => definition.topic === topic);
}

/** Exact unique capability vocabulary used by registered realtime topics. */
export const realtimeStreamCapabilities = Object.freeze([
    "agents:read",
    "cache:read",
    "chat:read",
    "gateway-sessions:read",
    "jobs:read",
    "notifications:read",
    "openclaw-tasks:read",
    "reports:read",
    "tasks:read",
] as const satisfies readonly ApplicationCapability[]);

/** Exact registered topic vocabulary accepted by the tracked SSE contract. */
export const realtimeStreamTopics = Object.freeze([
    agentRealtimeTopic,
    cacheRealtimeTopic,
    chatHistoryRealtimeTopic,
    chatRealtimeTopic,
    gatewayRealtimeTopics.connection,
    gatewayRealtimeTopics.cron,
    gatewayRealtimeTopics.sessions,
    jobRealtimeTopics.runs,
    jobRealtimeTopics.schedules,
    monitoringRealtimeTopics.incidents,
    monitoringRealtimeTopics.notifications,
    monitoringRealtimeTopics.reports,
    openClawTasksRealtimeTopic,
    taskRealtimeTopic,
] as const);

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
    // A missing cursor means "attach at the current durable tail". Only an
    // explicit cursor requests replay, which keeps a fresh tab from draining
    // the entire retained outbox before it can observe live changes.
    lastEventId: v.optional(realtimeCursorSchema),
    topics: realtimeStreamTopicsSchema,
});

/** Data inside one tRPC tracked SSE envelope. */
export const realtimeStreamDataSchema = v.variant("kind", [
    v.strictObject({
        event: v.union([
            agentRealtimeChangeSchema,
            cacheRealtimeChangeSchema,
            chatHistoryRealtimeChangeSchema,
            chatRealtimeChangeSchema,
            ...gatewayRealtimeChangeSchemas,
            ...jobRealtimeChangeSchemas,
            ...monitoringRealtimeChangeSchemas,
            openClawTasksRealtimeChangeSchema,
            taskRealtimeChangeSchema,
        ]),
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
        capabilities: realtimeStreamCapabilities,
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
    transport: {
        batching: "adapter-default",
        handler: "long-lived",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

export type RealtimeStreamData = v.InferOutput<typeof realtimeStreamDataSchema>;
export type RealtimeStreamInput = v.InferOutput<typeof realtimeStreamInputSchema>;
export type RealtimeStreamOutput = v.InferOutput<typeof realtimeStreamOutputSchema>;
