import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import type { ScheduleSummary } from "../../contracts/jobModel.ts";
import {
    scheduleConfigurationFromEditor,
    scheduleEditorFormSchema,
    scheduleEditorValues,
} from "./scheduleEditorForm.ts";

const runId = "019fdf60-0000-7000-8000-000000000001";

function schedule(configuration: ScheduleSummary["schedule"]): ScheduleSummary {
    return {
        actionKey: "system.worker-smoke",
        attemptLimit: 2,
        cancellationPolicy: "cooperative",
        createdAtMs: 1000,
        description: "Checks the durable worker.",
        enabled: true,
        id: "system.worker-smoke",
        latestRun: {
            actionKey: "system.worker-smoke",
            attemptCount: 0,
            attemptLimit: 2,
            availableAtMs: 2000,
            cancellationPolicy: "cooperative",
            displayName: "Worker smoke",
            eventCount: 1,
            id: runId,
            priority: 0,
            queuedAtMs: 2000,
            resourceClass: "light",
            resourceKeys: [],
            retrySafe: true,
            scheduledJobId: "system.worker-smoke",
            scheduledJobVersion: 1,
            state: "queued",
            stateVersion: 1,
            timeoutMs: 60_000,
            triggerType: "manual",
            updatedAtMs: 2000,
        },
        name: "Worker smoke",
        nextRunAtMs: 120_000,
        priority: 0,
        resourceClass: "light",
        resourceKeys: [],
        retrySafe: true,
        schedule: configuration,
        timeoutMs: 60_000,
        updatedAtMs: 1000,
        version: 1,
    };
}

describe("schedule editor form", () => {
    test("round-trips each schedule variant", () => {
        const configurations = [
            { intervalMs: 64_001, kind: "interval" },
            { kind: "daily", timeOfDay: "07:30", timeZone: "Europe/Oslo" },
            { expression: "0 6 * * MON", kind: "cron", timeZone: "UTC" },
        ] as const;

        expect(
            configurations.map((configuration) =>
                scheduleConfigurationFromEditor(
                    v.parse(
                        scheduleEditorFormSchema,
                        scheduleEditorValues(schedule(configuration))
                    )
                )
            )
        ).toEqual([
            { intervalMs: 64_001, kind: "interval" },
            { kind: "daily", timeOfDay: "07:30", timeZone: "Europe/Oslo" },
            { expression: "0 6 * * 1", kind: "cron", timeZone: "UTC" },
        ]);
    });

    test("validates only fields owned by the selected variant", () => {
        const interval = scheduleEditorValues(
            schedule({ intervalMs: 60_000, kind: "interval" })
        );
        interval.cronExpression = "invalid";
        interval.timeOfDay = "invalid";
        interval.timeZone = "invalid";
        expect(v.safeParse(scheduleEditorFormSchema, interval).success).toBeTrue();

        for (const values of [
            { ...interval, intervalSeconds: "59.999" },
            { ...interval, intervalSeconds: "60.0001" },
            { ...interval, intervalSeconds: "31536001" },
            { ...interval, kind: "cron" as const },
            { ...interval, kind: "daily" as const },
        ]) {
            expect(v.safeParse(scheduleEditorFormSchema, values).success).toBeFalse();
        }
    });
});
