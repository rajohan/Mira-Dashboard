import * as v from "valibot";

import {
    monitoringChangePayloadSchema,
    monitoringRealtimeMaximumPayloadBytes,
} from "../../../contracts/monitoring.ts";
import {
    MonitoringSnapshotValidationError,
    normalizeMonitoringSnapshot,
    type NormalizedMonitoringProblem,
} from "./normalization.ts";
import type {
    IncidentRecord,
    MonitoringRepository,
    MonitoringUnitOfWork,
    RealtimeEventInsert,
} from "./repository.ts";

const defaultRealtimeRetentionMilliseconds = 7 * 24 * 60 * 60 * 1000;
const maximumSnapshotFutureSkewMilliseconds = 5 * 60 * 1000;
const monitoringNotificationKind = "monitoring.incident";

export const monitoringRealtimeTopics = Object.freeze({
    incidents: "monitoring.incidents",
    notifications: "monitoring.notifications",
    reports: "monitoring.reports",
});

export type MonitoringSubmissionStatus = "accepted" | "duplicate" | "stale";

export interface MonitoringSubmissionResult {
    createdIncidents: number;
    duplicateRunId: boolean;
    observedIncidents: number;
    reopenedIncidents: number;
    reportId: string | null;
    resolvedIncidents: number;
    realtimeEvents: number;
    runId: string;
    status: MonitoringSubmissionStatus;
}

interface MonitoringServiceDependencies {
    generateId?: () => string;
    nowMs?: () => number;
    realtimeRetentionMs?: number;
    repository: MonitoringRepository;
    wakeEventPump?: () => void;
}

interface MonitoringService {
    submitCompleteSnapshot(input: unknown): MonitoringSubmissionResult;
}

interface MutableSubmissionCounts {
    createdIncidents: number;
    observedIncidents: number;
    reopenedIncidents: number;
    resolvedIncidents: number;
    realtimeEvents: number;
}

/** A run id was retried with content that differs from its immutable first submission. */
export class MonitoringRunConflictError extends Error {
    readonly runId: string;

    constructor(runId: string) {
        super(`Monitoring run ${runId} was already submitted with different content`);
        this.name = "MonitoringRunConflictError";
        this.runId = runId;
    }
}

function emptyCounts(): MutableSubmissionCounts {
    return {
        createdIncidents: 0,
        observedIncidents: 0,
        reopenedIncidents: 0,
        resolvedIncidents: 0,
        realtimeEvents: 0,
    };
}

function serializeJsonObject(value: object): string {
    return JSON.stringify(value);
}

