import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Switch } from "../Switch.tsx";

type SwitchProperties = ComponentProps<typeof Switch>;

interface ControlledSwitchProperties {
    readonly properties: SwitchProperties;
    readonly updateProperties: (properties: Partial<SwitchProperties>) => void;
}

function ControlledSwitch({ properties, updateProperties }: ControlledSwitchProperties) {
    const [checked, setChecked] = useState(properties.checked);

    return (
        <Switch
            {...properties}
            checked={checked}
            onChange={(nextChecked) => {
                setChecked(nextChecked);
                updateProperties({ checked: nextChecked });
                properties.onChange(nextChecked);
            }}
        />
    );
}

function RenderControlledSwitch(properties: SwitchProperties) {
    const [, updateProperties] = useArgs<SwitchProperties>();

    return (
        <div className="w-80 max-w-full">
            <ControlledSwitch
                key={String(properties.checked)}
                properties={properties}
                updateProperties={updateProperties}
            />
        </div>
    );
}

const meta = {
    args: {
        checked: false,
        description: "Notify operators when this worker stops reporting.",
        label: "Worker alerts",
        onChange: fn(),
    },
    component: Switch,
    parameters: {
        layout: "padded",
    },
    render: RenderControlledSwitch,
    title: "UI/Switch",
} satisfies Meta<typeof Switch>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
    args: {
        checked: true,
    },
};

export const Invalid: Story = {
    args: {
        error: "Resolve the worker notification target first.",
        invalid: true,
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
};

export const KeyboardToggle: Story = {
    play: async ({ args, canvasElement }) => {
        const control = within(canvasElement).getByRole("switch", {
            name: "Worker alerts",
        });

        await userEvent.tab();
        await expect(control).toHaveFocus();
        await userEvent.keyboard(" ");
        await waitFor(async () => {
            await expect(control).toBeChecked();
        });
        await expect(args.onChange).toHaveBeenLastCalledWith(true);
    },
};
