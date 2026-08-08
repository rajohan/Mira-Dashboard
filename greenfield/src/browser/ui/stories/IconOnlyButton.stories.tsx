import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { RefreshCw, Trash2, X } from "lucide-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { IconOnlyButton } from "../IconOnlyButton.tsx";

const meta = {
    args: {
        icon: RefreshCw,
        label: "Refresh cache entry",
        onClick: fn(),
        variant: "secondary",
    },
    component: IconOnlyButton,
    title: "UI/IconOnlyButton",
} satisfies Meta<typeof IconOnlyButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvasElement }) => {
        const button = within(canvasElement).getByRole("button", {
            name: "Refresh cache entry",
        });

        await userEvent.click(button);
        await expect(args.onClick).toHaveBeenCalledOnce();
    },
};

export const Danger: Story = {
    args: {
        icon: Trash2,
        label: "Delete notification",
        variant: "danger",
    },
};

export const GhostClose: Story = {
    args: {
        icon: X,
        label: "Close dialog",
        variant: "ghost",
    },
    render: (properties) => <IconOnlyButton {...properties} data-hover="" />,
    play: async ({ canvasElement }) => {
        const button = within(canvasElement).getByRole("button", {
            name: "Close dialog",
        });

        await expect(button).toHaveAttribute("data-hover");
        await waitFor(async () => {
            await expect(getComputedStyle(button).backgroundColor).toBe(
                "rgb(42, 45, 51)"
            );
        });
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
};
