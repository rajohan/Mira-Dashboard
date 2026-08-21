import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import * as v from "valibot";

import {
    type ScheduleConfiguration,
    scheduleSummarySchema,
} from "../../../contracts/jobModel.ts";
import { ScheduleEditor } from "../ScheduleEditor.tsx";

const timestampMs = 1_800_000_000_000;

function schedule(configuration: ScheduleConfiguration) {
    return v.parse(scheduleSummarySchema, {
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
        schedule: configuration,
        timeoutMs: 30_000,
        updatedAtMs: timestampMs,
        version: 1,
    });
}

const intervalSchedule = schedule({ intervalMs: 60_000, kind: "interval" });
const dailySchedule = schedule({
    kind: "daily",
    timeOfDay: "05:30",
    timeZone: "Europe/Oslo",
});
const cronSchedule = schedule({
    expression: "0 6 * * 1-5",
    kind: "cron",
    timeZone: "UTC",
});

const meta = {
    args: {
        busy: false,
        onSave: fn(async () => {}),
        schedule: intervalSchedule,
    },
    component: ScheduleEditor,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof ScheduleEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

export const IntervalConfiguration: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const interval = canvas.getByLabelText("Interval (seconds)");
        const save = canvas.getByRole("button", { name: "Save schedule" });
        await expect(save).toBeDisabled();

        await userEvent.clear(interval);
        await userEvent.type(interval, "120");
        await waitFor(async () => {
            await expect(
                canvas.getByRole("button", { name: "Save schedule" })
            ).toBeEnabled();
        });
        await userEvent.click(canvas.getByRole("button", { name: "Save schedule" }));
        await waitFor(async () => {
            await expect(args.onSave).toHaveBeenCalledWith({
                intervalMs: 120_000,
                kind: "interval",
            });
        });
    },
};

export const InvalidSubmission: Story = {
    args: {
        onSave: fn(async () => {}),
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const interval = canvas.getByLabelText("Interval (seconds)");
        const save = canvas.getByRole("button", { name: "Save schedule" });

        await userEvent.clear(interval);
        await userEvent.type(interval, "59");
        await waitFor(async () => {
            await expect(save).toBeEnabled();
        });
        await userEvent.click(save);

        const error = await canvas.findByText(
            "Use an interval from 60 to 31,536,000 seconds"
        );
        const descriptionIds = interval.getAttribute("aria-describedby")?.split(" ");
        await expect(error).toBeVisible();
        await expect(interval).toHaveAttribute("aria-invalid", "true");
        await expect(descriptionIds).toContain(error.id);
        await waitFor(async () => {
            await expect(interval).toHaveFocus();
        });
        await expect(save).toBeDisabled();
        await expect(args.onSave).not.toHaveBeenCalled();
    },
};

export const IntervalToDailyTransition: Story = {
    args: {
        onSave: fn(async () => {}),
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        const scheduleType = canvas.getByLabelText("Schedule type");

        await userEvent.click(scheduleType);
        await userEvent.click(page.getByRole("option", { name: /^Daily/u }));
        await waitFor(async () => {
            await expect(scheduleType).toHaveTextContent("Daily");
            await expect(canvas.queryByLabelText("Interval (seconds)")).toBeNull();
            await expect(
                canvas.getByRole("group", { name: "Time of day (24-hour)" })
            ).toBeVisible();
            await expect(canvas.getByLabelText("Time zone")).toHaveValue("UTC");
        });

        await userEvent.click(
            canvas.getByRole("button", {
                name: "Time of day (24-hour), hour",
            })
        );
        await userEvent.click(page.getByRole("option", { name: "06" }));
        await userEvent.click(
            canvas.getByRole("button", {
                name: "Time of day (24-hour), minute",
            })
        );
        await userEvent.click(page.getByRole("option", { name: "45" }));

        const timeZone = canvas.getByLabelText("Time zone");
        await userEvent.clear(timeZone);
        await userEvent.type(timeZone, "Europe/Oslo");
        await userEvent.click(page.getByRole("option", { name: "Europe/Oslo" }));

        await expect(
            canvas.getByRole("button", {
                name: "Time of day (24-hour), hour",
            })
        ).toHaveTextContent("06");
        await expect(
            canvas.getByRole("button", {
                name: "Time of day (24-hour), minute",
            })
        ).toHaveTextContent("45");
        await expect(timeZone).toHaveValue("Europe/Oslo");
        await expect(args.onSave).not.toHaveBeenCalled();

        const save = canvas.getByRole("button", { name: "Save schedule" });
        await waitFor(async () => {
            await expect(save).toBeEnabled();
        });
        await userEvent.click(save);
        await waitFor(async () => {
            await expect(args.onSave).toHaveBeenCalledTimes(1);
            await expect(args.onSave).toHaveBeenLastCalledWith({
                kind: "daily",
                timeOfDay: "06:45",
                timeZone: "Europe/Oslo",
            });
        });
    },
};

export const DailyConfiguration: Story = {
    args: {
        schedule: dailySchedule,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("group", { name: "Time of day (24-hour)" })
        ).toBeVisible();
        await expect(
            canvas.getByRole("button", {
                name: "Time of day (24-hour), hour",
            })
        ).toHaveTextContent("05");
        await expect(
            canvas.getByRole("button", {
                name: "Time of day (24-hour), minute",
            })
        ).toHaveTextContent("30");
        await expect(canvas.getByLabelText("Time zone")).toHaveValue("Europe/Oslo");
    },
};

export const CronConfiguration: Story = {
    args: {
        schedule: cronSchedule,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const cronExpression = canvas.getByLabelText("Cron expression");
        const scheduleType = canvas.getByLabelText("Schedule type");
        const descriptionId = cronExpression.getAttribute("aria-describedby");
        const helper =
            descriptionId === null
                ? null
                : canvasElement.ownerDocument.querySelector<HTMLElement>(
                      `[id="${descriptionId}"]`
                  );
        await expect(cronExpression).toHaveValue("0 6 * * 1-5");
        await expect(canvas.getByLabelText("Time zone")).toHaveValue("UTC");
        await expect(
            canvasElement.querySelector("[data-cron-description-spacer]")
        ).toBeNull();
        await expect(helper).toHaveTextContent(
            "Order: minute, hour, day, month, weekday."
        );
        await waitFor(async () => {
            await expect(
                Math.abs(
                    scheduleType.getBoundingClientRect().top -
                        cronExpression.getBoundingClientRect().top
                )
            ).toBeLessThan(1);
        });
    },
};

export const Busy: Story = {
    args: {
        busy: true,
        schedule: cronSchedule,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByLabelText("Cron expression")).toBeDisabled();
        await expect(canvas.getByLabelText("Time zone")).toBeDisabled();
        await expect(
            canvas.getByRole("button", { name: "Open Time zone" })
        ).toBeDisabled();
        await expect(canvas.getByRole("button", { name: "Saving…" })).toBeDisabled();
    },
};
