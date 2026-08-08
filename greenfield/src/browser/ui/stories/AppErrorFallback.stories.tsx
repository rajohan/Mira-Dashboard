import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, within } from "storybook/test";

import { AppErrorFallback } from "../AppErrorFallback.tsx";

const privateErrorDetail = "database-password-must-not-render";

const meta = {
    args: {
        error: new Error(privateErrorDetail),
        resetErrorBoundary: fn(),
    },
    component: AppErrorFallback,
    parameters: {
        layout: "fullscreen",
    },
    title: "UI/AppErrorFallback",
} satisfies Meta<typeof AppErrorFallback>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RedactedAndRecoverable: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(
            canvas.getByRole("heading", { name: "Dashboard unavailable" })
        ).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
        await expect(canvas.queryByText(privateErrorDetail)).not.toBeInTheDocument();
    },
};
