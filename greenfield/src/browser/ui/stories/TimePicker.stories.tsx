import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, within } from "storybook/test";

import { TimePicker } from "../TimePicker.tsx";

type TimePickerProperties = ComponentProps<typeof TimePicker>;

interface ControlledTimePickerProperties {
    readonly properties: TimePickerProperties;
    readonly updateProperties: (properties: Partial<TimePickerProperties>) => void;
}

function ControlledTimePicker({
    properties,
    updateProperties,
}: ControlledTimePickerProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <TimePicker
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

function RenderControlledTimePicker(properties: TimePickerProperties) {
    const [, updateProperties] = useArgs<TimePickerProperties>();

    return (
        <div className="w-full max-w-sm">
            <ControlledTimePicker
                key={properties.value}
                properties={properties}
                updateProperties={updateProperties}
            />
        </div>
    );
}

const meta = {
    args: {
        label: "Start time (24-hour)",
        onChange: fn(),
        value: "05:30",
    },
    component: TimePicker,
    parameters: { layout: "padded" },
    render: RenderControlledTimePicker,
    title: "UI/TimePicker",
} satisfies Meta<typeof TimePicker>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const hour = canvas.getByRole("button", {
            name: "Start time (24-hour), hour",
        });
        const minute = canvas.getByRole("button", {
            name: "Start time (24-hour), minute",
        });

        await userEvent.click(hour);
        await userEvent.click(
            within(canvasElement.ownerDocument.body).getByRole("option", {
                name: "21",
            })
        );
        await userEvent.click(minute);
        await userEvent.click(
            within(canvasElement.ownerDocument.body).getByRole("option", {
                name: "32",
            })
        );

        await expect(hour).toHaveTextContent("21");
        await expect(minute).toHaveTextContent("32");
        await expect(args.onChange).toHaveBeenLastCalledWith("21:32");
    },
};

export const Invalid: Story = {
    args: { error: "Choose a valid time." },
};

export const Disabled: Story = {
    args: { disabled: true },
};
