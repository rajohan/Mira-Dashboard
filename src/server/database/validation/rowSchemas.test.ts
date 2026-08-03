import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { incidentObservationInsertSchema } from "./incidentObservations.ts";
import {
    incidentInsertSchema,
    incidentSelectSchema,
    incidentUpdateSchema,
} from "./incidents.ts";
import { monitorRunInsertSchema, monitorRunUpdateSchema } from "./monitorRuns.ts";
import { notificationInsertSchema, notificationUpdateSchema } from "./notifications.ts";
import { realtimeEventInsertSchema } from "./realtimeEvents.ts";
import { reportInsertSchema } from "./reports.ts";
import { schemaMigrationInsertSchema } from "./schemaMigrations.ts";

const incidentId = "019fc968-1a9b-7760-bf1b-d5b863b0e7b4";
const monitorRunId = "019fc968-1a9b-7761-8f1b-d5b863b0e7b4";
const reportId = "019fc968-1a9b-7762-9f1b-d5b863b0e7b4";
const notificationId = "019fc968-1a9b-7763-af1b-d5b863b0e7b4";
const observedAt = new Date("2026-08-03T22:00:00.000Z");
const validIncidentValues = {
    detailsJson: '{"mount":"/"}',
    fingerprint: "filesystem:root-pressure",
    firstSeenAt: observedAt,
    id: incidentId,
    kind: "system",
    lastSeenAt: observedAt,
    monitorKey: "ops-check",
    severity: "warning",
    state: "active",
    title: "Root filesystem pressure",
} as const;
const validObservationValues = {
    detailsJson: '{"usagePercent":91}',
    generation: 1,
    incidentId,
    monitorRunId,
    observedAt,
} as const;
const validRealtimeEventValues = {
    entityId: incidentId,
    entityType: "incident",
    occurredAt: observedAt,
    operation: "created",
    payloadJson: JSON.stringify({ incidentId }),
    topic: "incidents",
} as const;

describe("Drizzle-generated Valibot row schemas", () => {
    test("validate every foundation table at its database boundary", () => {
        expect(
            v.parse(schemaMigrationInsertSchema, {
                appliedAt: observedAt,
                checksum: "a".repeat(64),
                id: "20260803215711_greenfield-foundation",
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

        expect(
            v.parse(monitorRunInsertSchema, {
                completeSnapshot: true,
                id: monitorRunId,
                monitorKey: "ops-check",
                reportId,
                startedAt: observedAt,
                state: "running",
            })
        ).toBeDefined();

        expect(v.parse(incidentInsertSchema, validIncidentValues)).toBeDefined();

        expect(
            v.parse(incidentObservationInsertSchema, validObservationValues)
        ).toBeDefined();

        expect(
            v.parse(notificationInsertSchema, {
                channel: "dashboard",
                id: notificationId,
                incidentGeneration: 1,
                incidentId,
                kind: "incident-opened",
                message: "Root filesystem usage exceeded the warning threshold.",
                occurredAt: observedAt,
                severity: "warning",
                title: "Root filesystem pressure",
            })
        ).toBeDefined();

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
                fingerprint: "filesystem:root-pressure",
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
                id: "20260803215711_greenfield-foundation",
                releaseId: "b".repeat(40),
            })
        ).toThrow();
    });
});
