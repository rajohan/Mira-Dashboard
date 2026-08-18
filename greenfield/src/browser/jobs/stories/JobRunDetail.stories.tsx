import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";
import * as v from "valibot";

import type { JobRunSummary } from "../../../contracts/jobModel.ts";
import { jobRunDetailSchema } from "../../../contracts/jobs.ts";
import { JobRunDetail } from "../JobRunDetail.tsx";

const timestampMs = 1_800_000_000_000;
const runId = "019fe320-0000-7000-8000-000000000001";

function runningRun(overrides: Partial<JobRunSummary> = {}): JobRunSummary {
    return {
        actionKey: "maintenance.rotate-logs",
        attemptCount: 1,
        attemptLimit: 3,
        availableAtMs: timestampMs,
        cancellationPolicy: "cooperative",
        displayName: "Rotate durable logs",
        eventCount: 3,
        firstStartedAtMs: timestampMs + 1000,
        id: runId,
        lastAttemptStartedAtMs: timestampMs + 1000,
        priority: 10,
        queuedAtMs: timestampMs,
        resourceClass: "host-heavy",
        resourceKeys: ["host.logs"],
        retrySafe: true,
        state: "running",
        stateVersion: 2,
        timeoutMs: 3_600_000,
        triggerType: "system",
        updatedAtMs: timestampMs + 3000,
        ...overrides,
    };
}

const runningDetail = v.parse(jobRunDetailSchema, {
    events: [
        {
            attempt: 1,
            kind: "progress",
            occurredAtMs: timestampMs + 3000,
            progress: { completed: 3, label: "Compressing rotated logs" },
            sequence: 3,
            workerInstanceId: "019fe320-0000-7000-8000-000000000002",
        },
        {
            attempt: 1,
            kind: "stdout",
            message: "rotation started · archive verified",
            occurredAtMs: timestampMs + 2000,
            sequence: 2,
        },
    ],
    nextEventCursor: { sequence: 2 },
    run: runningRun(),
});

const succeededDetail = v.parse(jobRunDetailSchema, {
    events: [
        {
            attempt: 1,
            kind: "succeeded",
            occurredAtMs: timestampMs + 5000,
            sequence: 2,
        },
        {
            attempt: 1,
            kind: "claimed",
            occurredAtMs: timestampMs + 1000,
            sequence: 1,
            workerInstanceId: "019fe320-0000-7000-8000-000000000002",
        },
    ],
    result: {
        archivedFiles: 14,
        destination: "/var/log/archive/dashboard-2027-01-15.tar.zst",
        status: "verified",
    },
    run: runningRun({
        eventCount: 2,
        finishedAtMs: timestampMs + 5000,
        state: "succeeded",
        stateVersion: 3,
        updatedAtMs: timestampMs + 5000,
    }),
});

const meta = {
    args: {
        cancelBusy: false,
        detail: runningDetail,
        onCancel: fn(),
    },
    component: JobRunDetail,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof JobRunDetail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RunningWithEvents: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("heading", { level: 2, name: "Rotate durable logs" })
        ).toBeVisible();
        await expect(
            canvas.getByRole("region", {
                name: "stdout output, event 2, attempt 1",
            })
        ).toHaveAttribute("tabindex", "0");

        const cancellation = canvas.getByRole("button", {
            name: "Request cancellation: Rotate durable logs",
        });
        cancellation.focus();
        await userEvent.keyboard("[Enter]");
        await expect(args.onCancel).toHaveBeenCalledWith(runId);
    },
};

export const CancellationPending: Story = {
    args: {
        cancelBusy: true,
    },
    play: async ({ canvasElement }) => {
        await expect(
            within(canvasElement).getByRole("button", {
                name: "Request cancellation: Rotate durable logs",
            })
        ).toBeDisabled();
    },
};

export const SucceededWithResult: Story = {
    args: {
        detail: succeededDetail,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const result = canvas.getByRole("region", {
            name: `Result for job run ${runId}`,
        });
        result.focus();
        await expect(result).toHaveFocus();
        await expect(canvas.queryByRole("button", { name: /cancell/iu })).toBeNull();
    },
};
