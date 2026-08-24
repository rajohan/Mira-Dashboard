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

    return (
        <>
            <Button
                onClick={() => {
                    setOpen(true);
                    updateProperties({ open: true });
                }}
                variant="secondary"
            >
                Open schedule details
            </Button>
            <Modal
                {...properties}
                onClose={() => {
                    properties.onClose();
                    setOpen(false);
                    updateProperties({ open: false });
                }}
                open={open}
            />
        </>
    );
}

function RenderControlledModal(properties: ModalProperties) {
    const [, updateProperties] = useArgs<ModalProperties>();

    return (
        <ControlledModal properties={properties} updateProperties={updateProperties} />
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
        // Keep autodocs readable. Each example exposes an explicit trigger instead
        // of mounting a portalled dialog over the documentation page.
        open: false,
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

export const LongUnbrokenTitle: Story = {
    args: {
        description:
            "A bounded dialog must keep every action reachable on narrow screens.",
        title: `attachment-${"x".repeat(255)}.json`,
    },
    parameters: {
        viewport: { defaultViewport: "mobile1" },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            canvas.getByRole("button", { name: "Open schedule details" })
        );
        const dialog = await waitFor(() =>
            within(canvasElement.ownerDocument.body).getByRole("dialog")
        );
        const panel = within(dialog).getByTestId("modal-panel");
        const close = within(dialog).getByRole("button", {
            name: "Close dialog",
        });
        const viewportWidth = canvasElement.ownerDocument.documentElement.clientWidth;

        await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
        await expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(
            viewportWidth
        );
        await expect(close.getBoundingClientRect().right).toBeLessThanOrEqual(
            viewportWidth
        );
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
            const portalRoot = canvasElement.ownerDocument.querySelector(
                "#headlessui-portal-root"
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
