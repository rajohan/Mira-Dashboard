import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { Cpu } from "lucide-react";
import { expect, within } from "storybook/test";

import { MetricCard } from "../MetricCard.tsx";

const meta = {
    args: {
        description: "1 minute load 9.92 · 4 logical cores",
        icon: Cpu,
        meter: { label: "CPU normalized load", maximum: 100, value: 248.1 },
        title: "CPU",
        value: "248.1%",
    },
    component: MetricCard,
    parameters: { layout: "padded" },
    title: "UI/MetricCard",
} satisfies Meta<typeof MetricCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("heading", { name: "CPU" })).toBeVisible();
        await expect(
            canvas.getByRole("progressbar", { name: "CPU normalized load" })
        ).toHaveValue(100);
    },
};

export const WithoutMeter: Story = {
    args: {
        description: "Current receive throughput",
        meter: undefined,
        title: "Download",
        value: "12.3 Mbit/s",
    },
};
