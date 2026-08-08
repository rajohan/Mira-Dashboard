import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    findJobRealtimeTopicDefinition,
    jobChangePayloadSchema,
    jobRealtimeChangeSchemas,
    jobRealtimeEventContracts,
    jobRealtimeRoutingSchema,
    jobRealtimeTopicDefinitions,
    jobRealtimeTopics,
} from "./jobRealtime.ts";

const runId = "018f6f50-6a9e-7b88-8000-000000000001";

describe("durable job realtime contracts", () => {
    test("registers exact read-authorized topics and seven-day snapshots", () => {
        expect(jobRealtimeTopics).toEqual({
            runs: "jobs.runs",
            schedules: "schedules.records",
        });
        expect(
            jobRealtimeTopicDefinitions.map(({ capability, topic }) => ({
                capability,
                topic,
            }))
        ).toEqual([
            { capability: "jobs:read", topic: "jobs.runs" },
            { capability: "jobs:read", topic: "schedules.records" },
        ]);
        expect(
            jobRealtimeEventContracts.map(({ retention, snapshotProcedure, topic }) => ({
                retention,
                snapshotProcedure,
                topic,
            }))
        ).toEqual([
            {
                retention: "7 days",
                snapshotProcedure: "jobs.listRuns",
                topic: "jobs.runs",
            },
            {
                retention: "7 days",
                snapshotProcedure: "schedules.list",
                topic: "schedules.records",
            },
        ]);
        expect(findJobRealtimeTopicDefinition("jobs.runs")?.capability).toBe("jobs:read");
        expect(findJobRealtimeTopicDefinition("jobs.unknown")).toBeUndefined();
    });

    test("keeps run, queue-summary, and schedule producer routes distinct", () => {
        for (const route of [
            {
                entityType: "job-run",
                operation: "created",
                topic: "jobs.runs",
            },
            {
                entityType: "job-queue",
                operation: "snapshot-required",
                topic: "jobs.runs",
            },
            {
                entityType: "schedule",
                operation: "updated",
                topic: "schedules.records",
            },
        ]) {
            expect(v.safeParse(jobRealtimeRoutingSchema, route).success).toBeTrue();
        }

        for (const route of [
            {
                entityType: "job-queue",
                operation: "updated",
                topic: "jobs.runs",
            },
            {
                entityType: "schedule",
                operation: "snapshot-required",
                topic: "schedules.records",
            },
            {
                entityType: "job-run",
                operation: "created",
                topic: "schedules.records",
            },
        ]) {
            expect(v.safeParse(jobRealtimeRoutingSchema, route).success).toBeFalse();
        }
    });

    test("accepts compact IDs and validates client deliveries with exact entity shapes", () => {
        expect(v.parse(jobChangePayloadSchema, { id: runId })).toEqual({ id: runId });
        expect(v.parse(jobChangePayloadSchema, { id: "queue" })).toEqual({
            id: "queue",
        });
        expect(
            v.safeParse(jobChangePayloadSchema, { id: "Invalid ID" }).success
        ).toBeFalse();

        const changes = [
            {
                entityId: runId,
                entityType: "job-run",
                occurredAtMs: 1000,
                operation: "updated",
                payload: { id: runId },
                topic: "jobs.runs",
            },
            {
                entityId: "queue",
                entityType: "job-queue",
                occurredAtMs: 1000,
                operation: "snapshot-required",
                payload: { id: "queue" },
                topic: "jobs.runs",
            },
            {
                entityId: "system.worker-smoke",
                entityType: "schedule",
                occurredAtMs: 1000,
                operation: "updated",
                payload: { id: "system.worker-smoke" },
                topic: "schedules.records",
            },
        ];

        for (const [index, schema] of jobRealtimeChangeSchemas.entries()) {
            expect(v.safeParse(schema, changes[index]).success).toBeTrue();
        }
    });
});
