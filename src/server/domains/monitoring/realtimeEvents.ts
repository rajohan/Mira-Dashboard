import * as v from "valibot";

import {
    findMonitoringRealtimeTopicDefinition,
    monitoringRealtimeRoutingSchema,
    monitoringRealtimeTopics,
} from "../../../contracts/monitoringRealtime.ts";
import type { NormalizedMonitoringProblem } from "./normalization.ts";
import type { MonitoringUnitOfWork, RealtimeEventInsert } from "./repository.ts";
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

/**
 * Appends one validated monitoring invalidation to the current transaction.
 * @param unit Monitoring transaction that owns the related state change.
 * @param input Validated routing, identity, time, and retention metadata.
 */
export function appendMonitoringRealtimeEvent(
    unit: MonitoringUnitOfWork,
    input: Parameters<typeof createRealtimeEvent>[0]
): void {
    unit.insertRealtimeEvent(createRealtimeEvent(input));
}

export function insertRealtimeEvent(
    unit: MonitoringUnitOfWork,
    counts: MutableSubmissionCounts,
    input: Parameters<typeof createRealtimeEvent>[0]
): void {
    appendMonitoringRealtimeEvent(unit, input);
    counts.realtimeEvents += 1;
}

export function insertMonitoringReportNotification(input: {
    counts: MutableSubmissionCounts;
    expiresAt: Date;
    generateId: () => string;
    occurredAt: Date;
    outboxOccurredAt: Date;
    problems: readonly NormalizedMonitoringProblem[];
    incidents: readonly { readonly generation: number; readonly id: string }[];
    reportId: string;
    reportTitle: string;
    source: string;
    unit: MonitoringUnitOfWork;
}): void {
    if (input.problems.length === 0) return;
    const severityOrder = { critical: 4, error: 3, warning: 2, info: 1 } as const;
    const severity = input.problems.toSorted(
        (left, right) => severityOrder[right.severity] - severityOrder[left.severity]
    )[0]!.severity;
    const notification = input.unit.insertNotification({
        channel: "dashboard",
        id: input.generateId(),
        incidentGeneration: null,
        incidentId: null,
        kind: monitoringNotificationKind,
        linkUrl: `/reports?reportId=${encodeURIComponent(input.reportId)}`,
        message: `${input.problems.length} ${input.problems.length === 1 ? "problem" : "problems"} detected.`,
        occurredAt: input.occurredAt,
        reportId: input.reportId,
        severity,
        source: input.source,
        title: input.reportTitle,
    });
    for (const incident of input.incidents) {
        input.unit.insertNotificationIncidentLink({
            incidentGeneration: incident.generation,
            incidentId: incident.id,
            notificationId: notification.id,
        });
    }
    insertRealtimeEvent(input.unit, input.counts, {
        entityId: notification.id,
        entityType: "notification",
        expiresAt: input.expiresAt,
        occurredAt: input.outboxOccurredAt,
        operation: "created",
        topic: monitoringRealtimeTopics.notifications,
    });
}
