import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { cacheRealtimeTopic } from "./cacheRealtime.ts";
import {
    eventsStreamContract,
    realtimeStreamCapabilities,
    realtimeStreamDataSchema,
    realtimeStreamInputSchema,
    realtimeStreamOutputSchema,
    realtimeTopicDefinitions,
} from "./events.ts";
import { gatewayRealtimeTopics } from "./gatewayRealtime.ts";
import {
    monitoringRealtimeRoutingSchema,
    monitoringRealtimeTopics,
} from "./monitoringRealtime.ts";
import { openClawTasksRealtimeTopic } from "./openClawTasksRealtime.ts";

describe("realtime transport contracts", () => {
    test("documents only capabilities required by registered topics", () => {
        expect(realtimeStreamCapabilities).toEqual([
            "agents:read",
            "cache:read",
            "chat:read",
            "gateway-sessions:read",
            "jobs:read",
            "notifications:read",
            "openclaw-tasks:read",
            "reports:read",
            "tasks:read",
        ]);
        expect(eventsStreamContract.access.capabilities).toBe(realtimeStreamCapabilities);
        expect(
            [
                ...new Set(realtimeTopicDefinitions.map(({ capability }) => capability)),
            ].toSorted()
        ).toEqual(realtimeStreamCapabilities);
    });

    test("defaults the initial cursor and preserves unique registered topics", () => {
        const input = v.parse(realtimeStreamInputSchema, {
            topics: [
                monitoringRealtimeTopics.reports,
                monitoringRealtimeTopics.notifications,
            ],
        });

        expect(input).toEqual({
            lastEventId: "0",
            topics: [
                monitoringRealtimeTopics.reports,
                monitoringRealtimeTopics.notifications,
            ],
        });
        expect(Object.isFrozen(input.topics)).toBe(true);
    });

    test("rejects unknown fields, topics, duplicate topics, and noncanonical cursors", () => {
        const invalidInputs = [
            { topics: ["unknown.topic"] },
            {
                topics: [
                    monitoringRealtimeTopics.reports,
                    monitoringRealtimeTopics.reports,
                ],
            },
            { lastEventId: "01", topics: [monitoringRealtimeTopics.reports] },
            {
                lastEventId: String(Number.MAX_SAFE_INTEGER + 1),
                topics: [monitoringRealtimeTopics.reports],
            },
            { topics: [monitoringRealtimeTopics.reports], unexpected: true },
        ];

        for (const input of invalidInputs) {
            expect(v.safeParse(realtimeStreamInputSchema, input).success).toBe(false);
        }
    });

    test("describes the tracked client envelope with a topic-specific payload", () => {
        expect(
            v.parse(realtimeStreamOutputSchema, {
                data: {
                    event: {
                        entityId: "report-1",
                        entityType: "report",
                        occurredAtMs: 1,
                        operation: "created",
                        payload: { id: "report-1" },
                        topic: monitoringRealtimeTopics.reports,
                    },
                    kind: "change",
                },
                id: "1",
            })
        ).toMatchObject({ id: "1" });
    });

    test("accepts only bounded Gateway snapshot invalidations", () => {
        expect(
            v.parse(realtimeStreamDataSchema, {
                event: {
                    entityId: "current",
                    entityType: "gateway-sessions",
                    occurredAtMs: 1000,
                    operation: "snapshot-required",
                    payload: { kind: "snapshot-required" },
                    topic: gatewayRealtimeTopics.sessions,
                },
                kind: "change",
            })
        ).toBeDefined();
        expect(
            v.safeParse(realtimeStreamDataSchema, {
                event: {
                    entityId: "current",
                    entityType: "gateway-sessions",
                    occurredAtMs: 1000,
                    operation: "snapshot-required",
                    payload: { kind: "snapshot-required", sessionKey: "secret" },
                    topic: gatewayRealtimeTopics.sessions,
                },
                kind: "change",
            }).success
        ).toBeFalse();
    });

    test("keeps OpenClaw task realtime payload-free", () => {
        const marker = {
            event: {
                entityId: "current",
                entityType: "openclaw-task",
                occurredAtMs: 1000,
                operation: "snapshot-required",
                payload: { kind: "snapshot-required" },
                topic: openClawTasksRealtimeTopic,
            },
            kind: "change",
        } as const;
        expect(v.parse(realtimeStreamDataSchema, marker)).toEqual(marker);
        expect(
            v.safeParse(realtimeStreamDataSchema, {
                ...marker,
                event: {
                    ...marker.event,
                    payload: { kind: "snapshot-required", task: { id: "secret" } },
                },
            }).success
        ).toBeFalse();
    });

    test("requires matching cache envelope and payload identities", () => {
        expect(
            v.parse(realtimeStreamDataSchema, {
                event: {
                    entityId: "system.host",
                    entityType: "cache-entry",
                    occurredAtMs: 1000,
                    operation: "updated",
                    payload: { key: "system.host" },
                    topic: cacheRealtimeTopic,
                },
                kind: "change",
            })
        ).toBeDefined();
        expect(
            v.safeParse(realtimeStreamDataSchema, {
                event: {
                    entityId: "system.host",
                    entityType: "cache-entry",
                    occurredAtMs: 1000,
                    operation: "updated",
                    payload: { key: "system.other" },
                    topic: cacheRealtimeTopic,
                },
                kind: "change",
            }).success
        ).toBeFalse();
    });

    test("rejects mismatched durable job entity and payload identities", () => {
        const runId = "018f6f50-6a9e-7b88-8000-000000000001";
        const mismatchedChanges = [
            {
                entityId: runId,
                entityType: "job-run",
                occurredAtMs: 1000,
                operation: "updated",
                payload: { id: "system.worker-smoke" },
                topic: "jobs.runs",
            },
            {
                entityId: "queue",
                entityType: "job-queue",
                occurredAtMs: 1000,
                operation: "snapshot-required",
                payload: { id: runId },
                topic: "jobs.runs",
            },
            {
                entityId: "system.worker-smoke",
                entityType: "schedule",
                occurredAtMs: 1000,
                operation: "updated",
                payload: { id: "queue" },
                topic: "schedules.records",
            },
        ];

        for (const event of mismatchedChanges) {
            expect(
                v.safeParse(realtimeStreamDataSchema, { event, kind: "change" }).success
            ).toBeFalse();
        }
    });

    test("shares exact producer routing policies with the client contract", () => {
        expect(
            v.parse(monitoringRealtimeRoutingSchema, {
                entityType: "report",
                operation: "created",
                topic: monitoringRealtimeTopics.reports,
            })
        ).toEqual({
            entityType: "report",
            operation: "created",
            topic: monitoringRealtimeTopics.reports,
        });

        for (const routing of [
            {
                entityType: "report",
                operation: "updated",
                topic: monitoringRealtimeTopics.reports,
            },
            {
                entityType: "notification",
                operation: "created",
                topic: monitoringRealtimeTopics.incidents,
            },
        ]) {
            expect(v.safeParse(monitoringRealtimeRoutingSchema, routing).success).toBe(
                false
            );
        }
    });
});
