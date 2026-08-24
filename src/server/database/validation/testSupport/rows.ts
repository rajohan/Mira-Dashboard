import { addDays, parseISO } from "date-fns";

export const incidentId = "019fc968-1a9b-7760-bf1b-d5b863b0e7b4";
export const monitorRunId = "019fc968-1a9b-7761-8f1b-d5b863b0e7b4";
export const reportId = "019fc968-1a9b-7762-9f1b-d5b863b0e7b4";
export const notificationId = "019fc968-1a9b-7763-af1b-d5b863b0e7b4";
export const incidentFingerprint = "a".repeat(64);
export const observedAt = parseISO("2026-08-03T22:00:00.000Z");

export const validIncidentValues = Object.freeze({
    detailsJson: '{"mount":"/"}',
    fingerprint: incidentFingerprint,
    firstSeenAt: observedAt,
    id: incidentId,
    kind: "system",
    lastSeenAt: observedAt,
    monitorKey: "ops-check",
    severity: "warning" as const,
    state: "active" as const,
    title: "Root filesystem pressure",
});

export const validObservationValues = Object.freeze({
    detailsJson: '{"usagePercent":91}',
    generation: 1,
    incidentId,
    kind: "system",
    monitorRunId,
    observedAt,
    severity: "warning" as const,
    title: "Root filesystem pressure",
});

export const validMonitorRunValues = Object.freeze({
    completeSnapshot: true,
    id: monitorRunId,
    monitorKey: "ops-check",
    reportId,
    startedAt: observedAt,
    state: "running" as const,
    submissionSha256: "b".repeat(64),
});

export const validNotificationValues = Object.freeze({
    channel: "dashboard" as const,
    id: notificationId,
    incidentGeneration: 1,
    incidentId,
    kind: "incident-opened",
    message: "Root filesystem usage exceeded the warning threshold.",
    occurredAt: observedAt,
    severity: "warning" as const,
    title: "Root filesystem pressure",
});

export const validRealtimeEventValues = Object.freeze({
    entityId: incidentId,
    entityType: "incident",
    expiresAt: addDays(observedAt, 7),
    occurredAt: observedAt,
    operation: "created" as const,
    payloadJson: JSON.stringify({ incidentId }),
    topic: "incidents",
});