function isNewerThanLatestRun(
    completedAtMs: number,
    runId: string,
    latestCompletedAt: Date,
    latestRunId: string
): boolean {
    const latestCompletedAtMs = latestCompletedAt.getTime();
    return (
        completedAtMs > latestCompletedAtMs ||
        (completedAtMs === latestCompletedAtMs && runId > latestRunId)
    );
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
    const payloadJson = JSON.stringify(payload);
    const encodedBytes = new TextEncoder().encode(payloadJson).byteLength;
    if (encodedBytes > monitoringRealtimeMaximumPayloadBytes) {
        throw new RangeError(
            `Monitoring realtime payload exceeds ${monitoringRealtimeMaximumPayloadBytes} UTF-8 bytes`
        );
    }

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

function insertRealtimeEvent(
    unit: MonitoringUnitOfWork,
    counts: MutableSubmissionCounts,
    input: Parameters<typeof createRealtimeEvent>[0]
): void {
    unit.insertRealtimeEvent(createRealtimeEvent(input));
    counts.realtimeEvents += 1;
}

function insertObservation(
    unit: MonitoringUnitOfWork,
    runId: string,
    incident: IncidentRecord,
    problem: NormalizedMonitoringProblem,
    observedAt: Date
): void {
    unit.insertObservation({
        detailsJson: serializeJsonObject(problem.details),
        generation: incident.generation,
        incidentId: incident.id,
        kind: problem.kind,
        monitorRunId: runId,
        observedAt,
        severity: problem.severity,
        title: problem.title,
    });
}

function insertIncidentNotification(input: {
    expiresAt: Date;
    generateId: () => string;
    incident: IncidentRecord;
    occurredAt: Date;
    outboxOccurredAt: Date;
    problem: NormalizedMonitoringProblem;
    reportTitle: string;
    unit: MonitoringUnitOfWork;
    counts: MutableSubmissionCounts;
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

/**
 * Creates the business service for complete monitor snapshots.
 * All lifecycle, report, notification, observation, and outbox writes share one immediate
 * SQLite transaction supplied by the repository.
 * @param dependencies Repository and replaceable clock, identity, and wakeup boundaries.
 * @returns Monitoring lifecycle service.
 */
export function createMonitoringService(
    dependencies: MonitoringServiceDependencies
): MonitoringService {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;
    const realtimeRetentionMs =
        dependencies.realtimeRetentionMs ?? defaultRealtimeRetentionMilliseconds;
    if (!Number.isSafeInteger(realtimeRetentionMs) || realtimeRetentionMs <= 0) {
        throw new RangeError("Monitoring realtime retention must be a positive integer");
    }

    return {
        submitCompleteSnapshot(input: unknown): MonitoringSubmissionResult {
            const normalized = normalizeMonitoringSnapshot(input);
            const receivedAtMs = nowMs();
            if (
                !Number.isSafeInteger(receivedAtMs) ||
                receivedAtMs < 0 ||
                Number.isNaN(new Date(receivedAtMs).getTime())
            ) {
                throw new RangeError(
                    "Monitoring clock must return valid Date milliseconds"
                );
            }
            if (
                normalized.snapshot.completedAtMs - receivedAtMs >
                maximumSnapshotFutureSkewMilliseconds
            ) {
                throw new MonitoringSnapshotValidationError(
                    `completedAtMs cannot be more than ${maximumSnapshotFutureSkewMilliseconds} milliseconds in the future`
                );
            }
            const committed = dependencies.repository.withImmediateTransaction((unit) => {
                const existingRun = unit.findRun(normalized.snapshot.runId);
                if (existingRun !== undefined) {
                    if (existingRun.submissionSha256 !== normalized.submissionSha256) {
                        throw new MonitoringRunConflictError(normalized.snapshot.runId);
                    }
                    return {
                        ...emptyCounts(),
                        duplicateRunId: true,
                        reportId: existingRun.reportId,
                        runId: existingRun.id,
                        status: "duplicate" as const,
                    };
                }

                const counts = emptyCounts();
                const latestRun = unit.findLatestCompleteRun(
                    normalized.snapshot.monitorKey
                );
                const reportId = generateId();
                const snapshotOccurredAt = new Date(normalized.snapshot.completedAtMs);
                const outboxOccurredAt = new Date(receivedAtMs);
                // The resource-scoped maintenance job owns bounded expiry deletion;
                // request transactions only stamp the durable retention boundary.
                const expiresAt = new Date(
                    outboxOccurredAt.getTime() + realtimeRetentionMs
                );

                unit.insertReport({
                    bodyMarkdown: normalized.snapshot.report.bodyMarkdown,
                    id: reportId,
                    kind: normalized.snapshot.report.kind,
                    metadataJson: serializeJsonObject(
                        normalized.snapshot.report.metadata
                    ),
                    occurredAt: snapshotOccurredAt,
                    source: normalized.snapshot.report.source,
                    sourceJobId: normalized.snapshot.report.sourceJobId,
                    title: normalized.snapshot.report.title,
                });
                unit.insertMonitorRun({
                    completedAt: snapshotOccurredAt,
                    completeSnapshot: true,
                    id: normalized.snapshot.runId,
                    monitorKey: normalized.snapshot.monitorKey,
                    reportId,
                    startedAt: new Date(normalized.snapshot.startedAtMs),
                    state: "succeeded",
                    submissionSha256: normalized.submissionSha256,
                });
                insertRealtimeEvent(unit, counts, {
                    entityId: reportId,
                    entityType: "report",
                    expiresAt,
                    occurredAt: outboxOccurredAt,
                    operation: "created",
                    topic: monitoringRealtimeTopics.reports,
                });

                if (
                    latestRun?.completedAt !== undefined &&
                    latestRun.completedAt !== null &&
                    !isNewerThanLatestRun(
                        normalized.snapshot.completedAtMs,
                        normalized.snapshot.runId,
                        latestRun.completedAt,
                        latestRun.id
                    )
                ) {
                    return {
                        ...counts,
                        duplicateRunId: false,
                        reportId,
                        runId: normalized.snapshot.runId,
                        status: "stale" as const,
                    };
                }

                const lifecycleIncidents = unit.findLifecycleIncidents(
                    normalized.snapshot.monitorKey,
                    normalized.snapshot.problems.map((problem) => problem.fingerprint)
                );
                const incidentsByFingerprint = new Map(
                    lifecycleIncidents.map((incident) => [incident.fingerprint, incident])
                );
                const observedFingerprints = new Set<string>();

                for (const problem of normalized.snapshot.problems) {
                    observedFingerprints.add(problem.fingerprint);
                    const existingIncident = incidentsByFingerprint.get(
                        problem.fingerprint
                    );
                    let incident: IncidentRecord;
                    let operation: "created" | "updated";

                    if (existingIncident === undefined) {
                        incident = unit.insertIncident({
                            detailsJson: serializeJsonObject(problem.details),
                            fingerprint: problem.fingerprint,
                            firstSeenAt: snapshotOccurredAt,
                            id: generateId(),
                            kind: problem.kind,
                            lastSeenAt: snapshotOccurredAt,
                            monitorKey: normalized.snapshot.monitorKey,
                            resolvedAt: null,
                            severity: problem.severity,
                            state: "active",
                            title: problem.title,
                        });
                        counts.createdIncidents += 1;
                        operation = "created";
                    } else if (existingIncident.state === "resolved") {
                        incident = unit.updateIncident(existingIncident.id, {
                            detailsJson: serializeJsonObject(problem.details),
                            generation: existingIncident.generation + 1,
                            lastSeenAt: snapshotOccurredAt,
                            occurrenceCount: existingIncident.occurrenceCount + 1,
                            resolvedAt: null,
                            severity: problem.severity,
                            state: "active",
                            title: problem.title,
                        });
                        counts.reopenedIncidents += 1;
                        operation = "updated";
                    } else {
                        incident = unit.updateIncident(existingIncident.id, {
                            detailsJson: serializeJsonObject(problem.details),
                            lastSeenAt: snapshotOccurredAt,
                            occurrenceCount: existingIncident.occurrenceCount + 1,
                            severity: problem.severity,
                            title: problem.title,
                        });
                        operation = "updated";
                    }

                    counts.observedIncidents += 1;
                    insertObservation(
                        unit,
                        normalized.snapshot.runId,
                        incident,
                        problem,
                        snapshotOccurredAt
                    );
                    insertRealtimeEvent(unit, counts, {
                        entityId: incident.id,
                        entityType: "incident",
                        expiresAt,
                        occurredAt: outboxOccurredAt,
                        operation,
                        topic: monitoringRealtimeTopics.incidents,
                    });

                    if (
                        existingIncident === undefined ||
                        existingIncident.state === "resolved"
                    ) {
                        insertIncidentNotification({
                            counts,
                            expiresAt,
                            generateId,
                            incident,
                            occurredAt: snapshotOccurredAt,
                            outboxOccurredAt,
                            problem,
                            reportTitle: normalized.snapshot.report.title,
                            unit,
                        });
                    }
                }

                for (const incident of lifecycleIncidents) {
                    if (
                        incident.state !== "active" ||
                        observedFingerprints.has(incident.fingerprint)
                    ) {
                        continue;
                    }

                    const resolved = unit.updateIncident(incident.id, {
                        resolvedAt: snapshotOccurredAt,
                        state: "resolved",
                    });
                    counts.resolvedIncidents += 1;
                    insertRealtimeEvent(unit, counts, {
                        entityId: resolved.id,
                        entityType: "incident",
                        expiresAt,
                        occurredAt: outboxOccurredAt,
                        operation: "updated",
                        topic: monitoringRealtimeTopics.incidents,
                    });

                    const readNotification = unit.markIncidentNotificationRead(
                        incident.id,
                        incident.generation,
                        snapshotOccurredAt
                    );
                    if (readNotification !== undefined) {
                        insertRealtimeEvent(unit, counts, {
                            entityId: readNotification.id,
                            entityType: "notification",
                            expiresAt,
                            occurredAt: outboxOccurredAt,
                            operation: "updated",
                            topic: monitoringRealtimeTopics.notifications,
                        });
                    }
                }

                return {
                    ...counts,
                    duplicateRunId: false,
                    reportId,
                    runId: normalized.snapshot.runId,
                    status: "accepted" as const,
                };
            });

            if (committed.realtimeEvents > 0 && dependencies.wakeEventPump) {
                try {
                    dependencies.wakeEventPump();
                } catch {
                    // SQLite is authoritative; adaptive polling recovers a missed wakeup.
                }
            }
            return committed;
        },
    };
}
