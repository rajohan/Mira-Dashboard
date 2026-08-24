import { describe, expect, test } from "bun:test";

import { Archive, Copy, Trash2 } from "lucide-react";

import { DropdownMenu, type DropdownMenuAction } from "./DropdownMenu.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("DropdownMenu", () => {
    test("selects actions from the keyboard while skipping disabled items", async () => {
        const selectedActions: string[] = [];
        const actions = Object.freeze([
            {
                description: "Moves the task out of the active queue.",
                icon: Archive,
                id: "archive",
                label: "Archive task",
                onSelect: () => selectedActions.push("archive"),
            },
            {
                disabled: true,
                icon: Copy,
                id: "duplicate",
                label: "Duplicate task",
                onSelect: () => selectedActions.push("duplicate"),
            },
            {
                description: "Permanently removes the task.",
                icon: Trash2,
                id: "delete",
                label: "Delete task",
                onSelect: () => selectedActions.push("delete"),
                tone: "danger",
            },
        ] satisfies readonly DropdownMenuAction[]);

        render(<DropdownMenu actions={actions} triggerLabel="Open task actions" />);
        const user = userEvent.setup();
        const trigger = screen.getByRole("button", { name: "Open task actions" });

        await user.tab();
        expect(trigger).toHaveFocus();
        await user.keyboard("{Enter}");

        const menu = screen.getByRole("menu");
        const archive = screen.getByRole("menuitem", {
            name: /Archive task/u,
        });
        const duplicate = screen.getByRole("menuitem", { name: "Duplicate task" });
        const deleteAction = screen.getByRole("menuitem", {
            name: /Delete task/u,
        });

        expect(menu).toHaveFocus();
        expect(menu).toHaveAttribute("aria-activedescendant", archive.id);
        expect(duplicate).toBeDisabled();
        expect(duplicate).toHaveAttribute("aria-disabled", "true");
        expect(deleteAction).toHaveClass("text-red-300");

        await user.keyboard("{ArrowDown}");
        expect(menu).toHaveAttribute("aria-activedescendant", deleteAction.id);
        await user.keyboard("{Enter}");

        expect(selectedActions).toEqual(["delete"]);
    });
});
