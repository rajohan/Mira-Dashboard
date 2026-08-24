import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { Archive, Copy, Eye, Trash2 } from "lucide-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { DropdownMenu, type DropdownMenuAction } from "../DropdownMenu.tsx";

const defaultActions = Object.freeze([
    {
        description: "Inspect the full run payload and output.",
        icon: Eye,
        id: "view",
        label: "View run details",
        onSelect: fn(),
    },
    {
        icon: Copy,
        id: "duplicate",
        label: "Duplicate run",
        onSelect: fn(),
    },
] satisfies readonly DropdownMenuAction[]);

const meta = {
    args: {
        actions: defaultActions,
        triggerLabel: "Open run actions",
    },
    component: DropdownMenu,
    title: "UI/DropdownMenu",
} satisfies Meta<typeof DropdownMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const KeyboardSelection: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Open run actions" });
        const duplicateAction = args.actions.find((action) => action.id === "duplicate");

        if (duplicateAction === undefined) {
            throw new Error("The keyboard story is missing its duplicate action.");
        }

        await userEvent.tab();
        await expect(trigger).toHaveFocus();
        await userEvent.keyboard("{Enter}");
        await waitFor(async () => {
            const documentCanvas = within(canvasElement.ownerDocument.body);
            const menu = documentCanvas.getByRole("menu");
            const firstAction = documentCanvas.getByRole("menuitem", {
                name: /View run details/u,
            });

            await expect(menu).toHaveFocus();
            await expect(menu).toHaveAttribute("aria-activedescendant", firstAction.id);
        });
        await userEvent.keyboard("{ArrowDown}{Enter}");

        await expect(duplicateAction.onSelect).toHaveBeenCalledOnce();
        await waitFor(async () => {
            await expect(trigger).toHaveFocus();
        });
    },
};

export const DisabledAction: Story = {
    args: {
        actions: [
            {
                disabled: true,
                icon: Archive,
                id: "archive",
                label: "Archive active run",
                onSelect: fn(),
            },
            ...defaultActions,
        ],
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const disabledAction = args.actions.find((action) => action.id === "archive");

        if (disabledAction === undefined) {
            throw new Error("The disabled story is missing its archive action.");
        }

        await userEvent.click(canvas.getByRole("button", { name: "Open run actions" }));
        const archiveAction = await within(canvasElement.ownerDocument.body).findByRole(
            "menuitem",
            { name: "Archive active run" }
        );

        await expect(archiveAction).toBeDisabled();
        await expect(archiveAction).toHaveAttribute("aria-disabled", "true");
        await userEvent.click(archiveAction);
        await expect(disabledAction.onSelect).not.toHaveBeenCalled();
    },
};

export const DangerAction: Story = {
    args: {
        actions: [
            ...defaultActions,
            {
                description: "This cannot be undone.",
                icon: Trash2,
                id: "delete",
                label: "Delete run",
                onSelect: fn(),
                tone: "danger",
            },
        ],
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Open run actions" }));
        const deleteAction = await within(canvasElement.ownerDocument.body).findByRole(
            "menuitem",
            { name: /Delete run/u }
        );

        await expect(deleteAction).toHaveClass("text-red-300");
        await expect(deleteAction).toHaveTextContent("This cannot be undone.");
    },
};

export const NarrowMobileContainment: Story = {
    args: {
        actions: [
            {
                description:
                    "Review the complete delivery attempt before choosing the next action.",
                icon: Eye,
                id: "inspect",
                label: "Inspect delivery attempt",
                onSelect: fn(),
            },
            {
                description: "Removes the failed delivery and its retained output.",
                icon: Trash2,
                id: "delete",
                label: "Delete delivery attempt",
                onSelect: fn(),
                tone: "danger",
            },
        ],
        triggerLabel: "Open delivery actions",
    },
    parameters: {
        layout: "fullscreen",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const shell = canvas.getByTestId("narrow-menu-shell");

        await userEvent.click(
            canvas.getByRole("button", { name: "Open delivery actions" })
        );
        await waitFor(async () => {
            const menu = within(canvasElement.ownerDocument.body).getByRole("menu");
            const menuBounds = menu.getBoundingClientRect();
            const shellBounds = shell.getBoundingClientRect();

            await expect(menuBounds.left).toBeGreaterThanOrEqual(shellBounds.left);
            await expect(menuBounds.right).toBeLessThanOrEqual(shellBounds.right);
        });
    },
    render: (properties) => (
        <div
            className="bg-primary-950 flex min-h-72 w-80 max-w-full items-start justify-end p-2"
            data-testid="narrow-menu-shell"
        >
            <DropdownMenu {...properties} />
        </div>
    ),
};
