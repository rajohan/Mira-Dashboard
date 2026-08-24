import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import type {
    ListOpenClawCronResult,
    ListOpenClawCronRunsResult,
    OpenClawCronJob,
} from "../../../contracts/openClawCron.ts";
import { OpenClawCronSectionView } from "../OpenClawCronSection.tsx";

const observedAtMs = 1_800_001_000_000;
const activeJob = {
    agentId: "main",
    agentIdTruncated: false,
    configRevision: "revision-1",
    createdAtMs: 1_800_000_000_000,
    delivery: {
        completionDestinationConfigured: false,
        metadataTruncated: false,
        mode: "announce",
        targetConfigured: false,
    },
    deliveryMode: "announce",
    description: "Produces the nightly operations report.",
    descriptionTruncated: false,
    enabled: true,
    id: "nightly-report",
    name: "Nightly report",
    nameTruncated: false,
    payload: {
        kind: "agent-turn",
        message: "Produce the nightly operations report.",
        model: "openai/gpt-5.6-sol",
        truncated: false,
    },
    schedule: {
        expr: "0 7 * * *",
        kind: "cron",
        truncated: false,
        tz: "Europe/Oslo",
    },
    sessionTarget: "isolated",
    source: "openclaw",
    state: {
        lastRunAtMs: observedAtMs - 3_600_000,
        lastRunStatus: "ok",
        nextRunAtMs: observedAtMs + 82_800_000,
    },
    synchronization: { state: "confirmed" },
    updatedAtMs: observedAtMs - 60_000,
    wakeMode: "now",
} as const satisfies OpenClawCronJob;

const conflictedJob = {
    ...activeJob,
    enabled: true,
    id: "weekly-maintenance",
    name: "Weekly maintenance",
    schedule: { everyMs: 604_800_000, kind: "every", truncated: false },
    synchronization: {
        desiredEnabled: false,
        disableIntent: {
            reason: "Maintenance freeze",
            recordedAtMs: observedAtMs - 120_000,
            revision: "intent-7",
        },
        state: "conflict",
    },
} as const satisfies OpenClawCronJob;

const freshInventorySource = {
    kind: "fresh",
    observedAtMs,
} as const satisfies ListOpenClawCronResult["freshness"];

function inventory(
    jobs: readonly OpenClawCronJob[],
    freshness?: ListOpenClawCronResult["freshness"]
): ListOpenClawCronResult {
    return {
        freshness: freshness ?? freshInventorySource,
        hasMore: false,
        jobs: [...jobs],
        limit: 50,
        offset: 0,
        snapshotRevision: `sha256:${"A".repeat(43)}`,
        total: jobs.length,
    };
}

const runs = {
    freshness: { kind: "fresh", observedAtMs },
    hasMore: false,
    limit: 50,
    offset: 0,
    runs: [
        {
            completedAtMs: observedAtMs - 3_600_000,
            deliveryStatus: "delivered",
            durationMs: 32_000,
            jobId: activeJob.id,
            modelTruncated: false,
            providerTruncated: false,
            runAtMs: observedAtMs - 3_632_000,
            runId: "run-1",
            status: "ok",
            summary: "Report delivered.",
            summaryTruncated: false,
        },
    ],
    total: 1,
} as const satisfies ListOpenClawCronRunsResult;

const meta = {
    args: {
        onDelete: fn(async () => {}),
        onRetry: fn(),
        onRun: fn(async () => {}),
        onSetEnabled: fn(async () => {}),
        onUpdate: fn(async () => {}),
        runs,
        state: { result: inventory([activeJob, conflictedJob]), status: "ready" },
    },
    component: OpenClawCronSectionView,
    parameters: { layout: "padded" },
    title: "Jobs/OpenClawCronSection",
} satisfies Meta<typeof OpenClawCronSectionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveInventory: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: "Run now" }));
        const dialog = within(document.body).getByRole("dialog", {
            name: "Run OpenClaw cron job",
        });
        await userEvent.click(within(dialog).getByRole("button", { name: "Run now" }));
        await expect(args.onRun).toHaveBeenCalledWith(activeJob);
    },
};

export const LastKnownGoodConflict: Story = {
    args: {
        backgroundError: "OpenClaw refresh failed.",
        runs: undefined,
        state: {
            result: inventory([conflictedJob], {
                kind: "last-known-good",
                observedAtMs,
                staleSinceMs: observedAtMs + 30_000,
            }),
            status: "ready",
        },
    },
};

export const EmptyInventory: Story = {
    args: {
        runs: undefined,
        state: { result: inventory([]), status: "ready" },
    },
};

export const Loading: Story = {
    args: { runs: undefined, state: { status: "loading" } },
};

export const InitialFailure: Story = {
    args: {
        runs: undefined,
        state: {
            message: "OpenClaw Gateway is unavailable.",
            status: "error",
        },
    },
};
