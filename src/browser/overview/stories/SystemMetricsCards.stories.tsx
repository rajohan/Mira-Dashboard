import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, within } from "storybook/test";

import type { SystemMetrics } from "../../../contracts/system.ts";
import {
    observedStorySystemApplicationMetrics,
    unavailableStorySystemApplicationMetrics,
} from "../../storySupport/systemMetricsStoryFixture.ts";
import { SystemMetricsCards } from "../SystemMetricsCards.tsx";

const freshMetrics = Object.freeze({
    application: observedStorySystemApplicationMetrics(1_800_000_000_000),
    cpu: {
        loadAverage: [9.92, 4.2, 2.1],
        loadPercent: 248,
        logicalCoreCount: 4,
    },
    disk: {
        freeBytes: 40 * 1024 ** 3,
        totalBytes: 100 * 1024 ** 3,
        usedBytes: 60 * 1024 ** 3,
        usedPercent: 60,
    },
    freshness: "fresh",
    memory: {
        freeBytes: 2 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
        usedBytes: 6 * 1024 ** 3,
        usedPercent: 75,
    },
    network: {
        downloadBitsPerSecond: 12_300_000,
        state: "ready",
        uploadBitsPerSecond: 1_250_000,
    },
    sampledAtMs: 1_800_000_000_000,
    uptimeSeconds: 183_600,
} as const satisfies SystemMetrics);

const meta = {
    args: { metrics: freshMetrics },
    component: SystemMetricsCards,
    parameters: { layout: "padded" },
} satisfies Meta<typeof SystemMetricsCards>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Fresh: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("heading", { name: "CPU" })).toBeVisible();
        await expect(canvas.getByText("12.3 Mbit/s")).toBeVisible();
        await expect(canvas.getByText("3 subscribers")).toBeVisible();
        await expect(
            canvas.getByRole("heading", { name: "Durable operations" })
        ).toBeVisible();
        await expect(canvas.getByRole("heading", { name: "Chat runtime" })).toBeVisible();
        await expect(
            canvas.getByRole("heading", { name: "Cache snapshots" })
        ).toBeVisible();
        await expect(
            canvas.getByRole("heading", { name: "HTTP procedures" })
        ).toBeVisible();
    },
};

export const PartialApplicationObservation: Story = {
    args: {
        metrics: {
            ...freshMetrics,
            application: {
                ...freshMetrics.application,
                cache: { state: "unavailable" },
                realtime: { state: "unavailable" },
            },
        },
    },
};

export const ApplicationUnavailable: Story = {
    args: {
        metrics: {
            ...freshMetrics,
            application: unavailableStorySystemApplicationMetrics,
        },
    },
};

export const WarmingNetwork: Story = {
    args: {
        metrics: {
            ...freshMetrics,
            network: {
                downloadBitsPerSecond: 0,
                state: "warming",
                uploadBitsPerSecond: 0,
            },
        },
    },
};
