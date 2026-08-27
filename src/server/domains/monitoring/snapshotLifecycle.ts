import type {
    NormalizedMonitoringProblem,
    NormalizedMonitoringSnapshot,
} from "./normalization.ts";
import {
    insertMonitoringReportNotification,
    insertRealtimeEvent,
    monitoringRealtimeTopics,
    type MutableSubmissionCounts,
} from "./realtimeEvents.ts";
import type { IncidentRecord, MonitoringUnitOfWork } from "./repository.ts";
import { serializeMonitoringJsonObject } from "./serialization.ts";

function insertObservation(
    unit: MonitoringUnitOfWork,
    runId: string,
    incident: IncidentRecord,
    problem: NormalizedMonitoringProblem,
    observedAt: Date
): void {
    unit.insertObservation({
        detailsJson: serializeMonitoringJsonObject(problem.details),
        generation: incident.generation,
        incidentId: incident.id,
        kind: problem.kind,
        monitorRunId: runId,
        observedAt,
        severity: problem.severity,
        title: problem.title,
    });
}

export function applyMonitoringSnapshotLifecycle(input: {
    counts: MutableSubmissionCounts;
    expiresAt: Date;
    generateId: () => string;
    outboxOccurredAt: Date;
    reportId: string;
    snapshot: NormalizedMonitoringSnapshot;
    snapshotOccurredAt: Date;
    unit: MonitoringUnitOfWork;
}): void {
    const lifecycleIncidents = input.unit.findLifecycleIncidents(
        input.snapshot.monitorKey,
        input.snapshot.problems.map((problem) => problem.fingerprint)
    );
    const incidentsByFingerprint = new Map(
        lifecycleIncidents.map((incident) => [incident.fingerprint, incident])
    );
    const observedFingerprints = new Set<string>();
    const notificationProblems: NormalizedMonitoringProblem[] = [];
    const notificationIncidents: IncidentRecord[] = [];

    for (const problem of input.snapshot.problems) {
        observedFingerprints.add(problem.fingerprint);
        const existingIncident = incidentsByFingerprint.get(problem.fingerprint);
        let incident: IncidentRecord;
        let operation: "created" | "updated";

        if (existingIncident === undefined) {
            incident = input.unit.insertIncident({
                detailsJson: serializeMonitoringJsonObject(problem.details),
                fingerprint: problem.fingerprint,
                firstSeenAt: input.snapshotOccurredAt,
                id: input.generateId(),
                kind: problem.kind,
                lastSeenAt: input.snapshotOccurredAt,
                monitorKey: input.snapshot.monitorKey,
                resolvedAt: null,
                severity: problem.severity,
                state: "active",
                title: problem.title,
            });
            input.counts.createdIncidents += 1;
            operation = "created";
        } else if (existingIncident.state === "resolved") {
            incident = input.unit.updateIncident(existingIncident.id, {
                detailsJson: serializeMonitoringJsonObject(problem.details),
                generation: existingIncident.generation + 1,
                lastSeenAt: input.snapshotOccurredAt,
                occurrenceCount: existingIncident.occurrenceCount + 1,
                resolvedAt: null,
                severity: problem.severity,
                state: "active",
                title: problem.title,
            });
            input.counts.reopenedIncidents += 1;
            operation = "updated";
        } else {
            incident = input.unit.updateIncident(existingIncident.id, {
                detailsJson: serializeMonitoringJsonObject(problem.details),
                lastSeenAt: input.snapshotOccurredAt,
                occurrenceCount: existingIncident.occurrenceCount + 1,
                severity: problem.severity,
                title: problem.title,
            });
            operation = "updated";
        }

        input.counts.observedIncidents += 1;
        insertObservation(
            input.unit,
            input.snapshot.runId,
            incident,
            problem,
            input.snapshotOccurredAt
        );
        insertRealtimeEvent(input.unit, input.counts, {
            entityId: incident.id,
            entityType: "incident",
            expiresAt: input.expiresAt,
            occurredAt: input.outboxOccurredAt,
            operation,
            topic: monitoringRealtimeTopics.incidents,
        });

        if (existingIncident === undefined || existingIncident.state === "resolved") {
            notificationProblems.push(problem);
            notificationIncidents.push(incident);
        }
    }

    insertMonitoringReportNotification({
        counts: input.counts,
        expiresAt: input.expiresAt,
        generateId: input.generateId,
        occurredAt: input.snapshotOccurredAt,
        outboxOccurredAt: input.outboxOccurredAt,
        problems: notificationProblems,
        incidents: notificationIncidents,
        reportId: input.reportId,
        reportTitle: input.snapshot.report.title,
        source: input.snapshot.report.source,
        unit: input.unit,
    });

    for (const incident of lifecycleIncidents) {
        if (
            incident.state !== "active" ||
            observedFingerprints.has(incident.fingerprint)
        ) {
            continue;
        }

        const resolved = input.unit.updateIncident(incident.id, {
            resolvedAt: input.snapshotOccurredAt,
            state: "resolved",
        });
        input.counts.resolvedIncidents += 1;
        insertRealtimeEvent(input.unit, input.counts, {
            entityId: resolved.id,
            entityType: "incident",
            expiresAt: input.expiresAt,
            occurredAt: input.outboxOccurredAt,
            operation: "updated",
            topic: monitoringRealtimeTopics.incidents,
        });

        const readNotification = input.unit.markIncidentNotificationRead(
            incident.id,
            incident.generation,
            input.snapshotOccurredAt
        );
        if (readNotification !== undefined) {
            insertRealtimeEvent(input.unit, input.counts, {
                entityId: readNotification.id,
                entityType: "notification",
                expiresAt: input.expiresAt,
                occurredAt: input.outboxOccurredAt,
                operation: "updated",
                topic: monitoringRealtimeTopics.notifications,
            });
        }
        for (const reportNotification of input.unit.markResolvedReportNotificationsRead(
            incident.id,
            incident.generation,
            input.snapshotOccurredAt
        )) {
            insertRealtimeEvent(input.unit, input.counts, {
                entityId: reportNotification.id,
                entityType: "notification",
                expiresAt: input.expiresAt,
                occurredAt: input.outboxOccurredAt,
                operation: "updated",
                topic: monitoringRealtimeTopics.notifications,
            });
        }
    }
}
