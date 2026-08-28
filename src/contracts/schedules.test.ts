import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    listScheduleRunsResultSchema,
    listSchedulesInputSchema,
    listSchedulesResultSchema,
    runScheduleInputSchema,
    scheduleProcedureContracts,
    updateScheduleInputSchema,
} from "./schedules.ts";

const firstRunId = "018f6f50-6a9e-7b88-8000-000000000002";
const secondRunId = "018f6f50-6a9e-7b88-8000-000000000001";

function schedule(id: string, enabled: boolean) {
    return {
        actionKey: "system.worker-smoke",
        attemptLimit: 3,
        cancellationPolicy: "cooperative" as const,
        createdAtMs: 500,
        description: "Checks the worker without host mutation.",
        enabled,
        id,
        manualRunAvailable: true,
        name: "Worker smoke",
        ...(enabled ? { nextRunAtMs: 60_000 } : {}),
        priority: 0,
        resourceClass: "light" as const,
        resourceKeys: ["database"],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" as const },
        timeoutMs: 30_000,
        updatedAtMs: 1000,
        version: 1,
    };
}

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

describe("schedule procedure contracts", () => {
    test("locks reads, session edits, and exact-policy manual runs", () => {
        expect(
            scheduleProcedureContracts.map(({ access, kind, name, transport }) => ({
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
                name: "schedules.list",
            },
            {
                access: {
                    capabilities: ["jobs:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                batching: "adapter-default",
                kind: "query",
                name: "schedules.get",
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
                name: "schedules.update",
            },
            {
                access: {
                    capabilities: ["jobs:write"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                batching: "forbidden",
                kind: "mutation",
                name: "schedules.run",
            },
            {
                access: {
                    capabilities: ["jobs:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                batching: "adapter-default",
                kind: "query",
                name: "schedules.listRuns",
            },
        ]);
    });

    test("defaults filters and requires stable ascending schedule cursors", () => {
        expect(v.parse(listSchedulesInputSchema, {})).toEqual({
            enabled: "all",
            limit: 50,
        });
        const schedules = [schedule("alpha", false), schedule("zeta", true)];
        expect(
            v
                .parse(listSchedulesResultSchema, {
                    nextCursor: { id: "zeta" },
                    schedules,
                })
                .schedules.map(({ id }) => id)
        ).toEqual(["alpha", "zeta"]);

        expect(
            v.safeParse(listSchedulesResultSchema, {
                schedules: schedules.toReversed(),
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(listSchedulesResultSchema, {
                nextCursor: { id: "alpha" },
                schedules,
            }).success
        ).toBeFalse();
    });

    test("requires explicit disable intent transitions and canonical schedule variants", () => {
        expect(
            v.parse(updateScheduleInputSchema, {
                expectedVersion: 3,
                id: "system.worker-smoke",
                patch: {
                    disableIntent: {
                        expiresAtMs: 10_000,
                        reason: "Maintenance",
                    },
                    enabled: false,
                    schedule: {
                        expression: "0\t9 * JAN MON-FRI",
                        kind: "cron",
                        timeZone: "Europe/Oslo",
                    },
                },
            }).patch.schedule
        ).toEqual({
            expression: "0 9 * 1 1-5",
            kind: "cron",
            timeZone: "Europe/Oslo",
        });
        expect(
            v.parse(updateScheduleInputSchema, {
                expectedVersion: 3,
                id: "system.worker-smoke",
                patch: { disableIntent: null, enabled: true },
            }).patch.enabled
        ).toBeTrue();

        for (const patch of [
            {},
            { enabled: false },
            { disableIntent: null, enabled: false },
            { enabled: true },
            { disableIntent: { reason: "Maintenance" } },
            {
                disableIntent: { reason: "Maintenance" },
                schedule: { kind: "interval", intervalMs: 60_000 },
            },
        ]) {
            expect(
                v.safeParse(updateScheduleInputSchema, {
                    expectedVersion: 3,
                    id: "system.worker-smoke",
                    patch,
                }).success
            ).toBeFalse();
        }
    });

    test("accepts a canonical caller idempotency key and rejects padded tokens", () => {
        const idempotencyKey = "aB_9-".repeat(7).slice(0, 32);
        expect(
            v.parse(runScheduleInputSchema, {
                id: "system.worker-smoke",
                idempotencyKey,
            }).idempotencyKey
        ).toBe(idempotencyKey);
        expect(
            v.safeParse(runScheduleInputSchema, {
                id: "system.worker-smoke",
                idempotencyKey: `${idempotencyKey}=`,
            }).success
        ).toBeFalse();
        for (const nonCanonical of [
            "A".repeat(33),
            `${"A".repeat(33)}B`,
            `${"A".repeat(34)}B`,
        ]) {
            expect(
                v.safeParse(runScheduleInputSchema, {
                    id: "system.worker-smoke",
                    idempotencyKey: nonCanonical,
                }).success
            ).toBeFalse();
        }
    });

    test("validates newest-first schedule run pages and exact cursors", () => {
        const runs = [queuedRun(firstRunId, 2000), queuedRun(secondRunId, 1000)];
        expect(
            v.parse(listScheduleRunsResultSchema, {
                nextCursor: { id: secondRunId, queuedAtMs: 1000 },
                runs,
            }).runs.length
        ).toBe(2);
        expect(
            v.safeParse(listScheduleRunsResultSchema, {
                nextCursor: { id: firstRunId, queuedAtMs: 2000 },
                runs,
            }).success
        ).toBeFalse();
    });

    test("declares BAD_REQUEST only where time-dependent intent validation needs it", () => {
        expect(
            scheduleProcedureContracts.map(({ errors, name }) => ({ errors, name }))
        ).toEqual([
            { errors: ["FORBIDDEN", "UNAUTHORIZED"], name: "schedules.list" },
            {
                errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
                name: "schedules.get",
            },
            {
                errors: [
                    "BAD_REQUEST",
                    "CONFLICT",
                    "FORBIDDEN",
                    "NOT_FOUND",
                    "SERVICE_UNAVAILABLE",
                    "UNAUTHORIZED",
                ],
                name: "schedules.update",
            },
            {
                errors: [
                    "CONFLICT",
                    "FORBIDDEN",
                    "NOT_FOUND",
                    "SERVICE_UNAVAILABLE",
                    "UNAUTHORIZED",
                ],
                name: "schedules.run",
            },
            {
                errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
                name: "schedules.listRuns",
            },
        ]);
    });

    test("declares conditional manual-run identity verification", () => {
        const run = scheduleProcedureContracts.find(
            ({ name }) => name === "schedules.run"
        );
        expect(
            run !== undefined && "errorReasons" in run ? run.errorReasons : []
        ).toEqual(["mfa_enrollment_required", "step_up_required"]);
    });
});
