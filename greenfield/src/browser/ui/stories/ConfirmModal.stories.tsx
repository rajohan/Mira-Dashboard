import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, waitFor, within } from "storybook/test";

import { Button } from "../Button.tsx";
import { ConfirmModal } from "../ConfirmModal.tsx";

type ConfirmModalProperties = ComponentProps<typeof ConfirmModal>;

interface ControlledConfirmModalProperties {
    readonly properties: ConfirmModalProperties;
    readonly updateProperties: (properties: Partial<ConfirmModalProperties>) => void;
}

function ControlledConfirmModal({
    properties,
    updateProperties,
}: ControlledConfirmModalProperties) {
    const [open, setOpen] = useState(properties.open);

    if (!open) {
        return (
            <Button
                onClick={() => {
                    setOpen(true);
                    updateProperties({ open: true });
                }}
            >
                Open confirmation
            </Button>
        );
    }

    return (
        <ConfirmModal
            {...properties}
            onCancel={() => {
                properties.onCancel();
                setOpen(false);
                updateProperties({ open: false });
            }}
            onConfirm={() => {
                properties.onConfirm();
                if (!properties.busy) {
                    setOpen(false);
                    updateProperties({ open: false });
                }
            }}
            open={open}
        />
    );
}

function RenderControlledConfirmModal(properties: ConfirmModalProperties) {
    const [, updateProperties] = useArgs<ConfirmModalProperties>();

    return (
        <ControlledConfirmModal
            key={String(properties.open)}
            properties={properties}
            updateProperties={updateProperties}
        />
    );
}

const meta = {
    args: {
        confirmLabel: "Continue",
        description: "This action updates the selected production release.",
        onCancel: fn(),
        onConfirm: fn(),
        open: true,
        title: "Confirm release change",
    },
    component: ConfirmModal,
    parameters: {
        layout: "fullscreen",
    },
    render: RenderControlledConfirmModal,
} satisfies Meta<typeof ConfirmModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Danger: Story = {
    args: {
        confirmLabel: "Delete",
        danger: true,
        description: "The release record will be permanently removed.",
        title: "Delete release?",
    },
};

export const Busy: Story = {
    args: {
        busy: true,
        confirmLabel: "Activating",
        description: "The dialog remains locked while activation is in progress.",
        title: "Activating release",
    },
    play: async ({ canvasElement }) => {
        await waitFor(async () => {
            const portalRoot = canvasElement.ownerDocument.querySelector(
                "#headlessui-portal-root"
            );

            if (!(portalRoot instanceof HTMLElement)) {
                throw new Error("The activation dialog portal was not mounted.");
            }

            await expect(
                within(portalRoot).getByRole("region", {
                    name: "Dialog content",
                })
            ).toHaveAttribute("tabindex", "0");
        });
    },
};
