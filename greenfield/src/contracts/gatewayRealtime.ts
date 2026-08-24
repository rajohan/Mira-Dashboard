import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { realtimeEventRetentionLabel, type RealtimeTopicDefinition } from "./realtime.ts";
import type { RealtimeEventContract } from "./registry.ts";

/** Session-only invalidation topics projected from the native OpenClaw Gateway. */
export const gatewayRealtimeTopics = Object.freeze({
    connection: "gateway.connection",
    cron: "openclaw-cron.records",
    sessions: "gateway.sessions",
});

const gatewayConnectionEntityType = "gateway-connection";
const gatewayCronEntityType = "openclaw-cron";
const gatewaySessionsEntityType = "gateway-sessions";
const gatewaySnapshotOperations = ["snapshot-required"] as const;
const sessionPrincipalKinds = ["session"] as const;

/** Bounded invalidation marker; authoritative Gateway data is always refetched. */
export const gatewaySnapshotRequiredPayloadSchema = v.strictObject({
    kind: v.literal("snapshot-required"),
});

/** Topic-level authorization and stored-event validation policy. */
export const gatewayRealtimeTopicDefinitions = [
    {
        capability: "gateway-sessions:read",
        entityTypes: [gatewayConnectionEntityType],
        operations: gatewaySnapshotOperations,
        payload: gatewaySnapshotRequiredPayloadSchema,
        principalKinds: sessionPrincipalKinds,
        topic: gatewayRealtimeTopics.connection,
    },
    {
        capability: "gateway-sessions:read",
        entityTypes: [gatewaySessionsEntityType],
        operations: gatewaySnapshotOperations,
        payload: gatewaySnapshotRequiredPayloadSchema,
        principalKinds: sessionPrincipalKinds,
        topic: gatewayRealtimeTopics.sessions,
    },
    {
        capability: "jobs:read",
        entityTypes: [gatewayCronEntityType],
        operations: gatewaySnapshotOperations,
        payload: gatewaySnapshotRequiredPayloadSchema,
        principalKinds: sessionPrincipalKinds,
        topic: gatewayRealtimeTopics.cron,
    },
] as const satisfies readonly RealtimeTopicDefinition[];

/** Durable Gateway invalidation documentation tied to strict snapshot queries. */
export const gatewayRealtimeEventContracts = [
    {
        payload: gatewaySnapshotRequiredPayloadSchema,
        payloadSchemaId: "gateway.connection.realtime.payload",
        retention: realtimeEventRetentionLabel,
        snapshotProcedure: "gateway.connection.get",
        summary: "Invalidates the sanitized native Gateway connection projection.",
        topic: gatewayRealtimeTopics.connection,
    },
    {
        payload: gatewaySnapshotRequiredPayloadSchema,
        payloadSchemaId: "gateway.sessions.realtime.payload",
        retention: realtimeEventRetentionLabel,
        snapshotProcedure: "gatewaySessions.list",
        summary: "Invalidates the bounded authoritative Gateway session snapshot.",
        topic: gatewayRealtimeTopics.sessions,
    },
    {
        payload: gatewaySnapshotRequiredPayloadSchema,
        payloadSchemaId: "openclaw-cron.records.realtime.payload",
        retention: realtimeEventRetentionLabel,
        snapshotProcedure: "openClawCron.list",
        summary: "Invalidates the bounded authoritative OpenClaw cron snapshot.",
        topic: gatewayRealtimeTopics.cron,
    },
] as const satisfies readonly RealtimeEventContract[];

const gatewayRealtimeTimestampSchema = timestampMillisecondsSchema(
    "Gateway realtime timestamp is invalid"
);

function gatewayChangeSchema<const EntityType extends string, const Topic extends string>(
    entityType: EntityType,
    topic: Topic
) {
    return v.strictObject({
        entityId: v.literal("current"),
        entityType: v.literal(entityType),
        occurredAtMs: gatewayRealtimeTimestampSchema,
        operation: v.literal("snapshot-required"),
        payload: gatewaySnapshotRequiredPayloadSchema,
        topic: v.literal(topic),
    });
}

/** Client-visible Gateway invalidation variants accepted by the shared SSE stream. */
export const gatewayRealtimeChangeSchemas = [
    gatewayChangeSchema(gatewayConnectionEntityType, gatewayRealtimeTopics.connection),
    gatewayChangeSchema(gatewaySessionsEntityType, gatewayRealtimeTopics.sessions),
    gatewayChangeSchema(gatewayCronEntityType, gatewayRealtimeTopics.cron),
] as const;
