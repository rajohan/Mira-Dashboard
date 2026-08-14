import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState, type ComponentProps } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Combobox, type ComboboxOption } from "../Combobox.tsx";
import { FormField } from "../FormField.tsx";

type TimeZone = "America/New_York" | "Asia/Tokyo" | "Europe/Oslo" | "UTC";
type TimeZoneComboboxProperties = ComponentProps<typeof Combobox<string>>;
interface ControlledTimeZoneComboboxProperties extends TimeZoneComboboxProperties {
    readonly onStoryValueChange: (value: string) => void;
}

const timeZoneOptions = Object.freeze([
    { label: "UTC", value: "UTC" },
    {
        description: "Central European Time",
        keywords: ["Norway", "CET"],
        label: "Europe/Oslo",
        value: "Europe/Oslo",
    },
    { label: "America/New_York", value: "America/New_York" },
    { label: "Asia/Tokyo", value: "Asia/Tokyo" },
] satisfies readonly ComboboxOption<TimeZone>[]);

const manyOptions = Object.freeze(
    Array.from({ length: 120 }, (_value, index) => {
        const value = `Region/Zone_${index.toString().padStart(3, "0")}`;
        return { label: value, value };
    })
) satisfies readonly ComboboxOption<string>[];

function ControlledTimeZoneCombobox({
    onStoryValueChange,
    ...properties
}: ControlledTimeZoneComboboxProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <div className="w-full max-w-md">
            <FormField
                description="UTC or a canonical IANA zone."
                disabled={properties.disabled}
                error={properties.invalid ? "Choose a canonical time zone." : undefined}
                label="Time zone"
            >
                <Combobox
                    {...properties}
                    className="mt-2"
                    onChange={(nextValue) => {
                        setValue(nextValue);
                        onStoryValueChange(nextValue);
                        properties.onChange(nextValue);
                    }}
                    value={value}
                />
            </FormField>
        </div>
    );
}

function RenderControlledTimeZoneCombobox(properties: TimeZoneComboboxProperties) {
    const [, updateProperties] = useArgs<TimeZoneComboboxProperties>();

    return (
        <ControlledTimeZoneCombobox
            key={properties.value}
            {...properties}
            onStoryValueChange={(nextValue) => updateProperties({ value: nextValue })}
        />
    );
}

const meta = {
    args: {
        ariaLabel: "Time zone",
        onChange: fn(),
        options: timeZoneOptions,
        placeholder: "Search time zones…",
        value: "UTC",
    },
    component: Combobox,
    parameters: { layout: "padded" },
    render: RenderControlledTimeZoneCombobox,
    title: "UI/Combobox",
} satisfies Meta<typeof Combobox<string>>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        const input = canvas.getByRole("combobox", { name: "Time zone" });

        await userEvent.clear(input);
        await userEvent.type(input, "norway");
        await userEvent.click(page.getByRole("option", { name: /Europe\/Oslo/u }));

        await expect(input).toHaveValue("Europe/Oslo");
        await expect(args.onChange).toHaveBeenLastCalledWith("Europe/Oslo");
    },
};

export const NoMatches: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        const input = canvas.getByRole("combobox", { name: "Time zone" });

        await userEvent.clear(input);
        await userEvent.type(input, "not-a-zone");
        await expect(
            page.getByRole("option", { name: "No matching options" })
        ).toHaveAttribute("aria-disabled", "true");
    },
};

export const Invalid: Story = {
    args: { invalid: true },
};

export const Disabled: Story = {
    args: { disabled: true },
};

export const LargeVirtualized: Story = {
    args: {
        options: manyOptions,
        value: "Region/Zone_000",
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        const input = canvas.getByRole("combobox", { name: "Time zone" });

        await userEvent.click(canvas.getByRole("button", { name: "Open Time zone" }));
        await waitFor(async () => {
            await expect(page.getByRole("listbox").getBoundingClientRect().height).toBe(
                256
            );
            const renderedOptions = page.getAllByRole("option");
            await expect(renderedOptions.length).toBeGreaterThan(0);
            await expect(renderedOptions.length).toBeLessThan(manyOptions.length);
            for (const option of renderedOptions) {
                await expect(option.getBoundingClientRect().height).toBe(40);
            }
        });

        await userEvent.clear(input);
        await userEvent.type(input, "No such zone");
        await waitFor(async () => {
            await expect(page.getByRole("listbox").getBoundingClientRect().height).toBe(
                256
            );
            await expect(
                page
                    .getByRole("option", { name: "No matching options" })
                    .getBoundingClientRect().height
            ).toBe(40);
        });

        await userEvent.clear(input);
        await userEvent.type(input, "Zone_119");
        await userEvent.click(page.getByRole("option", { name: "Region/Zone_119" }));
        await expect(input).toHaveValue("Region/Zone_119");
        await expect(args.onChange).toHaveBeenLastCalledWith("Region/Zone_119");
    },
};
