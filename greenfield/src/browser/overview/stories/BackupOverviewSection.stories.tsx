import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, within } from "storybook/test";

import type { KopiaBackupStatus, WalgBackupStatus } from "../../../contracts/backups.ts";
import { BackupOverviewSectionView } from "../BackupOverviewSection.tsx";

const nowMs = 1_800_000_000_000;
const sourceRevision = "a".repeat(64);
const runId = "019fe200-0000-7000-8000-000000000002";

const kopiaFresh = {
    activity: { state: "idle" },
    checkedAtMs: nowMs,
    payload: {
        backupCount: 8,
        healthy: true,
        observedAtMs: nowMs - 1000,
        providerIdle: true,
        sourceRevision,
        sources: [
            {
                health: "current",
                id: "primary",
                latestCompletedAtMs: nowMs - 60_000,
                snapshotCount: 8,
            },
        ],
        type: "kopia",
    },
    state: "fresh",
} as const satisfies KopiaBackupStatus;

const walgFresh = {
    activity: { state: "idle" },
    checkedAtMs: nowMs,
    payload: {
        backupCount: 12,
        healthy: true,
        latestCompletedAtMs: nowMs - 60_000,
        observedAtMs: nowMs - 1000,
        providerIdle: true,
        sourceRevision,
        type: "walg",
    },
    state: "fresh",
} as const satisfies WalgBackupStatus;

const meta = {
    args: { kopia: kopiaFresh, walg: walgFresh },
    component: BackupOverviewSectionView,
    parameters: { layout: "padded" },
    title: "Overview/BackupOverviewSection",
} satisfies Meta<typeof BackupOverviewSectionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { kopia: undefined, loading: true, walg: undefined },
};

export const Fresh: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("heading", { name: "Backups" })).toBeVisible();
        await expect(canvas.getAllByText("Fresh")).toHaveLength(2);
    },
};

export const LastKnownGood: Story = {
    args: {
        kopia: {
            ...kopiaFresh,
            staleSinceMs: nowMs - 500,
            state: "last-known-good",
        },
        walg: {
            ...walgFresh,
            staleSinceMs: nowMs - 500,
            state: "last-known-good",
        },
    },
};

export const Unavailable: Story = {
    args: {
        kopia: {
            activity: { state: "idle" },
            checkedAtMs: nowMs,
            state: "unavailable",
            type: "kopia",
        },
        walg: {
            activity: { state: "idle" },
            checkedAtMs: nowMs,
            state: "unavailable",
            type: "walg",
        },
    },
};

export const Attention: Story = {
    args: {
        kopia: {
            ...kopiaFresh,
            activity: {
                finishedAtMs: nowMs - 2000,
                jobRunId: runId,
                jobsUrl: `/jobs?runId=${runId}`,
                queuedAtMs: nowMs - 10_000,
                startedAtMs: nowMs - 9000,
                state: "needs-attention",
            },
        },
    },
};

export const Busy: Story = {
    args: {
        walg: {
            ...walgFresh,
            payload: { ...walgFresh.payload, providerIdle: false },
        },
    },
};

export const Disabled: Story = {
    args: { controlsDisabled: true },
};

export const Queued: Story = {
    args: {
        queued: {
            jobRunId: runId,
            operation: "run",
            queued: true,
            type: "kopia",
        },
        kopia: {
            ...kopiaFresh,
            activity: {
                jobRunId: runId,
                jobsUrl: `/jobs?runId=${runId}`,
                queuedAtMs: nowMs,
                state: "queued",
            },
        },
    },
};

export const Error: Story = {
    args: {
        error: "Backup status could not be loaded.",
        kopia: undefined,
        walg: walgFresh,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByText("Backup status could not be loaded.")
        ).toBeVisible();
        await expect(canvas.getByRole("heading", { name: "WAL-G" })).toBeVisible();
    },
};
