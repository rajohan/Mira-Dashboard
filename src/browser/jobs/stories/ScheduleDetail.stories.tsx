import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import * as v from "valibot";

import { scheduleSummarySchema } from "../../../contracts/jobModel.ts";
import { ScheduleDetail } from "../ScheduleDetail.tsx";

const timestampMs = 1_800_000_000_000;

const enabledSchedule = v.parse(scheduleSummarySchema, {
    actionKey: "system.worker-smoke",
    attemptLimit: 3,
    cancellationPolicy: "cooperative",
    createdAtMs: timestampMs - 10_000,
    description: "Checks the durable worker without host mutation.",
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
    version: 4,
});

const disabledSchedule = v.parse(scheduleSummarySchema, {
    ...enabledSchedule,
    activeDisableIntent: {
        createdAtMs: timestampMs,
        id: "019fe330-0000-7000-8000-000000000001",
        reason: "Paused during release qualification",
    },
    enabled: false,
    nextRunAtMs: undefined,
    version: 5,
});

const temporaryDisableIntentCreatedAtMs = Date.now();
const temporarilyDisabledSchedule = v.parse(scheduleSummarySchema, {
    ...disabledSchedule,
    activeDisableIntent: {
        ...disabledSchedule.activeDisableIntent,
        createdAtMs: temporaryDisableIntentCreatedAtMs,
        expiresAtMs: temporaryDisableIntentCreatedAtMs + 86_400_000,
    },
});

const history = (
    <p className="text-primary-400 text-sm">No recent runs in this story fixture.</p>
);

const meta = {
    args: {
        history,
        onDisable: fn(async () => {}),
        onEnable: fn(async () => {}),
        onOpenDisable: fn(),
        onRun: fn(async () => {}),
        onSaveConfiguration: fn(async () => {}),
        runBusy: false,
        schedule: enabledSchedule,
        updateBusy: false,
    },
    component: ScheduleDetail,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof ScheduleDetail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Enabled: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: "Run now" }));
        await expect(args.onRun).toHaveBeenCalledOnce();

        await userEvent.click(canvas.getByRole("button", { name: "Disable" }));
        await expect(args.onOpenDisable).toHaveBeenCalledOnce();
        const dialog = await waitFor(() =>
            within(canvasElement.ownerDocument.body).getByRole("dialog", {
                name: "Disable schedule",
            })
        );
        const modal = within(dialog);
        await userEvent.click(modal.getByRole("radio", { name: /Indefinitely/u }));
        await userEvent.type(modal.getByLabelText("Comment"), "Release maintenance");
        await userEvent.click(modal.getByRole("button", { name: "Disable schedule" }));

        await waitFor(async () => {
            await expect(args.onDisable).toHaveBeenCalledWith(
                { reason: "Release maintenance" },
                enabledSchedule.version
            );
            await expect(
                canvas.getByRole("heading", { level: 2, name: "Worker smoke" })
            ).toHaveFocus();
        });
    },
};

export const DisabledWithIntent: Story = {
    args: {
        schedule: disabledSchedule,
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByText("Paused during release qualification")
        ).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "Enable" }));
        await expect(args.onEnable).toHaveBeenCalledOnce();
    },
};

export const DisabledUntilDate: Story = {
    args: {
        schedule: temporarilyDisabledSchedule,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            canvas.getByRole("button", { name: "Edit disabled state" })
        );
        const dialog = await waitFor(() =>
            within(canvasElement.ownerDocument.body).getByRole("dialog", {
                name: "Edit disabled state",
            })
        );
        const modal = within(dialog);
        await expect(modal.getByRole("group", { name: "Disabled until" })).toBeVisible();
        const dateTrigger = modal.getByRole("button", {
            name: /Choose Disabled until date/u,
        });
        await expect(
            modal.getByRole("button", { name: "Time (24-hour), hour" })
        ).toBeVisible();
        await expect(
            modal.getByRole("button", { name: "Time (24-hour), minute" })
        ).toBeVisible();

        await userEvent.click(dateTrigger);
        await waitFor(async () => {
            const panelId = dateTrigger.getAttribute("aria-controls");
            const panel =
                panelId === null
                    ? undefined
                    : canvasElement.ownerDocument.querySelector<HTMLElement>(
                          `#${CSS.escape(panelId)}`
                      );
            if (!(panel instanceof HTMLElement)) {
                throw new Error("The disable date calendar did not open.");
            }
            await expect(within(panel).getByRole("grid")).toBeVisible();
        });
        await userEvent.keyboard("{Escape}");
        await userEvent.click(modal.getByRole("button", { name: "Cancel" }));
        await waitFor(async () => await expect(dialog).not.toBeInTheDocument());
    },
};

export const FailureAndBusy: Story = {
    args: {
        error: "The schedule update could not be persisted.",
        runBusy: true,
        updateBusy: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByText("The schedule update could not be persisted.")
        ).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Starting…" })).toBeDisabled();
    },
};
