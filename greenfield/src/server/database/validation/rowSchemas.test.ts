import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { workerActionKeysMaximumBytes } from "../schema/jobChecks.ts";
import { incidentObservationInsertSchema } from "./incidentObservations.ts";
import {
    incidentInsertSchema,
    incidentSelectSchema,
    incidentUpdateSchema,
} from "./incidents.ts";
import {
    jobDisableIntentCloseSchema,
    jobDisableIntentInsertSchema,
    jobDisableIntentSelectSchema,
} from "./jobDisableIntents.ts";
import { jobRunEventInsertSchema, jobRunEventSelectSchema } from "./jobRunEvents.ts";
import { jobRunInsertSchema, jobRunSelectSchema } from "./jobRuns.ts";
import {
    jobWorkerControlSelectSchema,
    jobWorkerControlUpdateSchema,
} from "./jobWorkerControl.ts";
import { monitorRunInsertSchema, monitorRunUpdateSchema } from "./monitorRuns.ts";
import { notificationInsertSchema, notificationUpdateSchema } from "./notifications.ts";
import {
    realtimeCursorBoundsSchema,
    realtimeCursorWindowSchema,
    realtimeEventInsertSchema,
    realtimeEventSelectSchema,
} from "./realtimeEvents.ts";
import { reportInsertSchema } from "./reports.ts";
import {
    resourceLeaseInsertSchema,
    resourceLeaseSelectSchema,
} from "./resourceLeases.ts";
import { scheduledJobInsertSchema, scheduledJobSelectSchema } from "./scheduledJobs.ts";
import { schemaMigrationInsertSchema } from "./schemaMigrations.ts";
import {
    incidentFingerprint,
    incidentId,
    monitorRunId,
    notificationId,
    observedAt,
    reportId,
    validIncidentValues,
    validMonitorRunValues,
    validNotificationValues,
    validObservationValues,
    validRealtimeEventValues,
} from "./testSupport/rows.ts";
import {
    workerInstanceInsertSchema,
    workerInstanceSelectSchema,
} from "./workerInstances.ts";

const jobUserId = "019fc968-1a9b-7764-bf1b-d5b863b0e7b4";
const jobRunId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b4";
const jobEventRunId = "019fc968-1a9b-7766-9f1b-d5b863b0e7b4";
const jobWorkerId = "019fc968-1a9b-7767-af1b-d5b863b0e7b4";
const jobLeaseToken = "019fc968-1a9b-7768-bf1b-d5b863b0e7b4";
const jobDisableIntentId = "019fc968-1a9b-7769-8f1b-d5b863b0e7b4";
const jobScheduleId = "system.worker-smoke";
const jobCreatedAt = new Date(1000);
const jobUpdatedAt = new Date(2000);
const jobNextRunAt = new Date(61_000);

const validScheduledJobRow = Object.freeze({
    actionKey: "system.worker-smoke",
    actionPayloadJson: "{}",
    attemptLimit: 2,
    cancellationPolicy: "cooperative" as const,
    createdAt: jobCreatedAt,
    cronExpression: null,
    description: "Verifies the worker runtime without external side effects.",
    enabled: true,
    id: jobScheduleId,
    intervalMs: 60_000,
    name: "Worker smoke check",
    nextRunAt: jobNextRunAt,
    priority: 0,
    resourceClass: "light" as const,
    resourceKeysJson: '["database"]',
    retrySafe: true,
    scheduleKind: "interval" as const,
    timeOfDay: null,
    timeZone: null,
    timeoutMs: 30_000,
    updatedAt: jobUpdatedAt,
    version: 1,
});

