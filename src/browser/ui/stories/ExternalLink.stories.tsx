import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, within } from "storybook/test";

import { ExternalLink } from "../ExternalLink.tsx";

const meta = {
    args: {
        children: "View Storybook documentation",
        href: "https://storybook.js.org/docs",
    },
    component: ExternalLink,
} satisfies Meta<typeof ExternalLink>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const link = within(canvasElement).getByRole("link", {
            name: /View Storybook documentation/u,
        });

        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    },
};

export const WithoutIcon: Story = {
    args: {
        showIcon: false,
    },
};
