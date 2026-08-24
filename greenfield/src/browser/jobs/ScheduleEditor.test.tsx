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

function cronSchedule(): ScheduleSummary {
    return {
        ...intervalSchedule(),
        schedule: {
            expression: "0 6 * * 1-5",
            kind: "cron",
            timeZone: "UTC",
        },
    };
}

describe("schedule editor", () => {
    test("balances the cron controls with a hidden schedule-type spacer", () => {
        render(
            <ScheduleEditor busy={false} onSave={jest.fn()} schedule={cronSchedule()} />
        );

        const form = screen.getByRole("form", {
            name: "Edit Worker smoke schedule",
        });
        const cronExpression = screen.getByLabelText("Cron expression");
        const spacer = form.querySelector<HTMLElement>("[data-cron-description-spacer]");
        const descriptionId = cronExpression.getAttribute("aria-describedby");
        const helper =
            descriptionId === null
                ? null
                : document.querySelector<HTMLElement>(`[id="${descriptionId}"]`);

        expect(form).toHaveClass("sm:items-start");
        expect(spacer).toHaveClass("invisible", "select-none");
        expect(spacer).toHaveAttribute("aria-hidden", "true");
        expect(helper).toHaveTextContent("Order: minute, hour, day, month, weekday.");
        expect(cronExpression).toHaveAttribute("placeholder", "Example: 0 6 * * 1-5");
        expect(screen.getByLabelText("Time zone")).toHaveAttribute(
            "placeholder",
            "Example: Europe/Oslo"
        );
    });

    test("disables every cron control while a save is busy", () => {
        render(<ScheduleEditor busy onSave={jest.fn()} schedule={cronSchedule()} />);

        expect(screen.getByLabelText("Schedule type")).toBeDisabled();
        expect(screen.getByLabelText("Cron expression")).toBeDisabled();
        expect(screen.getByLabelText("Time zone")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Open Time zone" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    });

    test("disables normalized cadence no-ops and submits only a semantic change", async () => {
        const onSave = jest.fn(async () => {});
        render(
            <ScheduleEditor busy={false} onSave={onSave} schedule={intervalSchedule()} />
        );

        const form = screen.getByRole("form", {
            name: "Edit Worker smoke schedule",
        });
        const interval = screen.getByLabelText("Interval (seconds)");
        expect(interval).toHaveAttribute("placeholder", "Example: 300");
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
