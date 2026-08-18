import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import type { JobQueueSummary } from "../../../contracts/jobs.ts";
import { JobQueuePanel } from "../JobQueuePanel.tsx";

const timestampMs = 1_800_000_000_000;

const queueSummary = Object.freeze({
    activeResourceClasses: ["host-heavy", "light"],
    control: {
        claimingPaused: false,
        updatedAtMs: timestampMs,
        version: 4,
    },
    oldestQueuedAtMs: timestampMs - 60_000,
    stateCounts: {
        cancelled: 2,
        failed: 3,
        queued: 1,
        running: 2,
        succeeded: 18,
        "timed-out": 1,
    },
    workers: [
        {
            activeRunCount: 1,
            capacity: 2,
            heartbeatAtMs: timestampMs,
            id: "019fe300-0000-7000-8000-000000000021",
            releaseId: "a".repeat(40),
            startedAtMs: timestampMs - 3_600_000,
            state: "online",
        },
        {
            activeRunCount: 1,
            capacity: 4,
            drainingAtMs: timestampMs - 120_000,
            heartbeatAtMs: timestampMs - 10_000,
            id: "019fe300-0000-7000-8000-000000000022",
            releaseId: "b".repeat(40),
            startedAtMs: timestampMs - 7_200_000,
            state: "draining",
        },
    ],
} satisfies JobQueueSummary);

const meta = {
    args: {
        controlBusy: false,
        onSetClaimingPaused: fn(),
        summary: queueSummary,
    },
    component: JobQueuePanel,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof JobQueuePanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActiveFleet: Story = {
    play: async ({ args, canvasElement }) => {
        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: "Pause new jobs",
            })
        );
        await expect(args.onSetClaimingPaused).toHaveBeenCalledWith(true);
    },
};

export const ClaimingPaused: Story = {
    args: {
        summary: {
            ...queueSummary,
            control: {
                ...queueSummary.control,
                claimingPaused: true,
            },
        },
    },
};

export const ControlBusy: Story = {
    args: {
        controlBusy: true,
    },
};

export const NoWorkers: Story = {
    args: {
        summary: {
            ...queueSummary,
            activeResourceClasses: [],
            oldestQueuedAtMs: undefined,
            stateCounts: {
                ...queueSummary.stateCounts,
                queued: 0,
                running: 0,
            },
            workers: [],
        },
    },
};
