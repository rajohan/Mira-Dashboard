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
import {
    realtimeCursorBoundsSchema,
    realtimeCursorWindowSchema,
    realtimeEventInsertSchema,
    realtimeEventSelectSchema,
} from "./realtimeEvents.ts";
import { reportInsertSchema } from "./reports.ts";
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
    });
});
