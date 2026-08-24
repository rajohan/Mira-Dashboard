import { describe, expect, jest, test } from "bun:test";

import type { ScheduleSummary } from "../../contracts/jobModel.ts";
import { scheduleConfigurationLabel } from "./schedulePresentation.ts";
import { ScheduleTable } from "./ScheduleTable.tsx";

const { render, screen } = await import("@testing-library/react");

function schedule(id: string, index: number): ScheduleSummary {
    return {
        actionKey: "system.worker-smoke",
        attemptLimit: 2,
        cancellationPolicy: "cooperative",
        createdAtMs: 1000,
        description: "Checks the durable worker.",
        enabled: index % 2 === 0,
        id,
        manualRunAvailable: true,
        name: `Worker smoke ${index}`,
        ...(index % 2 === 0 ? { nextRunAtMs: 120_000 } : {}),
        priority: 0,
        resourceClass: "light",
        resourceKeys: [],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 60_000,
        updatedAtMs: 1000,
        version: 1,
        ...(index % 2 === 0
            ? {}
            : {
                  activeDisableIntent: {
                      createdAtMs: 1000,
                      id: `019fdf60-0000-7000-8000-${String(index).padStart(12, "0")}`,
                      reason: "Maintenance",
                  },
              }),
    };
}

describe("schedule table", () => {
    test("renders stable schedule state and selectable identity", () => {
        const onSelect = jest.fn();
        render(
            <ScheduleTable
                onSelect={onSelect}
                schedules={[
                    schedule("system.worker-smoke", 0),
                    schedule("system.worker-smoke-disabled", 1),
                ]}
                selectedId="system.worker-smoke"
            />
        );

        screen
            .getByRole("button", {
                name: "Worker smoke 1; system.worker-smoke-disabled",
            })
            .click();
        expect(onSelect).toHaveBeenCalledWith("system.worker-smoke-disabled");
        expect(screen.getByText("Enabled")).toBeTruthy();
        expect(screen.getByText("Disabled")).toBeTruthy();
    });

    test("formats every schedule variant without losing contract values", () => {
        expect(scheduleConfigurationLabel({ intervalMs: 60_500, kind: "interval" })).toBe(
            "Every 60.5 seconds"
        );
        expect(
            scheduleConfigurationLabel({
                kind: "daily",
                timeOfDay: "07:30",
                timeZone: "Europe/Oslo",
            })
        ).toBe("Daily 07:30 · Europe/Oslo");
        expect(
            scheduleConfigurationLabel({
                expression: "0 6 * * 1",
                kind: "cron",
                timeZone: "UTC",
            })
        ).toBe("0 6 * * 1 · UTC");
    });
});
