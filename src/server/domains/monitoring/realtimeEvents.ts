import * as v from "valibot";

import { monitoringChangePayloadSchema } from "../../../contracts/monitoring.ts";
import type { NormalizedMonitoringProblem } from "./normalization.ts";
import type {
    IncidentRecord,
    MonitoringUnitOfWork,
    RealtimeEventInsert,
} from "./repository.ts";
import { serializeMonitoringJsonObject } from "./serialization.ts";

const monitoringNotificationKind = "monitoring.incident";

export const monitoringRealtimeTopics = Object.freeze({
    incidents: "monitoring.incidents",
    notifications: "monitoring.notifications",
    reports: "monitoring.reports",
});

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
    const payload = v.parse(monitoringChangePayloadSchema, { id: input.entityId });
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
