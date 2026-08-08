import { describe, expect, test } from "bun:test";

import {
    createJobMutationSideEffects,
    createJobRealtimeSideEffects,
} from "./sideEffects.ts";

const auditId = "018f6f50-6a9e-7b88-8000-000000000001";
const runId = "018f6f50-6a9e-7b88-8000-000000000002";

describe("jobs mutation side effects", () => {
    test("builds one redacted audit row and compact run invalidation", () => {
        const occurredAt = new Date(1000);
        const sideEffects = createJobMutationSideEffects({
            action: "jobs.run.enqueue",
            actor: {
                authenticatorId: "a".repeat(32),
                id: "018f6f50-6a9e-7b88-8000-000000000003",
                kind: "user",
            },
            auditId,
            occurredAt,
            outcome: "accepted",
            realtime: { id: runId, kind: "run", operation: "created" },
            requestId: "request-1",
            targetId: runId,
            targetType: "job-run",
        });

        expect(sideEffects.auditEvents).toEqual([
            {
                action: "jobs.run.enqueue",
                actorId: "018f6f50-6a9e-7b88-8000-000000000003",
                actorKind: "user",
                authenticatorId: "a".repeat(32),
                id: auditId,
                metadataJson: "{}",
                occurredAt,
                outcome: "accepted",
                requestId: "request-1",
                targetId: runId,
                targetType: "job-run",
            },
        ]);
        expect(sideEffects.realtimeEvents).toEqual([
            {
                entityId: runId,
                entityType: "job-run",
                expiresAt: new Date(604_801_000),
                occurredAt,
                operation: "created",
                payloadJson: JSON.stringify({ id: runId }),
                topic: "jobs.runs",
            },
        ]);
        expect(Object.isFrozen(sideEffects)).toBeTrue();
    });

    test("builds a queue snapshot without a phantom run identity", () => {
        const sideEffects = createJobMutationSideEffects({
            action: "jobs.claim.pause",
            actor: { authenticatorId: null, id: "jobs-worker", kind: "system" },
            auditId,
            occurredAt: new Date(1000),
            outcome: "succeeded",
            realtime: { id: "worker-control", kind: "queue" },
            targetId: "worker-control",
            targetType: "job-worker",
        });
        expect(sideEffects.realtimeEvents[0]).toMatchObject({
            entityId: "worker-control",
            entityType: "job-queue",
            operation: "snapshot-required",
            topic: "jobs.runs",
        });
    });

    test("builds realtime-only run invalidation for durable timeline events", () => {
        const occurredAt = new Date(2000);

        const sideEffects = createJobRealtimeSideEffects({
            occurredAt,
            realtime: { id: runId, kind: "run", operation: "updated" },
        });

        expect(sideEffects.auditEvents).toEqual([]);
        expect(sideEffects.realtimeEvents).toEqual([
            {
                entityId: runId,
                entityType: "job-run",
                expiresAt: new Date(604_802_000),
                occurredAt,
                operation: "updated",
                payloadJson: JSON.stringify({ id: runId }),
                topic: "jobs.runs",
            },
        ]);
        expect(Object.isFrozen(sideEffects.realtimeEvents)).toBeTrue();
    });
});
