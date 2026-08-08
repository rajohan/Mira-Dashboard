import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { Plus } from "lucide-react";
import { fn } from "storybook/test";

import { Button } from "../Button.tsx";
import { Icon } from "../Icon.tsx";
import { PageHeader } from "../PageHeader.tsx";

const meta = {
    args: {
        description:
            "Inspect current work, recent activity, and the reviewed agent directory.",
        eyebrow: "Operations",
        title: "Agents",
    },
    component: PageHeader,
    parameters: {
        layout: "padded",
    },
    title: "UI/PageHeader",
} satisfies Meta<typeof PageHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
    args: {
        actions: (
            <Button onClick={fn()}>
                <Icon icon={Plus} size="sm" tone="inherit" />
                New task
            </Button>
        ),
        description:
            "Prioritize, assign, and track Dashboard work across each delivery state.",
        eyebrow: "Planning",
        title: "Tasks",
    },
};

export const WithoutEyebrow: Story = {
    args: {
        eyebrow: undefined,
        title: "Reports",
    },
};
