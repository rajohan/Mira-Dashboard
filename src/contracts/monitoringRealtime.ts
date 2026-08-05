import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { boundedNonBlankStringSchema } from "../shared/validation.ts";
import { monitoringChangePayloadSchema } from "./monitoring.ts";
import type { RealtimeTopicDefinition } from "./realtime.ts";

/** Stable monitoring topics written to the durable realtime outbox. */
export const monitoringRealtimeTopics = Object.freeze({
    incidents: "monitoring.incidents",
    notifications: "monitoring.notifications",
    reports: "monitoring.reports",
});

const incidentEntityType = "incident";
const notificationEntityType = "notification";
const reportEntityType = "report";
const incidentOperations = ["created", "updated"] as const;
const notificationOperations = ["created", "updated"] as const;
const reportOperations = ["created"] as const;
const incidentRoutingEntries = {
    entityType: v.literal(incidentEntityType),
    operation: v.picklist(incidentOperations),
    topic: v.literal(monitoringRealtimeTopics.incidents),
};
const notificationRoutingEntries = {
    entityType: v.literal(notificationEntityType),
    operation: v.picklist(notificationOperations),
    topic: v.literal(monitoringRealtimeTopics.notifications),
};
const reportRoutingEntries = {
    entityType: v.literal(reportEntityType),
    operation: v.literal(reportOperations[0]),
    topic: v.literal(monitoringRealtimeTopics.reports),
};

/** Producer routing metadata accepted by the monitoring realtime journal. */
export const monitoringRealtimeRoutingSchema = v.variant("topic", [
    v.strictObject(incidentRoutingEntries),
    v.strictObject(notificationRoutingEntries),
    v.strictObject(reportRoutingEntries),
]);

/** Topic-specific payload, entity, operation, and capability policies. */
export const monitoringRealtimeTopicDefinitions = [
    {
        capability: "reports:read",
        entityTypes: [incidentEntityType],
        operations: incidentOperations,
        payload: monitoringChangePayloadSchema,
        topic: monitoringRealtimeTopics.incidents,
    },
    {
        capability: "notifications:read",
        entityTypes: [notificationEntityType],
        operations: notificationOperations,
        payload: monitoringChangePayloadSchema,
        topic: monitoringRealtimeTopics.notifications,
    },
    {
        capability: "reports:read",
        entityTypes: [reportEntityType],
        operations: reportOperations,
        payload: monitoringChangePayloadSchema,
        topic: monitoringRealtimeTopics.reports,
    },
] as const satisfies readonly RealtimeTopicDefinition[];

/**
 * Finds one exact monitoring topic policy.
 * @param topic Candidate durable topic.
 * @returns Its registered definition, when present.
 */
export function findMonitoringRealtimeTopicDefinition(topic: string) {
    return monitoringRealtimeTopicDefinitions.find(
        (definition) => definition.topic === topic
    );
}

const realtimeEntityIdSchema = boundedNonBlankStringSchema(
    200,
    "Realtime entity id is invalid"
);
const occurredAtSchema = timestampMillisecondsSchema("Realtime occurredAtMs is invalid");

/** Topic-specific client change schemas built from the same producer policies. */
export const monitoringRealtimeChangeSchemas = [
    v.strictObject({
        entityId: realtimeEntityIdSchema,
        entityType: incidentRoutingEntries.entityType,
        occurredAtMs: occurredAtSchema,
        operation: incidentRoutingEntries.operation,
        payload: monitoringChangePayloadSchema,
        topic: incidentRoutingEntries.topic,
    }),
    v.strictObject({
        entityId: realtimeEntityIdSchema,
        entityType: notificationRoutingEntries.entityType,
        occurredAtMs: occurredAtSchema,
        operation: notificationRoutingEntries.operation,
        payload: monitoringChangePayloadSchema,
        topic: notificationRoutingEntries.topic,
    }),
    v.strictObject({
        entityId: realtimeEntityIdSchema,
        entityType: reportRoutingEntries.entityType,
        occurredAtMs: occurredAtSchema,
        operation: reportRoutingEntries.operation,
        payload: monitoringChangePayloadSchema,
        topic: reportRoutingEntries.topic,
    }),
] as const;
