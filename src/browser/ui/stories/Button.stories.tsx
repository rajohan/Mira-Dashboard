import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, waitFor, within } from "storybook/test";

import { Button } from "../Button.tsx";

const meta = {
    args: {
        children: "Save changes",
        onClick: fn(),
    },
    component: Button,
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

async function expectBackgroundColor(button: HTMLElement, color: string): Promise<void> {
    await waitFor(async () => {
        await expect(getComputedStyle(button).backgroundColor).toBe(color);
    });
}

export const Primary: Story = {};

export const Secondary: Story = {
    args: {
        variant: "secondary",
    },
};

export const Danger: Story = {
    args: {
        children: "Delete release",
        variant: "danger",
    },
    play: async ({ canvasElement }) => {
        const button = within(canvasElement).getByRole("button", {
            name: "Delete release",
        });

        await expectBackgroundColor(button, "oklch(0.505 0.213 27.518)");
    },
};

export const DangerHover: Story = {
    args: {
        children: "Delete release",
        variant: "danger",
    },
    render: (properties) => <Button {...properties} data-hover="" />,
    play: async ({ canvasElement }) => {
        const button = within(canvasElement).getByRole("button", {
            name: "Delete release",
        });

        await expect(button).toHaveAttribute("data-hover");
        await expectBackgroundColor(button, "oklch(0.577 0.245 27.325)");
    },
};

export const DangerActive: Story = {
    args: {
        children: "Delete release",
        variant: "danger",
    },
    render: (properties) => <Button {...properties} data-active="" />,
    play: async ({ canvasElement }) => {
        const button = within(canvasElement).getByRole("button", {
            name: "Delete release",
        });

        await expect(button).toHaveAttribute("data-active");
        await expectBackgroundColor(button, "oklch(0.444 0.177 26.899)");
    },
};

export const Busy: Story = {
    args: {
        busy: true,
        busyLabel: "Saving…",
    },
    play: async ({ canvasElement }) => {
        const button = within(canvasElement).getByRole("button", { name: "Saving…" });
        const dots = button.querySelectorAll(".loading-state-dot");

        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute("aria-busy", "true");
        await expect(button).toHaveTextContent("Saving...");
        await expect(dots).toHaveLength(3);
        await expect(getComputedStyle(dots[1]!).animationName).toBe(
            "loading-state-second-dot"
        );
        await expect(getComputedStyle(dots[2]!).animationName).toBe(
            "loading-state-third-dot"
        );
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
};

export const VariantMatrix: Story = {
    render: () => (
        <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="ghost">
                Small ghost
            </Button>
            <Button variant="secondary">Medium secondary</Button>
            <Button size="lg">Large primary</Button>
        </div>
    ),
};
