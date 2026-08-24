import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { SearchInput } from "../SearchInput.tsx";

type SearchInputProperties = ComponentProps<typeof SearchInput>;

interface ControlledSearchInputProperties {
    readonly properties: SearchInputProperties;
    readonly updateProperties: (properties: Partial<SearchInputProperties>) => void;
}

function ControlledSearchInput({
    properties,
    updateProperties,
}: ControlledSearchInputProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <SearchInput
            {...properties}
            onChange={(nextValue) => {
                setValue(nextValue);
                updateProperties({ value: nextValue });
                properties.onChange(nextValue);
            }}
            value={value}
        />
    );
}

function RenderControlledSearchInput(properties: SearchInputProperties) {
    const [, updateProperties] = useArgs<SearchInputProperties>();

    return (
        <div className="w-full max-w-80">
            <ControlledSearchInput
                key={properties.value}
                properties={properties}
                updateProperties={updateProperties}
            />
        </div>
    );
}

const meta = {
    args: {
        label: "Search tasks",
        onChange: fn(),
        placeholder: "Search tasks…",
        value: "",
    },
    component: SearchInput,
    parameters: {
        layout: "padded",
    },
    render: RenderControlledSearchInput,
    title: "UI/SearchInput",
} satisfies Meta<typeof SearchInput>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithQuery: Story = {
    args: {
        value: "storybook",
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
        value: "cache",
    },
};

export const ClearAction: Story = {
    args: {
        value: "worker",
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Clear search" }));
        await waitFor(async () => {
            await expect(
                canvas.getByRole("searchbox", { name: "Search tasks" })
            ).toHaveValue("");
        });
        await expect(args.onChange).toHaveBeenLastCalledWith("");
    },
};