const validJobRunRow = Object.freeze({
    actionKey: "system.worker-smoke",
    attemptCount: 0,
    attemptLimit: 2,
    availableAt: jobUpdatedAt,
    cancellationPolicy: "cooperative" as const,
    cancelRequestedAt: null,
    cancelRequestedById: null,
    cancelRequestedByKind: null,
    displayName: "Worker smoke check",
    enqueueSha256: "a".repeat(64),
    eventBytes: 0,
    eventCount: 0,
    finishedAt: null,
    firstStartedAt: null,
    heartbeatAt: null,
    id: jobRunId,
    idempotencyKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
    lastAttemptStartedAt: null,
    leaseExpiresAt: null,
    leaseOwnerId: null,
    leaseToken: null,
    payloadEventCount: 0,
    payloadJson: "{}",
    priority: 0,
    queuedAt: jobUpdatedAt,
    requestedById: jobUserId,
    requestedByKind: "user" as const,
    requiredWorkerReleaseId: null,
    resourceClass: "light" as const,
    resourceKeysJson: '["database"]',
    resultJson: null,
    retrySafe: true,
    scheduledForAt: null,
    scheduledJobId: jobScheduleId,
    scheduledJobVersion: 1,
    state: "queued" as const,
    stateVersion: 1,
    terminalCode: null,
    terminalMessage: null,
    timeoutMs: 30_000,
    triggerType: "manual" as const,
    updatedAt: jobUpdatedAt,
});

const generatedJobRunInsertFields = new Set([
    "attemptCount",
    "eventBytes",
    "eventCount",
    "payloadEventCount",
    "stateVersion",
]);
const validJobRunInsert = Object.fromEntries(
    Object.entries(validJobRunRow).filter(
        ([key]) => !generatedJobRunInsertFields.has(key)
    )
);

