import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Checkbox } from "../Checkbox.tsx";

type CheckboxProperties = ComponentProps<typeof Checkbox>;

interface ControlledCheckboxProperties {
    readonly properties: CheckboxProperties;
    readonly updateProperties: (properties: Partial<CheckboxProperties>) => void;
}

function ControlledCheckbox({
    properties,
    updateProperties,
}: ControlledCheckboxProperties) {
    const [checked, setChecked] = useState(properties.checked);

    return (
        <Checkbox
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

function RenderControlledCheckbox(properties: CheckboxProperties) {
    const [, updateProperties] = useArgs<CheckboxProperties>();

    return (
        <ControlledCheckbox
            key={String(properties.checked)}
            properties={properties}
            updateProperties={updateProperties}
        />
    );
}

const meta = {
    args: {
        checked: false,
        description: "Allow this credential to refresh reviewed cache entries.",
        label: "Cache write access",
        onChange: fn(),
    },
    component: Checkbox,
    render: RenderControlledCheckbox,
    title: "UI/Checkbox",
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

const checkedHoverColor = "rgb(110, 150, 255)";
const uncheckedHoverBackgroundColor = "rgb(26, 28, 32)";

async function expectHoverStyles(
    checkbox: HTMLElement,
    expectedBackgroundColor: string
): Promise<void> {
    await waitFor(async () => {
        const styles = getComputedStyle(checkbox);
        await expect(styles.backgroundColor).toBe(expectedBackgroundColor);
        await expect(styles.borderColor).toBe(checkedHoverColor);
    });
}

async function verifyHoverState(
    checkbox: HTMLElement,
    expectedBackgroundColor: string
): Promise<void> {
    checkbox.dataset.hover = "";
    await expect(checkbox).toHaveAttribute("data-hover");
    await expectHoverStyles(checkbox, expectedBackgroundColor);

    delete checkbox.dataset.hover;
    await expect(checkbox).not.toHaveAttribute("data-hover");
}

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const checkbox = within(canvasElement).getByRole("checkbox", {
            name: "Cache write access",
        });

        await verifyHoverState(checkbox, uncheckedHoverBackgroundColor);
    },
};

export const Checked: Story = {
    args: {
        checked: true,
    },
    play: async ({ canvasElement }) => {
        const checkbox = within(canvasElement).getByRole("checkbox", {
            name: "Cache write access",
        });

        await verifyHoverState(checkbox, checkedHoverColor);
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
    play: async ({ canvasElement }) => {
        const checkbox = within(canvasElement).getByRole("checkbox", {
            name: "Cache write access",
        });
        const initialStyles = getComputedStyle(checkbox);
        const initialBackgroundColor = initialStyles.backgroundColor;
        const initialBorderColor = initialStyles.borderColor;

        await userEvent.hover(checkbox);

        await waitFor(async () => {
            const hoveredStyles = getComputedStyle(checkbox);
            await expect(hoveredStyles.backgroundColor).toBe(initialBackgroundColor);
            await expect(hoveredStyles.borderColor).toBe(initialBorderColor);
        });
    },
};

export const KeyboardToggle: Story = {
    play: async ({ canvasElement }) => {
        const checkbox = within(canvasElement).getByRole("checkbox", {
            name: "Cache write access",
        });

        checkbox.focus();
        await userEvent.keyboard(" ");
        await waitFor(async () => {
            await expect(
                within(canvasElement).getByRole("checkbox", {
                    name: "Cache write access",
                })
            ).toBeChecked();
        });
    },
};
