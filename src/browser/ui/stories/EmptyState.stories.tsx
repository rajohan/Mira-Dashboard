import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { SearchX } from "lucide-react";
import { fn } from "storybook/test";

import { Button } from "../Button.tsx";
import { EmptyState } from "../EmptyState.tsx";

const meta = {
    args: {
        description: "Completed and active task intervals will appear here.",
        title: "No agent task history",
    },
    component: EmptyState,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof EmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoSearchResults: Story = {
    args: {
        action: (
            <Button onClick={fn()} variant="secondary">
                Clear filters
            </Button>
        ),
        description: "Try another query or remove the active filters.",
        icon: SearchX,
        title: "No matching tasks",
    },
};
