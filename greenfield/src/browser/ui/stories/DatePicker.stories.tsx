import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { DatePicker } from "../DatePicker.tsx";

type DatePickerProperties = ComponentProps<typeof DatePicker>;

interface ControlledDatePickerProperties {
    readonly properties: DatePickerProperties;
    readonly updateProperties: (properties: Partial<DatePickerProperties>) => void;
}

function ControlledDatePicker({
    properties,
    updateProperties,
}: ControlledDatePickerProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <DatePicker
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

function RenderControlledDatePicker(properties: DatePickerProperties) {
    const [, updateProperties] = useArgs<DatePickerProperties>();

    return (
        <div className="w-full max-w-sm">
            <ControlledDatePicker
                key={properties.value.toISOString()}
                properties={properties}
                updateProperties={updateProperties}
            />
        </div>
    );
}

const meta = {
    args: {
        label: "Maintenance date",
        onChange: fn(),
        value: new Date(2026, 7, 8, 12),
    },
    component: DatePicker,
    parameters: { layout: "padded" },
    render: RenderControlledDatePicker,
    title: "UI/DatePicker",
} satisfies Meta<typeof DatePicker>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", {
            name: "Choose Maintenance date, selected 08.08.2026",
        });
        await userEvent.click(trigger);
        const panelId = await waitFor(() => {
            const id = trigger.getAttribute("aria-controls");
            if (id === null) throw new Error("The calendar panel did not open.");
            return id;
        });
        const panel = canvasElement.ownerDocument.getElementById(panelId);
        if (!(panel instanceof HTMLElement)) {
            throw new Error("The calendar panel was not mounted.");
        }
        const day = within(panel)
            .getAllByRole("button")
            .find((button) => button.textContent?.trim() === "10");
        if (day === undefined) throw new Error("The August 10 calendar day is missing.");
        await userEvent.click(day);

        await expect(
            canvas.getByRole("button", {
                name: "Choose Maintenance date, selected 10.08.2026",
            })
        ).toBeVisible();
        await expect(args.onChange).toHaveBeenCalled();
    },
};

export const MinimumDate: Story = {
    args: {
        minimumDate: new Date(2026, 7, 8, 12),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", {
            name: "Choose Maintenance date, selected 08.08.2026",
        });

        await userEvent.click(trigger);
        const panelId = await waitFor(() => {
            const id = trigger.getAttribute("aria-controls");
            if (id === null) throw new Error("The calendar panel did not open.");
            return id;
        });
        const panel = canvasElement.ownerDocument.getElementById(panelId);
        if (!(panel instanceof HTMLElement)) {
            throw new Error("The calendar panel was not mounted.");
        }
        const dayButtons = within(panel).getAllByRole("button");
        const earlierDay = dayButtons.find(
            (button) => button.textContent?.trim() === "7"
        );
        const minimumDay = dayButtons.find(
            (button) => button.textContent?.trim() === "8"
        );
        if (earlierDay === undefined || minimumDay === undefined) {
            throw new Error("The minimum-date boundary days are missing.");
        }

        await expect(panel).toBeVisible();
        await expect(earlierDay).toBeDisabled();
        await expect(minimumDay).not.toBeDisabled();
    },
};

export const Invalid: Story = {
    args: { error: "Choose a future date." },
};

export const Disabled: Story = {
    args: { disabled: true },
};
