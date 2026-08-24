import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { Settings } from "lucide-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { ExpandableCard } from "../ExpandableCard.tsx";
import { Text } from "../Text.tsx";

const meta = {
    args: {
        children: (
            <Text>
                Claims are fenced by the worker lease and remain paused until an operator
                resumes them.
            </Text>
        ),
        description: "Inspect worker claim and concurrency policy.",
        icon: Settings,
        title: "Advanced queue controls",
    },
    component: ExpandableCard,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof ExpandableCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};

export const Expanded: Story = {
    args: {
        defaultOpen: true,
    },
};

export const KeyboardDisclosure: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", {
            name: /Advanced queue controls/u,
        });

        trigger.focus();
        await userEvent.keyboard("{Enter}");
        await waitFor(async () => {
            await expect(trigger).toHaveAttribute("aria-expanded", "true");
            await expect(
                canvas.getByText(/Claims are fenced by the worker lease/u)
            ).toBeVisible();
        });
    },
};
