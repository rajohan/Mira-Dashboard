import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, within } from "storybook/test";

import { LoadingState } from "../LoadingState.tsx";

const meta = {
    args: {
        label: "Loading dashboard data…",
        size: "md",
    },
    component: LoadingState,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof LoadingState>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Section: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const status = canvas.getByRole("status", {
            name: "Loading dashboard data…",
        });
        const visibleLabel = status.querySelector(":scope > span[aria-hidden='true']");
        const dots = status.querySelectorAll(".loading-state-dot");

        await expect(status).toHaveAttribute("aria-busy", "true");
        await expect(status).toHaveAttribute("aria-label", "Loading dashboard data…");
        await expect(visibleLabel).toHaveTextContent("Loading dashboard data...");
        await expect(dots).toHaveLength(3);
        await expect(getComputedStyle(dots[1]!).animationName).toBe(
            "loading-state-second-dot"
        );
        await expect(getComputedStyle(dots[2]!).animationName).toBe(
            "loading-state-third-dot"
        );
    },
};

export const Compact: Story = {
    args: {
        label: "Refreshing…",
        size: "sm",
    },
};

export const Page: Story = {
    args: {
        label: "Loading task board…",
        size: "lg",
    },
};
