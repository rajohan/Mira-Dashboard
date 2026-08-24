import type { Meta, StoryObj } from "@storybook/tanstack-react";

import { FormField } from "../FormField.tsx";
import { Input } from "../Input.tsx";
import { Textarea } from "../Textarea.tsx";

const meta = {
    args: {
        children: <Input className="mt-2" placeholder="Daily cache refresh" />,
        description: "A clear operator-facing name for the schedule.",
        label: "Schedule name",
    },
    component: FormField,
    title: "UI/FormField",
} satisfies Meta<typeof FormField>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TextInput: Story = {};

export const Invalid: Story = {
    args: {
        children: (
            <Input className="mt-2" defaultValue=" " placeholder="Daily cache refresh" />
        ),
        error: "Schedule name is required.",
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
};

export const Multiline: Story = {
    args: {
        children: (
            <Textarea
                className="mt-2"
                defaultValue="Refresh reviewed host capacity before the morning brief."
            />
        ),
        description: "Markdown is supported in longer operator notes.",
        label: "Description",
    },
};
