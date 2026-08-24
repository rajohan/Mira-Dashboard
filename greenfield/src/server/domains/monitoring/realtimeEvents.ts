import * as v from "valibot";

import {
    findMonitoringRealtimeTopicDefinition,
    monitoringRealtimeRoutingSchema,
    monitoringRealtimeTopics,
} from "../../../contracts/monitoringRealtime.ts";
import type { NormalizedMonitoringProblem } from "./normalization.ts";
import type {
    IncidentRecord,
    MonitoringUnitOfWork,
    RealtimeEventInsert,
} from "./repository.ts";
import { serializeMonitoringJsonObject } from "./serialization.ts";

const monitoringNotificationKind = "monitoring.incident";

export { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";

export interface MutableSubmissionCounts {
    createdIncidents: number;
    observedIncidents: number;
    reopenedIncidents: number;
    resolvedIncidents: number;
    realtimeEvents: number;
}

function incidentLink(incidentId: string): string {
    return `/incidents?incidentId=${encodeURIComponent(incidentId)}`;
}

function createRealtimeEvent(input: {
    entityId: string;
    entityType: "incident" | "notification" | "report";
    expiresAt: Date;
    occurredAt: Date;
    operation: RealtimeEventInsert["operation"];
    topic: string;
}): RealtimeEventInsert {
    v.parse(monitoringRealtimeRoutingSchema, {
        entityType: input.entityType,
        operation: input.operation,
        topic: input.topic,
    });
    const definition = findMonitoringRealtimeTopicDefinition(input.topic);
    if (definition === undefined) {
        throw new Error("Monitoring realtime event violates its topic contract");
    }
    const payload = v.parse(definition.payload, { id: input.entityId });
    const payloadJson = serializeMonitoringJsonObject(payload);

    return {
        entityId: input.entityId,
        entityType: input.entityType,
        expiresAt: input.expiresAt,
        occurredAt: input.occurredAt,
        operation: input.operation,
        payloadJson,
        topic: input.topic,
    };
}

export function insertRealtimeEvent(
    unit: MonitoringUnitOfWork,
    counts: MutableSubmissionCounts,
    input: Parameters<typeof createRealtimeEvent>[0]
): void {
    unit.insertRealtimeEvent(createRealtimeEvent(input));
    counts.realtimeEvents += 1;
}

export function insertIncidentNotification(input: {
    counts: MutableSubmissionCounts;
    expiresAt: Date;
    generateId: () => string;
    incident: IncidentRecord;
    occurredAt: Date;
    outboxOccurredAt: Date;
    problem: NormalizedMonitoringProblem;
    reportTitle: string;
    unit: MonitoringUnitOfWork;
}): void {
    const notification = input.unit.insertNotification({
        channel: "dashboard",
        id: input.generateId(),
        incidentGeneration: input.incident.generation,
        incidentId: input.incident.id,
        kind: monitoringNotificationKind,
        linkUrl: incidentLink(input.incident.id),
        message: input.problem.title,
        occurredAt: input.occurredAt,
        severity: input.problem.severity,
        title: input.reportTitle,
    });
    insertRealtimeEvent(input.unit, input.counts, {
        entityId: notification.id,
        entityType: "notification",
        expiresAt: input.expiresAt,
        occurredAt: input.outboxOccurredAt,
        operation: "created",
        topic: monitoringRealtimeTopics.notifications,
    });
}
