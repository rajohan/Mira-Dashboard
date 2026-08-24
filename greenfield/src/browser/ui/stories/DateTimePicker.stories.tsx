import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { DateTimePicker, type DateTimePickerValue } from "../DateTimePicker.tsx";

type DateTimePickerProperties = ComponentProps<typeof DateTimePicker>;

interface ControlledDateTimePickerProperties {
    readonly properties: DateTimePickerProperties;
    readonly updateProperties: (properties: Partial<DateTimePickerProperties>) => void;
}

function ControlledDateTimePicker({
    properties,
    updateProperties,
}: ControlledDateTimePickerProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <DateTimePicker
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

function RenderControlledDateTimePicker(properties: DateTimePickerProperties) {
    const [, updateProperties] = useArgs<DateTimePickerProperties>();

    return (
        <div className="w-full max-w-xl">
            <ControlledDateTimePicker
                key={`${properties.value.date.toISOString()}:${properties.value.time}`}
                properties={properties}
                updateProperties={updateProperties}
            />
        </div>
    );
}

const initialValue: DateTimePickerValue = {
    date: new Date(2026, 7, 8, 12),
    time: "05:30",
};

const meta = {
    args: {
        label: "Disabled until",
        onChange: fn(),
        value: initialValue,
    },
    component: DateTimePicker,
    parameters: { layout: "padded" },
    render: RenderControlledDateTimePicker,
    title: "UI/DateTimePicker",
} satisfies Meta<typeof DateTimePicker>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const dateTrigger = canvas.getByRole("button", {
            name: "Choose Disabled until date, selected 08.08.2026",
        });

        await userEvent.click(dateTrigger);
        const panelId = await waitFor(() => {
            const id = dateTrigger.getAttribute("aria-controls");
            if (id === null) throw new Error("The calendar panel did not open.");
            return id;
        });
        const panel = canvasElement.ownerDocument.querySelector(
            `#${globalThis.CSS.escape(panelId)}`
        );
        if (!(panel instanceof HTMLElement)) {
            throw new Error("The calendar panel was not mounted.");
        }
        const day = within(panel)
            .getAllByRole("button")
            .find((button) => button.textContent?.trim() === "10");
        if (day === undefined) throw new Error("The August 10 calendar day is missing.");
        await userEvent.click(day);

        const selectedDate = new Date(2026, 7, 10, 12);
        const hour = canvas.getByRole("button", {
            name: "Time (24-hour), hour",
        });
        const minute = canvas.getByRole("button", {
            name: "Time (24-hour), minute",
        });
        await expect(
            canvas.getByRole("button", {
                name: "Choose Disabled until date, selected 10.08.2026",
            })
        ).toBeVisible();
        await expect(hour).toHaveTextContent("05");
        await expect(minute).toHaveTextContent("30");
        await expect(args.onChange).toHaveBeenLastCalledWith({
            date: selectedDate,
            time: "05:30",
        });

        await userEvent.click(hour);
        await userEvent.click(
            within(canvasElement.ownerDocument.body).getByRole("option", {
                name: "21",
            })
        );
        await expect(args.onChange).toHaveBeenLastCalledWith({
            date: selectedDate,
            time: "21:30",
        });

        await userEvent.click(minute);
        await userEvent.click(
            within(canvasElement.ownerDocument.body).getByRole("option", {
                name: "32",
            })
        );
        await waitFor(async () => {
            await expect(
                within(canvasElement.ownerDocument.body).queryByRole("listbox")
            ).not.toBeInTheDocument();
        });

        await expect(
            canvas.getByRole("button", {
                name: "Choose Disabled until date, selected 10.08.2026",
            })
        ).toBeVisible();
        await expect(hour).toHaveTextContent("21");
        await expect(minute).toHaveTextContent("32");
        await expect(args.onChange).toHaveBeenLastCalledWith({
            date: selectedDate,
            time: "21:32",
        });
    },
};

export const Invalid: Story = {
    args: { error: "Choose a future date and time." },
};

export const Disabled: Story = {
    args: { disabled: true },
};
