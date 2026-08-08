import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { AutomationCapabilityPicker } from "../AutomationCapabilityPicker.tsx";

type AutomationCapabilityPickerProperties = ComponentProps<
    typeof AutomationCapabilityPicker
>;

interface ControlledAutomationCapabilityPickerProperties {
    readonly properties: AutomationCapabilityPickerProperties;
    readonly updateProperties: (
        properties: Partial<AutomationCapabilityPickerProperties>
    ) => void;
}

function ControlledAutomationCapabilityPicker({
    properties,
    updateProperties,
}: ControlledAutomationCapabilityPickerProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <AutomationCapabilityPicker
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

function RenderControlledAutomationCapabilityPicker(
    properties: AutomationCapabilityPickerProperties
) {
    const [, updateProperties] = useArgs<AutomationCapabilityPickerProperties>();

    return (
        <ControlledAutomationCapabilityPicker
            key={properties.value.join(",")}
            properties={properties}
            updateProperties={updateProperties}
        />
    );
}

const meta = {
    args: {
        onChange: fn(),
        value: ["agents:read", "cache:read", "jobs:read"],
    },
    component: AutomationCapabilityPicker,
    render: RenderControlledAutomationCapabilityPicker,
    title: "Security/AutomationCapabilityPicker",
} satisfies Meta<typeof AutomationCapabilityPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ScopedReadAccess: Story = {
    play: async ({ args, canvasElement }) => {
        const capability = within(canvasElement).getByRole("checkbox", {
            name: "cache:write",
        });

        await userEvent.click(capability);
        await waitFor(async () => {
            await expect(
                within(canvasElement).getByRole("checkbox", {
                    name: "cache:write",
                })
            ).toBeChecked();
        });
        await expect(args.onChange).toHaveBeenLastCalledWith([
            "agents:read",
            "cache:read",
            "cache:write",
            "jobs:read",
        ]);
    },
};

export const NoCapabilities: Story = {
    args: {
        value: [],
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
};
