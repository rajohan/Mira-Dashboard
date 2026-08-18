import type { Meta, StoryObj } from "@storybook/tanstack-react";

import { ProgressBar } from "../ProgressBar.tsx";

const meta = {
    args: {
        className: "w-64 max-w-full",
        label: "Token context used",
        maximum: 272_000,
        value: 40_000,
    },
    component: ProgressBar,
} satisfies Meta<typeof ProgressBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const UsageThresholds: Story = {
    render: () => (
        <div className="w-64 max-w-full space-y-5">
            {[35, 60, 82, 95].map((value) => (
                <div className="space-y-2" key={value}>
                    <span className="text-primary-300 text-sm">{value}% used</span>
                    <ProgressBar label={`${value}% context used`} value={value} />
                </div>
            ))}
        </div>
    ),
};
