import { describe, expect, jest, test } from "bun:test";

import type { ScheduleSummary } from "../../contracts/jobModel.ts";
import { ScheduleEditor } from "./ScheduleEditor.tsx";

const { act, fireEvent, render, screen, waitFor } =
    await import("@testing-library/react");

const timestampMs = 1_800_000_000_000;

function intervalSchedule(): ScheduleSummary {
    return {
        actionKey: "system.worker-smoke",
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: timestampMs - 10_000,
        description: "Checks the worker without host mutation.",
        enabled: true,
        id: "system.worker-smoke",
        manualRunAvailable: true,
        name: "Worker smoke",
        nextRunAtMs: timestampMs + 60_000,
        priority: 0,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 30_000,
        updatedAtMs: timestampMs,
        version: 1,
    };
}

describe("schedule editor", () => {
    test("disables normalized cadence no-ops and submits only a semantic change", async () => {
        const onSave = jest.fn(async () => {});
        render(
            <ScheduleEditor busy={false} onSave={onSave} schedule={intervalSchedule()} />
        );

        const form = screen.getByRole("form", {
            name: "Edit Worker smoke schedule",
        });
        const interval = screen.getByLabelText("Interval (seconds)");
        const save = screen.getByRole("button", { name: "Save schedule" });
        expect(form).toHaveAttribute("novalidate");
        expect(save).toBeDisabled();

        act(() => {
            fireEvent.change(interval, { target: { value: "60.000" } });
        });
        expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
        expect(onSave).not.toHaveBeenCalled();

        act(() => {
            fireEvent.change(interval, { target: { value: "120" } });
        });
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Save schedule" })).toBeEnabled()
        );
        act(() => {
            fireEvent.submit(form);
        });
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith({
                intervalMs: 120_000,
                kind: "interval",
            })
        );
    });

    test("focuses a schema-invalid control after client-managed submission", async () => {
        const onSave = jest.fn(async () => {});
        render(
            <ScheduleEditor busy={false} onSave={onSave} schedule={intervalSchedule()} />
        );

        const interval = screen.getByLabelText("Interval (seconds)");
        act(() => {
            fireEvent.change(interval, { target: { value: "59" } });
            fireEvent.submit(
                screen.getByRole("form", { name: "Edit Worker smoke schedule" })
            );
        });

        const error = await screen.findByText(
            "Use an interval from 60 to 31,536,000 seconds"
        );
        expect(interval.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
        await waitFor(() => expect(interval).toHaveFocus());
        expect(onSave).not.toHaveBeenCalled();
    });
});
