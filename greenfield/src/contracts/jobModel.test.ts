import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    jobResourceKeysSchema,
    jobRunEventMaximum,
    jobRunEventProgressMaximumBytes,
    jobRunEventProgressSchema,
    jobRunEventSchema,
    jobRunPayloadEventMaximum,
    jobRunSummarySchema,
    jobWorkerSummarySchema,
    normalizeScheduleCronExpression,
    scheduleConfigurationSchema,
    scheduleCronExpressionSchema,
    scheduleSummarySchema,
    scheduleTimeZoneSchema,
} from "./jobModel.ts";
import { canonicalScheduleTimeZones } from "./scheduleTimeZones.ts";

const runId = "018f6f50-6a9e-7b88-8000-000000000001";
const workerId = "018f6f50-6a9e-7b88-8000-000000000002";
const scheduleId = "system.worker-smoke";

function queuedRun() {
    return {
        actionKey: "system.worker-smoke",
        attemptCount: 0,
        attemptLimit: 3,
        availableAtMs: 1000,
        cancellationPolicy: "cooperative" as const,
        displayName: "Worker smoke",
        eventCount: 1,
        id: runId,
        priority: 0,
        queuedAtMs: 1000,
        resourceClass: "light" as const,
        resourceKeys: ["database"],
        retrySafe: true,
        scheduledJobId: scheduleId,
        scheduledJobVersion: 1,
        state: "queued" as const,
        stateVersion: 1,
        timeoutMs: 30_000,
        triggerType: "manual" as const,
        updatedAtMs: 1000,
    };
}

