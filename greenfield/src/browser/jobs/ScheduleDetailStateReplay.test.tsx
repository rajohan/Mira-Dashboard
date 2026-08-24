import { describe, expect, jest, test } from "bun:test";

import {
    enabledSchedule,
    renderScheduleDetail,
    scheduleId,
    timestampMs,
} from "./testSupport/ScheduleDetail.tsx";

const { screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("schedule detail interaction state", () => {
    test("allows an explicit idempotent retry while the refreshed schedule has an active run", async () => {
        const onRun = jest.fn(async () => {});
        renderScheduleDetail({
            onRun,
            runReplayAvailable: true,
            schedule: {
                ...enabledSchedule(),
                activeRun: {
                    actionKey: scheduleId,
                    attemptCount: 0,
                    attemptLimit: 3,
                    availableAtMs: timestampMs,
                    cancellationPolicy: "cooperative",
                    displayName: "Worker smoke manual run",
                    eventCount: 1,
                    id: "019fdf90-0000-7000-8000-000000000004",
                    priority: 0,
                    queuedAtMs: timestampMs,
                    resourceClass: "light",
                    resourceKeys: [],
                    retrySafe: true,
                    scheduledJobId: scheduleId,
                    scheduledJobVersion: 1,
                    state: "queued",
                    stateVersion: 1,
                    timeoutMs: 30_000,
                    triggerType: "manual",
                    updatedAtMs: timestampMs,
                },
            },
        });
        const user = userEvent.setup();

        const retry = screen.getByRole("button", { name: "Retry run request" });
        expect(retry).toBeEnabled();
        await user.click(retry);
        expect(onRun).toHaveBeenCalledTimes(1);
    });
});
