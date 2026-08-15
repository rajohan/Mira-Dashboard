import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState, type ComponentProps } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, within } from "storybook/test";

import { FormField } from "../FormField.tsx";
import { TagInput } from "../TagInput.tsx";

type TagInputProperties = ComponentProps<typeof TagInput>;

interface ControlledTagInputProperties {
    readonly properties: TagInputProperties;
    readonly updateProperties: (properties: Partial<TagInputProperties>) => void;
}

function ControlledTagInput({
    properties,
    updateProperties,
}: ControlledTagInputProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <div className="w-full max-w-md">
            <FormField
                description="Press Space or Enter after each label."
                disabled={properties.disabled}
                error={properties.invalid ? "Review the task labels." : undefined}
                label="Labels"
            >
                <TagInput
                    {...properties}
                    className="mt-2"
                    onChange={(nextValue) => {
                        setValue(nextValue);
                        updateProperties({ value: nextValue });
                        properties.onChange(nextValue);
                    }}
                    value={value}
                />
            </FormField>
        </div>
    );
}

function RenderControlledTagInput(properties: TagInputProperties) {
    const [, updateProperties] = useArgs<TagInputProperties>();

    return (
        <ControlledTagInput
            key={properties.value.join("\u0000")}
            properties={properties}
            updateProperties={updateProperties}
        />
    );
}

const meta = {
    args: {
        ariaLabel: "Labels",
        onChange: fn(),
        placeholder: "Add a label…",
        suggestions: ["backend", "design-system", "frontend", "needs review"],
        value: ["frontend", "needs review"],
    },
    component: TagInput,
    parameters: { layout: "padded" },
    render: RenderControlledTagInput,
    title: "UI/TagInput",
} satisfies Meta<typeof TagInput>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const input = canvas.getByRole("combobox", { name: "Labels" });

        await userEvent.type(input, "urgent ");
        await expect(canvas.getByRole("button", { name: "Remove urgent" })).toBeVisible();
        await expect(args.onChange).toHaveBeenLastCalledWith([
            "frontend",
            "needs review",
            "urgent",
        ]);

        await userEvent.click(
            canvas.getByRole("button", { name: "Remove needs review" })
        );
        await expect(
            canvas.queryByRole("button", { name: "Remove needs review" })
        ).not.toBeInTheDocument();
    },
};

export const CommitOnBlur: Story = {
    args: { value: [] },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const input = canvas.getByRole("combobox", { name: "Labels" });

        await userEvent.type(input, "backend,api");
        await userEvent.tab();

        await expect(args.onChange).toHaveBeenLastCalledWith(["backend,api"]);
        await expect(
            canvas.getByRole("button", { name: "Remove backend,api" })
        ).toBeVisible();
    },
};

export const Disabled: Story = {
    args: { disabled: true },
};

export const Invalid: Story = {
    args: { invalid: true },
};

export const MaximumReached: Story = {
    args: { maxTags: 2 },
};
