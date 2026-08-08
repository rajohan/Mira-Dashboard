import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, within } from "storybook/test";

import type { CacheEntry } from "../../../contracts/cache.ts";
import { SystemHostCard } from "../SystemHostCard.tsx";

const timestampMs = 1_800_000_000_000;

function systemHostEntry(payload: CacheEntry["payload"]): CacheEntry {
    return {
        consecutiveFailures: 1,
        expiresAtMs: timestampMs + 60_000,
        failureCode: "provider.failed",
        failureMessage: "The latest refresh failed.",
        freshness: "fresh",
        key: "system.host",
        lastAttemptAtMs: timestampMs,
        lastAttemptDurationMs: 200,
        lastAttemptNumber: 2,
        lastAttemptRunId: "019fe200-0000-7000-8000-000000000002",
        lastAttemptStatus: "failed",
        lastSuccessAtMs: timestampMs - 1000,
        manualRunAvailable: true,
        metadata: {},
        payload,
        schemaId: "system.host.v1",
        source: "system.host",
        updatedAtMs: timestampMs,
    };
}

const validEntry = systemHostEntry({
    architecture: "x64",
    disk: {
        freeBytes: 40 * 1024 ** 3,
        path: "/",
        totalBytes: 100 * 1024 ** 3,
    },
    hostname: "mira-vps",
    memory: {
        freeBytes: 2 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
    },
    platform: "linux",
    release: "6.8.0",
    uptimeSeconds: 183_600,
});

const meta = {
    args: {
        entry: validEntry,
    },
    component: SystemHostCard,
    parameters: {
        layout: "padded",
    },
    title: "Cache/SystemHostCard",
} satisfies Meta<typeof SystemHostCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LastKnownGoodAfterFailure: Story = {};

export const InvalidPayloadFailsClosed: Story = {
    args: {
        entry: systemHostEntry({ privateHostDetail: "must-not-render" }),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(
            canvas.getByRole("heading", { name: "Host projection unavailable" })
        ).toBeVisible();
        await expect(canvas.queryByText("must-not-render")).not.toBeInTheDocument();
    },
};