describe("Drizzle-generated Valibot row schemas", () => {
    test("validate every foundation table at its database boundary", () => {
        expect(
            v.parse(schemaMigrationInsertSchema, {
                appliedAt: observedAt,
                checksum: "a".repeat(64),
                id: "20260804022252_dashboard-foundation",
                releaseId: "b".repeat(40),
            })
        ).toBeDefined();

        expect(
            v.parse(reportInsertSchema, {
                bodyMarkdown: "All checks passed.",
                id: reportId,
                kind: "heartbeat",
                metadataJson: '{"source":"ops-check"}',
                occurredAt: observedAt,
                source: "openclaw",
                title: "Heartbeat",
            })
        ).toBeDefined();

        expect(v.parse(monitorRunInsertSchema, validMonitorRunValues)).toBeDefined();

        expect(v.parse(incidentInsertSchema, validIncidentValues)).toBeDefined();

        expect(
            v.parse(incidentObservationInsertSchema, validObservationValues)
        ).toBeDefined();

        expect(v.parse(notificationInsertSchema, validNotificationValues)).toBeDefined();

        expect(
            v.parse(realtimeEventInsertSchema, validRealtimeEventValues)
        ).toBeDefined();
    });

    test("refine UUIDv7 and JSON text without breaking update optionality", () => {
        expect(v.parse(incidentUpdateSchema, {})).toEqual({});
        expect(v.parse(monitorRunUpdateSchema, { reportId: null })).toEqual({
            reportId: null,
        });
        expect(v.parse(notificationUpdateSchema, { readAt: observedAt })).toEqual({
            readAt: observedAt,
        });
        expect(() => v.parse(notificationUpdateSchema, { id: notificationId })).toThrow();
        expect(() => v.parse(incidentUpdateSchema, { id: incidentId })).toThrow();
        expect(() => v.parse(monitorRunUpdateSchema, { id: monitorRunId })).toThrow();

        expect(() =>
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                id: "550e8400-e29b-41d4-a716-446655440000",
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                detailsJson: "[]",
            })
        ).toThrow();

        expect(() =>
            v.parse(realtimeEventInsertSchema, {
                entityType: "incident",
                occurredAt: observedAt,
                operation: "created",
                payloadJson: "{not-json}",
                topic: "incidents",
            })
        ).toThrow();
        expect(() =>
            v.parse(realtimeEventInsertSchema, {
                entityType: "incident",
                occurredAt: observedAt,
                operation: "created",
                payloadJson: JSON.stringify({ incidentId }),
                topic: "incidents",
            })
        ).toThrow();

        expect(
            v.parse(realtimeEventInsertSchema, {
                ...validRealtimeEventValues,
                payloadJson: "42",
            })
        ).toBeDefined();
        expect(
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                id: Bun.randomUUIDv7(),
            })
        ).toBeDefined();

        expect(
            v.parse(incidentSelectSchema, {
                detailsJson: "{}",
                fingerprint: incidentFingerprint,
                firstSeenAt: observedAt,
                generation: 1,
                id: incidentId,
                kind: "system",
                lastSeenAt: observedAt,
                monitorKey: "ops-check",
                occurrenceCount: 1,
                resolvedAt: null,
                severity: "warning",
                state: "active",
                title: "Root filesystem pressure",
            })
        ).toBeDefined();
    });

    test("accepts only positive safe integer realtime event select IDs", () => {
        for (const id of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() =>
                v.parse(realtimeEventSelectSchema, {
                    ...validRealtimeEventValues,
                    id,
                })
            ).toThrow();
        }

        for (const id of [1, Number.MAX_SAFE_INTEGER]) {
            expect(
                v.parse(realtimeEventSelectSchema, {
                    ...validRealtimeEventValues,
                    id,
                })
            ).toBeDefined();
        }
    });

    test("validates raw realtime cursor aggregates and their cross-field invariants", () => {
        expect(
            v.parse(realtimeCursorWindowSchema, {
                latestIssuedId: 0,
                newestRetainedId: null,
                oldestRetainedId: null,
                retainedEvents: 0,
            })
        ).toEqual({
            latestIssuedId: 0,
            newestRetainedId: null,
            oldestRetainedId: null,
            retainedEvents: 0,
        });
        expect(
            v.parse(realtimeCursorBoundsSchema, {
                latestIssuedId: 3,
                newestRetainedId: 3,
                oldestRetainedId: 1,
            })
        ).toEqual({
            latestIssuedId: 3,
            newestRetainedId: 3,
            oldestRetainedId: 1,
        });

        const invalidBounds = [
            {
                latestIssuedId: -1,
                newestRetainedId: null,
                oldestRetainedId: null,
            },
            {
                latestIssuedId: 3,
                newestRetainedId: 3,
                oldestRetainedId: null,
            },
            {
                latestIssuedId: 3,
                newestRetainedId: 2,
                oldestRetainedId: 3,
            },
            {
                latestIssuedId: 2,
                newestRetainedId: 3,
                oldestRetainedId: 1,
            },
        ] as const;
        for (const bounds of invalidBounds) {
            expect(() => v.parse(realtimeCursorBoundsSchema, bounds)).toThrow();
        }

        expect(() =>
            v.parse(realtimeCursorWindowSchema, {
                latestIssuedId: 3,
                newestRetainedId: 3,
                oldestRetainedId: 1,
                retainedEvents: 0,
            })
        ).toThrow("Realtime cursor-window aggregates are inconsistent");
        expect(() =>
            v.parse(realtimeCursorWindowSchema, {
                latestIssuedId: 3,
                newestRetainedId: null,
                oldestRetainedId: null,
                retainedEvents: 1,
            })
        ).toThrow("Realtime cursor-window aggregates are inconsistent");
        expect(() =>
            v.parse(realtimeCursorWindowSchema, {
                latestIssuedId: 100,
                newestRetainedId: 3,
                oldestRetainedId: 1,
                retainedEvents: 4,
            })
        ).toThrow("Realtime cursor-window retained count exceeds its id span");
    });

    test("rejects unknown, generated, and constraint-breaking storage fields", () => {
        expect(() =>
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                unexpected: true,
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentObservationInsertSchema, {
                ...validObservationValues,
                id: 1,
            })
        ).toThrow();
        expect(() =>
            v.parse(realtimeEventInsertSchema, {
                ...validRealtimeEventValues,
                id: 1,
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                generation: 0,
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                generation: 2,
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                occurrenceCount: 2,
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentObservationInsertSchema, {
                ...validObservationValues,
                generation: 0,
            })
        ).toThrow();
        expect(() =>
            v.parse(notificationInsertSchema, {
                channel: "dashboard",
                id: notificationId,
                incidentGeneration: 0,
                incidentId,
                kind: "incident-opened",
                message: "Root filesystem usage exceeded the warning threshold.",
                occurredAt: observedAt,
                severity: "warning",
                title: "Root filesystem pressure",
            })
        ).toThrow();
        expect(() =>
            v.parse(notificationInsertSchema, {
                channel: "dashboard",
                id: notificationId,
                kind: "manual",
                message: "Already read",
                occurredAt: observedAt,
                readAt: observedAt,
                severity: "info",
                title: "Already read",
            })
        ).toThrow();
        expect(() =>
            v.parse(schemaMigrationInsertSchema, {
                appliedAt: observedAt,
                checksum: "A".repeat(64),
                id: "20260804022252_dashboard-foundation",
                releaseId: "b".repeat(40),
            })
        ).toThrow();
        expect(() =>
            v.parse(schemaMigrationInsertSchema, {
                appliedAt: observedAt,
                checksum: "a".repeat(64),
                id: `20260804022252_${"a".repeat(114)}`,
                releaseId: "b".repeat(40),
            })
        ).toThrow();
    });

    test("validates all seven durable job table boundaries", () => {
        expect(v.parse(scheduledJobInsertSchema, validScheduledJobRow)).toBeDefined();
        expect(v.parse(scheduledJobSelectSchema, validScheduledJobRow)).toBeDefined();

        const disableIntent = {
            createdAt: jobCreatedAt,
            createdById: jobUserId,
            createdByKind: "user" as const,
            endedAt: null,
            endedById: null,
            endedByKind: null,
            endedReason: null,
            expiresAt: jobNextRunAt,
            externalJobId: null,
            externalProvider: null,
            id: jobDisableIntentId,
            reason: "Paused during maintenance.",
            scheduledJobId: jobScheduleId,
            targetKind: "dashboard-schedule" as const,
        };
        expect(v.parse(jobDisableIntentInsertSchema, disableIntent)).toBeDefined();
        expect(v.parse(jobDisableIntentSelectSchema, disableIntent)).toBeDefined();
        expect(
            v.parse(jobDisableIntentCloseSchema, {
                endedAt: jobUpdatedAt,
                endedById: jobUserId,
                endedByKind: "user",
                endedReason: "re-enabled",
            })
        ).toBeDefined();
        expect(
            v.parse(jobDisableIntentCloseSchema, {
                endedAt: jobUpdatedAt,
                endedById: jobUserId,
                endedByKind: "user",
                endedReason: "target-deleted",
            })
        ).toBeDefined();

        expect(v.parse(jobRunInsertSchema, validJobRunInsert)).toBeDefined();
        expect(v.parse(jobRunSelectSchema, validJobRunRow)).toBeDefined();
        expect(
            v.parse(jobRunInsertSchema, {
                ...validJobRunInsert,
                actionKey: "workspace-files.apply-write",
                scheduledJobId: null,
                scheduledJobVersion: null,
            })
        ).toMatchObject({
            scheduledJobId: null,
            scheduledJobVersion: null,
            triggerType: "manual",
        });

        const jobEvent = {
            attempt: 0,
            jobRunId: jobEventRunId,
            kind: "queued" as const,
            message: "Queued for execution.",
            occurredAt: jobUpdatedAt,
            progressJson: null,
            sequence: 1,
            workerInstanceId: null,
        };
        expect(v.parse(jobRunEventInsertSchema, jobEvent)).toBeDefined();
        expect(v.parse(jobRunEventSelectSchema, jobEvent)).toBeDefined();

        const worker = {
            actionKeysJson: '["host.system.update"]',
            capacity: 2,
            drainingAt: null,
            heartbeatAt: jobUpdatedAt,
            id: jobWorkerId,
            pid: 1234,
            releaseId: "b".repeat(40),
            startedAt: jobCreatedAt,
            state: "online" as const,
            stoppedAt: null,
        };
        expect(v.parse(workerInstanceInsertSchema, worker)).toBeDefined();
        expect(v.parse(workerInstanceSelectSchema, worker)).toBeDefined();

        const lease = {
            acquiredAt: jobCreatedAt,
            expiresAt: jobNextRunAt,
            jobRunId,
            leaseToken: jobLeaseToken,
            renewedAt: jobUpdatedAt,
            resourceKey: "database",
            workerInstanceId: jobWorkerId,
        };
        expect(v.parse(resourceLeaseInsertSchema, lease)).toBeDefined();
        expect(v.parse(resourceLeaseSelectSchema, lease)).toBeDefined();

        expect(
            v.parse(jobWorkerControlSelectSchema, {
                claimingPaused: false,
                id: 1,
                updatedAt: new Date(0),
                updatedById: null,
                updatedByKind: null,
                version: 1,
            })
        ).toBeDefined();
        expect(
            v.parse(jobWorkerControlUpdateSchema, {
                claimingPaused: true,
                updatedAt: jobUpdatedAt,
                updatedById: jobUserId,
                updatedByKind: "user",
                version: 2,
            })
        ).toBeDefined();
    });

    test("refines durable job identifiers, JSON roots, and bounded counters", () => {
        expect(() =>
            v.parse(scheduledJobSelectSchema, {
                ...validScheduledJobRow,
                id: "System.Worker-Smoke",
            })
        ).toThrow("Schedule id is invalid");
        expect(() =>
            v.parse(scheduledJobSelectSchema, {
                ...validScheduledJobRow,
                actionPayloadJson: "[]",
            })
        ).toThrow("Stored job payload must contain a JSON object");
        expect(() =>
            v.parse(scheduledJobSelectSchema, {
                ...validScheduledJobRow,
                resourceKeysJson: '["database","database"]',
            })
        ).toThrow("Stored job resource keys are not canonical");
        expect(() =>
            v.parse(scheduledJobSelectSchema, {
                ...validScheduledJobRow,
                resourceKeysJson: "{}",
            })
        ).toThrow("Stored job resource keys are not canonical");
        expect(() =>
            v.parse(jobRunSelectSchema, {
                ...validJobRunRow,
                id: "550e8400-e29b-41d4-a716-446655440000",
            })
        ).toThrow("Expected a lowercase UUIDv7 identifier");
        expect(() =>
            v.parse(jobRunInsertSchema, {
                ...validJobRunInsert,
                availableAt: new Date(1999),
            })
        ).toThrow("New job run must be an internally consistent queued row");
        expect(() =>
            v.parse(jobRunSelectSchema, {
                ...validJobRunRow,
                eventCount: 1001,
            })
        ).toThrow("Stored job event count is invalid");
        expect(() =>
            v.parse(jobRunSelectSchema, {
                ...validJobRunRow,
                eventCount: 1,
                payloadEventCount: 2,
            })
        ).toThrow("Stored job run is inconsistent");
        expect(() =>
            v.parse(resourceLeaseSelectSchema, {
                acquiredAt: jobCreatedAt,
                expiresAt: jobNextRunAt,
                jobRunId,
                leaseToken: jobLeaseToken,
                renewedAt: jobUpdatedAt,
                resourceKey: "Database",
                workerInstanceId: jobWorkerId,
            })
        ).toThrow("Job resource key is invalid");
    });

    test("rejects inconsistent durable job lifecycle rows", () => {
        expect(
            v.parse(scheduledJobSelectSchema, {
                ...validScheduledJobRow,
                enabled: false,
            })
        ).toMatchObject({ enabled: false, nextRunAt: jobNextRunAt });
        expect(() =>
            v.parse(scheduledJobSelectSchema, {
                ...validScheduledJobRow,
                nextRunAt: null,
            })
        ).toThrow();
        expect(() =>
            v.parse(jobDisableIntentSelectSchema, {
                createdAt: jobCreatedAt,
                createdById: jobUserId,
                createdByKind: "user",
                endedAt: jobUpdatedAt,
                endedById: null,
                endedByKind: null,
                endedReason: null,
                expiresAt: null,
                externalJobId: null,
                externalProvider: null,
                id: jobDisableIntentId,
                reason: "Incomplete closure.",
                scheduledJobId: jobScheduleId,
                targetKind: "dashboard-schedule",
            })
        ).toThrow();
        expect(() =>
            v.parse(jobRunSelectSchema, {
                ...validJobRunRow,
                attemptCount: 1,
                firstStartedAt: jobUpdatedAt,
                lastAttemptStartedAt: jobUpdatedAt,
                state: "running",
            })
        ).toThrow();
        expect(() =>
            v.parse(jobRunSelectSchema, {
                ...validJobRunRow,
                scheduledJobId: null,
                scheduledJobVersion: 1,
            })
        ).toThrow();
        expect(() =>
            v.parse(jobRunEventSelectSchema, {
                attempt: 0,
                jobRunId,
                kind: "progress",
                message: null,
                occurredAt: jobUpdatedAt,
                progressJson: null,
                sequence: 1,
                workerInstanceId: null,
            })
        ).toThrow();
        const retiredUnstartedRun = {
            ...validJobRunRow,
            cancellationPolicy: "never" as const,
            finishedAt: jobUpdatedAt,
            scheduledForAt: jobCreatedAt,
            state: "failed" as const,
            terminalCode: "action-unavailable",
            terminalMessage: "The scheduled action is no longer available",
            triggerType: "schedule" as const,
        };
        expect(v.parse(jobRunSelectSchema, retiredUnstartedRun)).toBeDefined();
        expect(() =>
            v.parse(jobRunSelectSchema, {
                ...retiredUnstartedRun,
                terminalCode: "action-failed",
            })
        ).toThrow();
        expect(() =>
            v.parse(jobRunSelectSchema, {
                ...retiredUnstartedRun,
                terminalMessage: "A different bounded failure message",
            })
        ).toThrow();
        expect(() =>
            v.parse(jobRunSelectSchema, {
                ...retiredUnstartedRun,
                triggerType: "manual",
            })
        ).toThrow();
        expect(() =>
            v.parse(workerInstanceSelectSchema, {
                actionKeysJson: "[]",
                capacity: 1,
                drainingAt: null,
                heartbeatAt: jobUpdatedAt,
                id: jobWorkerId,
                pid: 1234,
                releaseId: "b".repeat(40),
                startedAt: jobCreatedAt,
                state: "stopped",
                stoppedAt: null,
            })
        ).toThrow();
        const validWorkerInsert = {
            actionKeysJson: '["host.system.restart","host.system.update"]',
            capacity: 2,
            drainingAt: null,
            heartbeatAt: jobUpdatedAt,
            id: jobWorkerId,
            pid: 1234,
            releaseId: "b".repeat(40),
            startedAt: jobCreatedAt,
            state: "online" as const,
            stoppedAt: null,
        };
        expect(v.parse(workerInstanceInsertSchema, validWorkerInsert)).toBeDefined();
        for (const actionKeysJson of [
            '["host.system.update","host.system.restart"]',
            ' ["host.system.restart","host.system.update"]',
            `${" ".repeat(workerActionKeysMaximumBytes)}[]`,
        ]) {
            expect(() =>
                v.parse(workerInstanceInsertSchema, {
                    ...validWorkerInsert,
                    actionKeysJson,
                })
            ).toThrow("Stored worker action keys are invalid");
        }
        expect(() =>
            v.parse(resourceLeaseSelectSchema, {
                acquiredAt: jobCreatedAt,
                expiresAt: jobUpdatedAt,
                jobRunId,
                leaseToken: jobLeaseToken,
                renewedAt: jobUpdatedAt,
                resourceKey: "database",
                workerInstanceId: jobWorkerId,
            })
        ).toThrow();
        expect(() =>
            v.parse(jobWorkerControlSelectSchema, {
                claimingPaused: false,
                id: 1,
                updatedAt: new Date(0),
                updatedById: null,
                updatedByKind: null,
                version: 2,
            })
        ).toThrow();
        expect(() => v.parse(jobDisableIntentCloseSchema, {})).toThrow();
        expect(() =>
            v.parse(jobDisableIntentCloseSchema, {
                endedAt: jobUpdatedAt,
                endedById: jobUserId,
                endedByKind: "user",
                endedReason: "expired",
            })
        ).toThrow();
    });
});
