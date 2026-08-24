import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { CircleCheck } from "lucide-react";

import { Badge } from "../Badge.tsx";
import { Icon } from "../Icon.tsx";

const meta = {
    args: {
        children: "queued",
    },
    component: Badge,
    title: "UI/Badge",
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const StatusVariants: Story = {
    render: () => (
        <div className="flex flex-wrap items-center gap-2">
            <Badge>queued</Badge>
            <Badge variant="info">running</Badge>
            <Badge variant="success">
                <Icon icon={CircleCheck} size="sm" tone="inherit" />
                succeeded
            </Badge>
            <Badge variant="warning">stale</Badge>
            <Badge variant="danger">failed</Badge>
        </div>
    ),
};
