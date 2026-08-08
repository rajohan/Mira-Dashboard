import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    eventsStreamContract,
    realtimeStreamCapabilities,
    realtimeStreamInputSchema,
    realtimeStreamOutputSchema,
    realtimeTopicDefinitions,
} from "./events.ts";
import {
    monitoringRealtimeRoutingSchema,
    monitoringRealtimeTopics,
} from "./monitoringRealtime.ts";

describe("realtime transport contracts", () => {
    test("documents only capabilities required by registered topics", () => {
        expect(realtimeStreamCapabilities).toEqual([
            "agents:read",
            "jobs:read",
            "notifications:read",
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
