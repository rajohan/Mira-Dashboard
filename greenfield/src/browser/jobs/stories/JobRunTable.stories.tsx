import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";
import * as v from "valibot";

import type { JobRunSummary } from "../../../contracts/jobModel.ts";
import { jobRunPageSchema } from "../../../contracts/jobs.ts";
import { expectVirtualizedTable } from "../../storySupport/virtualizationAssertions.ts";
import { JobRunTable } from "../JobRunTable.tsx";

const timestampMs = 1_800_000_000_000;

function queuedRun(
    id: string,
    displayName: string,
    overrides: Partial<JobRunSummary> = {}
): JobRunSummary {
    return {
        actionKey: "system.worker-smoke",
        attemptCount: 0,
        attemptLimit: 3,
        availableAtMs: timestampMs,
        cancellationPolicy: "queued-only",
        displayName,
        eventCount: 1,
        id,
        priority: 1,
        queuedAtMs: timestampMs,
        resourceClass: "light",
        resourceKeys: [],
        retrySafe: true,
        state: "queued",
        stateVersion: 1,
        timeoutMs: 60_000,
        triggerType: "system",
        updatedAtMs: timestampMs,
        ...overrides,
    };
}

const runs = Object.freeze(
    v.parse(jobRunPageSchema, [
        queuedRun("019fe300-0000-7000-8000-000000000004", "Refresh host projection"),
        queuedRun("019fe300-0000-7000-8000-000000000003", "Rotate durable logs", {
            attemptCount: 1,
            cancellationPolicy: "cooperative",
            firstStartedAtMs: timestampMs + 1000,
            lastAttemptStartedAtMs: timestampMs + 1000,
            resourceClass: "host-heavy",
            resourceKeys: ["host.logs"],
            state: "running",
            stateVersion: 2,
            updatedAtMs: timestampMs + 10_000,
        }),
        queuedRun("019fe300-0000-7000-8000-000000000002", "Reconcile schedules", {
            attemptCount: 1,
            cancellationPolicy: "never",
            finishedAtMs: timestampMs + 24_000,
            firstStartedAtMs: timestampMs + 1000,
            lastAttemptStartedAtMs: timestampMs + 1000,
            state: "succeeded",
            stateVersion: 3,
            updatedAtMs: timestampMs + 24_000,
        }),
        queuedRun("019fe300-0000-7000-8000-000000000001", "Send daily summary", {
            attemptCount: 2,
            cancellationPolicy: "cooperative",
            finishedAtMs: timestampMs + 55_000,
            firstStartedAtMs: timestampMs + 1000,
            lastAttemptStartedAtMs: timestampMs + 35_000,
            resourceClass: "network",
            state: "failed",
            stateVersion: 5,
            terminalCode: "delivery.unavailable",
            terminalMessage: "The delivery provider did not accept the summary.",
            updatedAtMs: timestampMs + 55_000,
        }),
    ])
);

const virtualizedRuns = Object.freeze(
    v.parse(
        jobRunPageSchema,
        Array.from({ length: 50 }, (_, index) => {
            const queuedAtMs = timestampMs - index * 1000;
            return queuedRun(
                `019fe310-0000-7000-8000-${index.toString().padStart(12, "0")}`,
                `Catalog job ${index.toString().padStart(2, "0")}`,
                {
                    actionKey: `catalog.job-${index.toString().padStart(2, "0")}`,
                    availableAtMs: queuedAtMs,
                    queuedAtMs,
                    updatedAtMs: queuedAtMs,
                }
            );
        })
    )
);

const meta = {
    args: {
        onSelect: fn(),
        runs,
        selectedId: runs[1]?.id,
    },
    component: JobRunTable,
    parameters: {
        layout: "padded",
    },
    title: "Jobs/JobRunTable",
} satisfies Meta<typeof JobRunTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LifecycleStates: Story = {
    play: async ({ args, canvasElement }) => {
        const run = runs[0];
        if (run === undefined) throw new Error("The run fixture is missing.");

        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: `Open run ${run.displayName}; action ${run.actionKey}; id ${run.id}`,
            })
        );
        await expect(args.onSelect).toHaveBeenCalledWith(run.id);
    },
};

export const VirtualizedInventory: Story = {
    args: {
        runs: virtualizedRuns,
        selectedId: virtualizedRuns[0]?.id,
    },
    play: async ({ canvasElement }) => {
        await expectVirtualizedTable({
            canvasElement,
            label: "Durable job runs",
            rowCount: virtualizedRuns.length,
        });
    },
};

export const Empty: Story = {
    args: {
        runs: [],
        selectedId: undefined,
    },
};
