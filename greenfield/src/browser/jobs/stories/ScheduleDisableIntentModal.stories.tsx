import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import * as v from "valibot";

import {
    scheduleSummarySchema,
    type ScheduleSummary,
} from "../../../contracts/jobModel.ts";
import { ScheduleDisableIntentModal } from "../ScheduleDisableIntentModal.tsx";

const dayMilliseconds = 24 * 60 * 60 * 1000;
const temporaryDisableWindowMilliseconds = 30 * dayMilliseconds;

interface DisabledScheduleOptions {
    readonly expiresAtMs?: number;
    readonly nowMs?: number;
    readonly reason: string;
}

function disabledSchedule({
    expiresAtMs,
    nowMs = Date.now(),
    reason,
}: DisabledScheduleOptions): ScheduleSummary {
    const disableIntentCreatedAtMs =
        expiresAtMs === undefined
            ? nowMs - 60_000
            : Math.min(nowMs - 60_000, expiresAtMs - 60_000);

    return v.parse(scheduleSummarySchema, {
        actionKey: "system.worker-smoke",
        activeDisableIntent: {
            createdAtMs: disableIntentCreatedAtMs,
            ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
            id: "019fe350-0000-7000-8000-000000000001",
            reason,
        },
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: nowMs - dayMilliseconds,
        description: "Checks the durable worker without host mutation.",
        enabled: false,
        id: "system.worker-smoke",
        manualRunAvailable: true,
        name: "Worker smoke",
        priority: 0,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 30_000,
        updatedAtMs: nowMs,
        version: 5,
    });
}

function enabledSchedule(nowMs = Date.now()): ScheduleSummary {
    return v.parse(scheduleSummarySchema, {
        actionKey: "system.worker-smoke",
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: nowMs - dayMilliseconds,
        description: "Checks the durable worker without host mutation.",
        enabled: true,
        id: "system.worker-smoke",
        manualRunAvailable: true,
        name: "Worker smoke",
        nextRunAtMs: nowMs + 60_000,
        priority: 0,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 30_000,
        updatedAtMs: nowMs,
        version: 4,
    });
}

function freshTemporarySchedule(): ScheduleSummary {
    const nowMs = Date.now();
    return disabledSchedule({
        expiresAtMs: nowMs + temporaryDisableWindowMilliseconds,
        nowMs,
        reason: "Paused while the release is qualified",
    });
}

async function expectEqualDurationCardHeights(dialog: HTMLElement): Promise<void> {
    const duration = within(dialog).getByRole("radiogroup", {
        name: "Disabled duration",
    });
    const radioCards = within(duration).getAllByRole("radio");

    await expect(duration).toHaveAttribute("aria-orientation", "horizontal");
    await expect(radioCards).toHaveLength(2);
    await waitFor(async () => {
        const expectedHeight = radioCards[0]?.getBoundingClientRect().height;
        await expect(expectedHeight).toBeGreaterThan(0);

        for (const radioCard of radioCards.slice(1)) {
            await expect(radioCard.getBoundingClientRect().height).toBeCloseTo(
                expectedHeight ?? 0,
                2
            );
        }
    });
}

const meta = {
    args: {
        busy: false,
        onClose: fn(),
        onSaved: fn(),
        onSubmit: fn(async () => {}),
        schedule: freshTemporarySchedule(),
    },
    component: ScheduleDisableIntentModal,
    parameters: {
        layout: "fullscreen",
    },
    title: "Jobs/ScheduleDisableIntentModal",
} satisfies Meta<typeof ScheduleDisableIntentModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FreshTemporaryUntil: Story = {
    play: async ({ canvasElement }) => {
        const page = within(canvasElement.ownerDocument.body);
        const dialog = await page.findByRole("dialog", {
            name: "Edit disabled state",
        });
        const modal = within(dialog);

        await expect(modal.getByRole("radio", { name: /Until a date/u })).toBeChecked();
        await expect(
            modal.getByRole("radio", { name: /Indefinitely/u })
        ).not.toBeChecked();
        await expect(modal.getByRole("group", { name: "Disabled until" })).toBeVisible();
        await expect(modal.getByLabelText("Comment")).toHaveValue(
            "Paused while the release is qualified"
        );
        await expect(
            modal.getByRole("button", { name: "Save disabled state" })
        ).toBeDisabled();
        await expectEqualDurationCardHeights(dialog);
    },
};

export const ExistingIndefinite: Story = {
    args: {
        schedule: disabledSchedule({
            reason: "Paused until the maintenance review is complete",
        }),
    },
    play: async ({ canvasElement }) => {
        const page = within(canvasElement.ownerDocument.body);
        const dialog = await page.findByRole("dialog", {
            name: "Edit disabled state",
        });
        const modal = within(dialog);

        await expect(modal.getByRole("radio", { name: /Indefinitely/u })).toBeChecked();
        await expect(modal.queryByRole("group", { name: "Disabled until" })).toBeNull();
        await expect(modal.getByLabelText("Comment")).toHaveValue(
            "Paused until the maintenance review is complete"
        );
        await expect(
            modal.getByRole("button", { name: "Save disabled state" })
        ).toBeDisabled();
    },
};

export const BusyAndError: Story = {
    args: {
        busy: true,
        error: "The schedule update could not be persisted.",
    },
    play: async ({ canvasElement }) => {
        const page = within(canvasElement.ownerDocument.body);
        const dialog = await page.findByRole("dialog", {
            name: "Edit disabled state",
        });
        const modal = within(dialog);

        await expect(modal.getByRole("alert")).toHaveTextContent(
            "The schedule update could not be persisted."
        );
        await expect(modal.getByLabelText("Comment")).toBeDisabled();
        await expect(modal.getByRole("radio", { name: /Until a date/u })).toHaveAttribute(
            "aria-disabled",
            "true"
        );
        await expect(modal.getByRole("button", { name: "Cancel" })).toBeDisabled();
        await expect(modal.getByRole("button", { name: "Saving…" })).toBeDisabled();
        await expect(
            modal.queryByRole("button", { name: "Close dialog" })
        ).not.toBeInTheDocument();
    },
};

export const InvalidSubmission: Story = {
    args: {
        schedule: enabledSchedule(),
    },
    play: async ({ args, canvasElement }) => {
        const page = within(canvasElement.ownerDocument.body);
        const dialog = await page.findByRole("dialog", {
            name: "Disable schedule",
        });
        const modal = within(dialog);
        const form = modal.getByRole("form", { name: "Disable schedule" });
        const comment = modal.getByLabelText("Comment");

        await userEvent.click(modal.getByRole("button", { name: "Disable schedule" }));

        const error = await modal.findByText("Enter between 1 and 1,000 characters.");
        const descriptionIds = comment.getAttribute("aria-describedby")?.split(" ");
        await expect(error).toBeVisible();
        await expect(comment).toHaveAttribute("data-invalid");
        await expect(comment).toHaveAttribute("aria-invalid", "true");
        await expect(descriptionIds).toContain(error.id);
        await waitFor(async () => {
            await expect(comment).toHaveFocus();
        });
        await expect(dialog).toBeVisible();
        await expect(form).toBeInTheDocument();
        await expect(args.onSubmit).not.toHaveBeenCalled();
        await expect(args.onSaved).not.toHaveBeenCalled();
        await expect(args.onClose).not.toHaveBeenCalled();
    },
};
