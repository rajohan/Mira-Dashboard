import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, within } from "storybook/test";

import { Fieldset } from "../Fieldset.tsx";
import { FormField } from "../FormField.tsx";
import { Input } from "../Input.tsx";

const meta = {
    args: {
        children: null,
        description: "These values are used for delivery notifications.",
        legend: "Delivery contact",
    },
    component: Fieldset,
    title: "UI/Fieldset",
} satisfies Meta<typeof Fieldset>;

export default meta;

type Story = StoryObj<typeof meta>;

function ContactFields() {
    return (
        <div className="mt-3 grid max-w-xl gap-3 sm:grid-cols-2">
            <FormField label="Name">
                <Input className="mt-2" defaultValue="Mira" />
            </FormField>
            <FormField label="Email">
                <Input
                    className="mt-2"
                    defaultValue="mira@example.invalid"
                    type="email"
                />
            </FormField>
        </div>
    );
}

export const Default: Story = {
    render: (properties) => (
        <Fieldset {...properties}>
            <ContactFields />
        </Fieldset>
    ),
};

export const Disabled: Story = {
    args: { disabled: true },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("textbox", { name: "Name" })).toBeDisabled();
        await expect(canvas.getByRole("textbox", { name: "Email" })).toBeDisabled();
    },
    render: (properties) => (
        <Fieldset {...properties}>
            <ContactFields />
        </Fieldset>
    ),
};

export const Invalid: Story = {
    args: { error: "Review the delivery contact." },
    render: (properties) => (
        <Fieldset {...properties}>
            <Input aria-label="Delivery contact" className="mt-3 max-w-xl" />
        </Fieldset>
    ),
};