describe("durable job models", () => {
    test("accepts lifecycle-consistent run projections without internal execution data", () => {
        expect(v.parse(jobRunSummarySchema, queuedRun()).state).toBe("queued");

        const succeeded = {
            ...queuedRun(),
            attemptCount: 1,
            eventCount: 3,
            finishedAtMs: 3000,
            firstStartedAtMs: 2000,
            lastAttemptStartedAtMs: 2000,
            state: "succeeded",
            stateVersion: 3,
            updatedAtMs: 3000,
        };
        expect(v.parse(jobRunSummarySchema, succeeded).state).toBe("succeeded");

        expect(
            v.parse(jobRunSummarySchema, {
                ...queuedRun(),
                attemptCount: 1,
                availableAtMs: 60_000,
                eventCount: 4,
                firstStartedAtMs: 2000,
                lastAttemptStartedAtMs: 2000,
                stateVersion: 3,
                updatedAtMs: 3000,
            }).availableAtMs
        ).toBe(60_000);

        for (const extra of [
            { leaseToken: "018f6f50-6a9e-7b88-8000-000000000099" },
            { payload: { secret: true } },
            { workerInstanceId: workerId },
        ]) {
            expect(
                v.safeParse(jobRunSummarySchema, { ...queuedRun(), ...extra }).success
            ).toBeFalse();
        }
    });

    test("rejects inconsistent schedule provenance, attempts, terminal state, and time", () => {
        const invalidRuns = [
            { ...queuedRun(), scheduledJobVersion: undefined },
            {
                ...queuedRun(),
                scheduledJobId: undefined,
                scheduledJobVersion: undefined,
            },
            { ...queuedRun(), triggerType: "startup" },
            { ...queuedRun(), scheduledForAtMs: 500, triggerType: "manual" },
            {
                ...queuedRun(),
                scheduledForAtMs: 500,
                scheduledJobId: undefined,
                scheduledJobVersion: undefined,
                triggerType: "schedule",
            },
            { ...queuedRun(), attemptCount: 1 },
            { ...queuedRun(), attemptCount: 4 },
            { ...queuedRun(), state: "failed" },
            {
                ...queuedRun(),
                finishedAtMs: 900,
                state: "cancelled",
                terminalCode: "cancelled",
                terminalMessage: "Cancelled",
            },
            { ...queuedRun(), cancelRequestedAtMs: 1000, cancellationPolicy: "never" },
        ];

        for (const run of invalidRuns) {
            expect(v.safeParse(jobRunSummarySchema, run).success).toBeFalse();
        }
    });

    test("bounds and canonicalizes resources and durable event payloads", () => {
        expect(v.parse(jobResourceKeysSchema, ["database", "worker"])).toEqual([
            "database",
            "worker",
        ]);
        for (const keys of [
            ["worker", "database"],
            ["database", "database"],
            ["Database"],
        ]) {
            expect(v.safeParse(jobResourceKeysSchema, keys).success).toBeFalse();
        }

        expect(jobRunEventMaximum - jobRunPayloadEventMaximum).toBe(33);
        expect(
            v.safeParse(jobRunEventProgressSchema, {
                value: "x".repeat(jobRunEventProgressMaximumBytes),
            }).success
        ).toBeFalse();
        expect(
            v.parse(jobRunEventSchema, {
                attempt: 1,
                kind: "progress",
                occurredAtMs: 2000,
                progress: { percent: 50 },
                sequence: 2,
                workerInstanceId: workerId,
            }).sequence
        ).toBe(2);
        for (const event of [
            {
                attempt: 1,
                kind: "stdout",
                occurredAtMs: 2000,
                sequence: 2,
            },
            {
                attempt: 1,
                kind: "claimed",
                occurredAtMs: 2000,
                progress: { unexpected: true },
                sequence: 2,
            },
        ]) {
            expect(v.safeParse(jobRunEventSchema, event).success).toBeFalse();
        }
    });

    test("normalizes five-field cron aliases and ASCII whitespace before validation", () => {
        expect(normalizeScheduleCronExpression("  0\t9  *  JAN  MON-FRI ")).toBe(
            "0 9 * 1 1-5"
        );
        expect(v.parse(scheduleCronExpressionSchema, "0\t9 * JAN MON-FRI")).toBe(
            "0 9 * 1 1-5"
        );
        expect(
            v.parse(scheduleConfigurationSchema, {
                expression: "*/5 * * * *",
                kind: "cron",
                timeZone: "Europe/Oslo",
            })
        ).toEqual({
            expression: "*/5 * * * *",
            kind: "cron",
            timeZone: "Europe/Oslo",
        });

        for (const expression of [
            "0 */5 * * * *",
            "* * * *",
            "61 * * * *",
            "0 0 30 2 *",
            "*\u00A0* * * *",
            "0 9 * MON *",
            "0 9 * * JAN",
        ]) {
            expect(
                v.safeParse(scheduleCronExpressionSchema, expression).success
            ).toBeFalse();
        }
    });

    test("accepts explicit UTC and canonical IANA zones but rejects aliases and offsets", () => {
        expect(Object.isFrozen(canonicalScheduleTimeZones)).toBeTrue();
        expect(canonicalScheduleTimeZones).toEqual(
            [...canonicalScheduleTimeZones].toSorted()
        );
        expect(new Set(canonicalScheduleTimeZones).size).toBe(
            canonicalScheduleTimeZones.length
        );
        for (const timeZone of ["UTC", "Europe/Oslo", "America/New_York"]) {
            expect(canonicalScheduleTimeZones).toContain(timeZone);
            expect(v.parse(scheduleTimeZoneSchema, timeZone)).toBe(timeZone);
        }
        for (const timeZone of ["US/Eastern", "GMT", "+01:00", "local"]) {
            expect(canonicalScheduleTimeZones).not.toContain(timeZone);
            expect(v.safeParse(scheduleTimeZoneSchema, timeZone).success).toBeFalse();
        }
    });

    test("validates worker and schedule projections across state boundaries", () => {
        expect(
            v.parse(jobWorkerSummarySchema, {
                activeRunCount: 1,
                capacity: 2,
                heartbeatAtMs: 2000,
                id: workerId,
                releaseId: "a".repeat(40),
                startedAtMs: 1000,
                state: "online",
            }).state
        ).toBe("online");
        expect(
            v.parse(jobWorkerSummarySchema, {
                activeRunCount: 1,
                capacity: 2,
                drainingAtMs: 2500,
                heartbeatAtMs: 2600,
                id: workerId,
                releaseId: "a".repeat(40),
                startedAtMs: 1000,
                state: "draining",
            }).state
        ).toBe("draining");
        expect(
            v.parse(jobWorkerSummarySchema, {
                activeRunCount: 0,
                capacity: 2,
                drainingAtMs: 2500,
                heartbeatAtMs: 2600,
                id: workerId,
                releaseId: "a".repeat(40),
                startedAtMs: 1000,
                state: "stopped",
                stoppedAtMs: 3000,
            }).state
        ).toBe("stopped");
        expect(
            v.safeParse(jobWorkerSummarySchema, {
                activeRunCount: 3,
                capacity: 2,
                heartbeatAtMs: 2000,
                id: workerId,
                releaseId: "a".repeat(40),
                startedAtMs: 1000,
                state: "online",
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(jobWorkerSummarySchema, {
                activeRunCount: 1,
                capacity: 2,
                drainingAtMs: 2500,
                heartbeatAtMs: 2000,
                id: workerId,
                releaseId: "a".repeat(40),
                startedAtMs: 1000,
                state: "stopped",
                stoppedAtMs: 3000,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(jobWorkerSummarySchema, {
                activeRunCount: 0,
                capacity: 2,
                heartbeatAtMs: 2000,
                id: workerId,
                releaseId: "a".repeat(40),
                startedAtMs: 1000,
                state: "stopped",
                stoppedAtMs: 3000,
            }).success
        ).toBeFalse();

        const schedule = {
            actionKey: "system.worker-smoke",
            activeRun: queuedRun(),
            attemptLimit: 3,
            cancellationPolicy: "cooperative" as const,
            createdAtMs: 500,
            description: "Checks the worker without host mutation.",
            enabled: true,
            id: scheduleId,
            latestRun: queuedRun(),
            name: "Worker smoke",
            nextRunAtMs: 60_000,
            priority: 0,
            resourceClass: "light" as const,
            resourceKeys: ["database"],
            retrySafe: true,
            schedule: { intervalMs: 60_000, kind: "interval" as const },
            timeoutMs: 30_000,
            updatedAtMs: 1000,
            version: 1,
        };
        expect(v.parse(scheduleSummarySchema, schedule).id).toBe(scheduleId);
        expect(
            v.safeParse(scheduleSummarySchema, {
                ...schedule,
                activeRun: { ...queuedRun(), scheduledJobId: "other" },
            }).success
        ).toBeFalse();
    });
});
