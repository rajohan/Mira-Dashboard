import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Select, type SelectOption } from "../Select.tsx";

type Assignee = "mira" | "raymond" | "unassigned";
type AssigneeSelectProperties = ComponentProps<typeof Select<Assignee>>;

const assigneeOptions = Object.freeze([
    {
        description: "Automation and operational work",
        label: "Mira",
        value: "mira",
    },
    {
        description: "Product owner",
        label: "Raymond",
        value: "raymond",
    },
    {
        disabled: true,
        label: "Unassigned",
        value: "unassigned",
    },
] satisfies readonly SelectOption<Assignee>[]);

interface ControlledAssigneeSelectProperties {
    readonly properties: AssigneeSelectProperties;
    readonly updateProperties: (properties: Partial<AssigneeSelectProperties>) => void;
}

function ControlledAssigneeSelect({
    properties,
    updateProperties,
}: ControlledAssigneeSelectProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <Select
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

function RenderControlledAssigneeSelect(properties: AssigneeSelectProperties) {
    const [, updateProperties] = useArgs<AssigneeSelectProperties>();

    return (
        <div className="w-full max-w-80 scroll-mt-[123.456px]">
            <ControlledAssigneeSelect
                key={properties.value}
                properties={properties}
                updateProperties={updateProperties}
            />
        </div>
    );
}

const meta = {
    args: {
        ariaLabel: "Assignee",
        onChange: fn(),
        options: assigneeOptions,
        value: "mira",
    },
    component: Select,
    parameters: {
        layout: "padded",
    },
    render: RenderControlledAssigneeSelect,
    title: "UI/Select",
} satisfies Meta<typeof Select<Assignee>>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Invalid: Story = {
    args: {
        invalid: true,
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
};

export const KeyboardAndFocus: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Assignee" });
        const storyRoot = canvasElement.firstElementChild;

        if (!(storyRoot instanceof HTMLElement)) {
            throw new Error("The assignee story root was not mounted.");
        }

        await expect(getComputedStyle(storyRoot).scrollMarginTop).toBe("123.456px");

        await userEvent.click(trigger);
        await waitFor(async () => {
            const currentTrigger = canvas.getByRole("button", { name: "Assignee" });
            const optionsId = currentTrigger.getAttribute("aria-controls");
            const optionsElement =
                optionsId === null
                    ? null
                    : canvasElement.ownerDocument.getElementById(optionsId);

            if (!(optionsElement instanceof HTMLElement)) {
                throw new Error("The assignee option panel was not mounted.");
            }

            await expect(
                within(optionsElement).getByRole("option", { name: /Raymond/u })
            ).toBeVisible();
        });
        await userEvent.keyboard("{Escape}");
        await waitFor(async () => {
            await expect(canvas.getByRole("button", { name: "Assignee" })).toHaveFocus();
        });
    },
};
