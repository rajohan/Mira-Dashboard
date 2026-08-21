import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Alert } from "../Alert.tsx";
import { Button } from "../Button.tsx";

type AlertProperties = ComponentProps<typeof Alert>;

function focusElement(element: HTMLButtonElement | null): void {
    element?.focus();
}

function DismissibleAlert(properties: AlertProperties) {
    const [visible, setVisible] = useState(true);

    if (!visible) {
        return (
            <Button
                onClick={() => setVisible(true)}
                ref={focusElement}
                variant="secondary"
            >
                Show message
            </Button>
        );
    }

    return (
        <Alert
            {...properties}
            onDismiss={() => {
                properties.onDismiss?.();
                setVisible(false);
            }}
        />
    );
}

const meta = {
    args: {
        message: "The dashboard could not save the requested change.",
    },
    component: Alert,
} satisfies Meta<typeof Alert>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Error: Story = {
    play: async ({ canvasElement }) => {
        const alert = within(canvasElement).getByRole("alert");

        await expect(alert).toHaveFocus();
        await expect(alert).toHaveTextContent(
            "The dashboard could not save the requested change."
        );
    },
};

export const Information: Story = {
    args: {
        message: "The worker inventory refreshes automatically.",
        variant: "info",
    },
};

export const Success: Story = {
    args: {
        message: "The schedule was saved.",
        variant: "success",
    },
};

export const Warning: Story = {
    args: {
        message: "Database maintenance review is required.",
        variant: "warning",
    },
};

export const ErrorWithoutFocus: Story = {
    args: {
        focusOnError: false,
    },
};

export const Dismissible: Story = {
    args: {
        dismissLabel: "Dismiss save error",
        onDismiss: fn(),
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Dismiss save error" }));
        await waitFor(async () => {
            await expect(args.onDismiss).toHaveBeenCalledTimes(1);
            await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
            await expect(
                canvas.getByRole("button", { name: "Show message" })
            ).toHaveFocus();
        });

        await userEvent.click(canvas.getByRole("button", { name: "Show message" }));
        await waitFor(async () => {
            await expect(canvas.getByRole("alert")).toHaveFocus();
            await expect(
                canvas.getByRole("button", { name: "Dismiss save error" })
            ).toBeVisible();
        });
    },
    render: (properties) => <DismissibleAlert {...properties} />,
};
