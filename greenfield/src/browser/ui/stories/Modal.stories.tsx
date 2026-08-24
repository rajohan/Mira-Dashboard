import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Button } from "../Button.tsx";
import { Modal } from "../Modal.tsx";
import { Text } from "../Text.tsx";

type ModalProperties = ComponentProps<typeof Modal>;

interface ControlledModalProperties {
    readonly properties: ModalProperties;
    readonly updateProperties: (properties: Partial<ModalProperties>) => void;
}

function ControlledModal({ properties, updateProperties }: ControlledModalProperties) {
    const [open, setOpen] = useState(properties.open);

    if (!open) {
        return (
            <Button
                autoFocus
                onClick={() => {
                    setOpen(true);
                    updateProperties({ open: true });
                }}
                variant="secondary"
            >
                Open schedule details
            </Button>
        );
    }

    return (
        <Modal
            {...properties}
            onClose={() => {
                properties.onClose();
                setOpen(false);
                updateProperties({ open: false });
            }}
            open={open}
        />
    );
}

function RenderControlledModal(properties: ModalProperties) {
    const [, updateProperties] = useArgs<ModalProperties>();

    return (
        <ControlledModal
            key={String(properties.open)}
            properties={properties}
            updateProperties={updateProperties}
        />
    );
}

const meta = {
    args: {
        children: (
            <Text>
                This dialog can host forms, reviewed metadata, and explicit actions.
            </Text>
        ),
        description: "Inspect the selected schedule before making changes.",
        onClose: fn(),
        open: true,
        title: "Schedule details",
    },
    component: Modal,
    parameters: {
        layout: "fullscreen",
    },
    render: RenderControlledModal,
    title: "UI/Modal",
} satisfies Meta<typeof Modal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
    args: {
        size: "sm",
    },
};

export const NonDismissible: Story = {
    args: {
        description: "The action must finish before this dialog can close.",
        dismissible: false,
        title: "Applying release",
    },
};

export const DismissAndRestoreFocus: Story = {
    args: {
        open: false,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const openButton = canvas.getByRole("button", {
            name: "Open schedule details",
        });

        await userEvent.click(openButton);
        const dialog = await waitFor(() => {
            const portalRoot = canvasElement.ownerDocument.getElementById(
                "headlessui-portal-root"
            );

            if (!(portalRoot instanceof HTMLElement)) {
                throw new Error("The schedule details dialog portal was not mounted.");
            }

            return within(portalRoot).getByRole("dialog", {
                name: "Schedule details",
            });
        });
        const closeButton = within(dialog).getByRole("button", {
            name: "Close dialog",
        });

        await waitFor(async () => {
            await expect(dialog).toBeVisible();
            await expect(dialog).toHaveFocus();
        });
        await userEvent.click(closeButton);
        await waitFor(async () => {
            await expect(dialog).not.toBeInTheDocument();
            await expect(
                canvas.getByRole("button", {
                    name: "Open schedule details",
                })
            ).toHaveFocus();
        });
    },
};
