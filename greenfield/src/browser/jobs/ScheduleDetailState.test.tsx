import { describe, expect, jest, test } from "bun:test";

import { maxTime } from "date-fns/constants";
import { useState } from "react";

import { ScheduleDetail } from "./ScheduleDetail.tsx";
import {
    disabledSchedule,
    enabledSchedule,
    renderScheduleDetail,
    scheduleId,
    timestampMs,
} from "./testSupport/ScheduleDetail.tsx";

const { fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("schedule detail interaction state", () => {
    test("keeps a rejected disable draft and its classified failure inside the dialog", async () => {
        const classifiedFailure =
            "The job state changed. Refresh the page and try again.";
        const onDisable = jest.fn();

        function RejectedDisableIntent() {
            const [error, setError] = useState<string>();
            return (
                <ScheduleDetail
                    disableError={error}
                    history={<p>Run history</p>}
                    onDisable={(draft) => {
                        onDisable(draft);
                        setError(classifiedFailure);
                        return Promise.reject(new TypeError("conflict"));
                    }}
                    onEnable={async () => {}}
                    onOpenDisable={() => setError(undefined)}
                    onRun={async () => {}}
                    onSaveConfiguration={async () => {}}
                    runBusy={false}
                    schedule={enabledSchedule()}
                    updateBusy={false}
                />
            );
        }

        render(<RejectedDisableIntent />);
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Disable" }));
        const reason = screen.getByLabelText("Reason");
        await user.type(reason, "Keep this draft");
        await user.click(screen.getByRole("button", { name: "Disable schedule" }));

        const dialog = screen.getByRole("dialog");
        const alert = await within(dialog).findByRole("alert");
        expect(alert).toHaveTextContent(classifiedFailure);
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(reason).toHaveValue("Keep this draft");
        expect(onDisable).toHaveBeenCalledWith({ reason: "Keep this draft" });
        await waitFor(() => expect(alert).toHaveFocus());
    });

    test("keeps unrelated errors outside a freshly opened disable dialog", async () => {
        const onOpenDisable = jest.fn();
        renderScheduleDetail({
            error: "A background refresh failed.",
            onOpenDisable,
        });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Disable" }));

        expect(onOpenDisable).toHaveBeenCalledTimes(1);
        expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
        expect(screen.queryByText("A background refresh failed.")).toBeNull();
    });

    test("preserves the modal version and exact reason across a background refresh", async () => {
        const onDisable = jest.fn(async () => {});
        const schedule = enabledSchedule();
        const view = renderScheduleDetail({ onDisable, schedule });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Disable" }));
        fireEvent.change(screen.getByLabelText("Reason"), {
            target: { value: "  Planned maintenance  " },
        });
        view.rerender(
            <ScheduleDetail
                history={<p>Run history</p>}
                onDisable={onDisable}
                onEnable={async () => {}}
                onOpenDisable={() => {}}
                onRun={async () => {}}
                onSaveConfiguration={async () => {}}
                runBusy={false}
                schedule={{ ...schedule, updatedAtMs: timestampMs + 1000, version: 2 }}
                updateBusy={false}
            />
        );
        await user.click(screen.getByRole("button", { name: "Disable schedule" }));

        expect(onDisable).toHaveBeenCalledWith({ reason: "  Planned maintenance  " }, 1);
        await waitFor(() =>
            expect(
                screen.getByRole("heading", { level: 2, name: "Worker smoke" })
            ).toHaveFocus()
        );
    });

    test("wraps contract-valid schedule copy without horizontal overflow", () => {
        const longToken = "x".repeat(1000);
        renderScheduleDetail({
            schedule: {
                ...disabledSchedule(maxTime),
                activeDisableIntent: {
                    ...disabledSchedule(maxTime).activeDisableIntent!,
                    reason: longToken,
                },
                description: longToken,
                name: longToken,
            },
        });

        expect(screen.getByRole("heading", { level: 2, name: longToken })).toHaveClass(
            "wrap-anywhere"
        );
        for (const copy of screen.getAllByText(longToken)) {
            expect(copy).toHaveClass("wrap-anywhere");
        }
    });

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
