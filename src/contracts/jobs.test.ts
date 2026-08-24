import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    getJobRunInputSchema,
    jobProcedureContracts,
    jobRunDetailSchema,
    jobRunPageMaximum,
    listJobRunsInputSchema,
    listJobRunsResultSchema,
} from "./jobs.ts";

const firstRunId = "018f6f50-6a9e-7b88-8000-000000000002";
const secondRunId = "018f6f50-6a9e-7b88-8000-000000000001";

function queuedRun(id: string, queuedAtMs: number) {
    return {
        actionKey: "system.worker-smoke",
        attemptCount: 0,
        attemptLimit: 3,
        availableAtMs: queuedAtMs,
        cancellationPolicy: "cooperative" as const,
        displayName: "Worker smoke",
        eventCount: 1,
        id,
        priority: 0,
        queuedAtMs,
        resourceClass: "light" as const,
        resourceKeys: ["database"],
        retrySafe: true,
        scheduledJobId: "system.worker-smoke",
        scheduledJobVersion: 1,
        state: "queued" as const,
        stateVersion: 1,
        timeoutMs: 30_000,
        triggerType: "manual" as const,
        updatedAtMs: queuedAtMs,
    };
}

function queueSummary() {
    return {
        activeResourceClasses: [],
        control: { claimingPaused: false, updatedAtMs: 500, version: 1 },
        oldestQueuedAtMs: 1000,
        stateCounts: {
            cancelled: 0,
            failed: 0,
            queued: 2,
            running: 0,
            succeeded: 0,
            "timed-out": 0,
        },
        workers: [],
    };
}

describe("job procedure contracts", () => {
    test("locks the four procedures to read or session-only write access", () => {
        expect(
            jobProcedureContracts.map(({ access, kind, name, transport }) => ({
                access,
                batching: transport.batching,
                kind,
                name,
            }))
        ).toEqual([
            {
                access: {
                    capabilities: ["jobs:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                batching: "adapter-default",
                kind: "query",
                name: "jobs.listRuns",
            },
            {
                access: {
                    capabilities: ["jobs:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                batching: "adapter-default",
                kind: "query",
                name: "jobs.getRun",
            },
            {
                access: {
                    capabilities: ["jobs:write"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                batching: "forbidden",
                kind: "mutation",
                name: "jobs.cancelRun",
            },
            {
                access: {
                    capabilities: ["jobs:write"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                batching: "forbidden",
                kind: "mutation",
                name: "jobs.setClaimingPaused",
            },
        ]);
    });

    test("defaults and bounds stable run and event requests", () => {
        expect(v.parse(listJobRunsInputSchema, {})).toEqual({ limit: 50 });
        expect(
            v.parse(listJobRunsInputSchema, {
                cursor: { id: firstRunId, queuedAtMs: 2000 },
                filters: {
                    resourceClasses: ["light"],
                    scheduleId: "system.worker-smoke",
                    states: ["queued", "running"],
                    triggerTypes: ["manual"],
                },
                limit: jobRunPageMaximum,
            }).limit
        ).toBe(jobRunPageMaximum);

        for (const input of [
            { limit: 0 },
            { limit: jobRunPageMaximum + 1 },
            { filters: { states: ["queued", "queued"] } },
            { filters: { resourceClasses: [] } },
        ]) {
            expect(v.safeParse(listJobRunsInputSchema, input).success).toBeFalse();
        }

        expect(v.parse(getJobRunInputSchema, { id: firstRunId })).toEqual({
            eventLimit: 50,
            id: firstRunId,
        });
    });

    test("requires newest-first rows and an exact continuation cursor", () => {
        const runs = [queuedRun(firstRunId, 2000), queuedRun(secondRunId, 1000)];
        expect(
            v
                .parse(listJobRunsResultSchema, {
                    nextCursor: { id: secondRunId, queuedAtMs: 1000 },
                    runs,
                    summary: queueSummary(),
                })
                .runs.map(({ id }) => id)
        ).toEqual([firstRunId, secondRunId]);

        for (const result of [
            { runs: runs.toReversed(), summary: queueSummary() },
            {
                nextCursor: { id: firstRunId, queuedAtMs: 2000 },
                runs,
                summary: queueSummary(),
            },
            {
                runs,
                summary: {
                    ...queueSummary(),
                    oldestQueuedAtMs: undefined,
                },
            },
        ]) {
            expect(v.safeParse(listJobRunsResultSchema, result).success).toBeFalse();
        }
    });

    test("validates redacted successful detail and bounded newest-first events", () => {
        const run = {
            ...queuedRun(firstRunId, 1000),
            attemptCount: 1,
            eventCount: 3,
            finishedAtMs: 3000,
            firstStartedAtMs: 2000,
            lastAttemptStartedAtMs: 2000,
            state: "succeeded" as const,
            stateVersion: 3,
            updatedAtMs: 3000,
        };
        const events = [
            {
                attempt: 1,
                kind: "succeeded" as const,
                occurredAtMs: 3000,
                sequence: 3,
            },
            {
                attempt: 1,
                kind: "claimed" as const,
                occurredAtMs: 2000,
                sequence: 2,
            },
        ];
        expect(
            v.parse(jobRunDetailSchema, {
                events,
                nextEventCursor: { sequence: 2 },
                result: { status: "ok" },
                run,
            }).result
        ).toEqual({ status: "ok" });

        for (const detail of [
            { events, run },
            { events: events.toReversed(), result: { status: "ok" }, run },
            {
                events,
                nextEventCursor: { sequence: 3 },
                result: { status: "ok" },
                run,
            },
            {
                events: [{ ...events[0], sequence: 4 }],
                result: { status: "ok" },
                run,
            },
            {
                events,
                payload: { hidden: true },
                result: { status: "ok" },
                run,
            },
        ]) {
            expect(v.safeParse(jobRunDetailSchema, detail).success).toBeFalse();
        }
    });

    test("declares stable sorted error sets", () => {
        expect(
            jobProcedureContracts.map(({ errors, name }) => ({ errors, name }))
        ).toEqual([
            { errors: ["FORBIDDEN", "UNAUTHORIZED"], name: "jobs.listRuns" },
            {
                errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
                name: "jobs.getRun",
            },
            {
                errors: [
                    "CONFLICT",
                    "FORBIDDEN",
                    "NOT_FOUND",
                    "SERVICE_UNAVAILABLE",
                    "UNAUTHORIZED",
                ],
                name: "jobs.cancelRun",
            },
            {
                errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
                name: "jobs.setClaimingPaused",
            },
        ]);
    });
});
