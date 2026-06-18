import { screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { SessionActionsDropdown } from "./SessionActionsDropdown";

describe("SessionActionsDropdown", () => {
    it("renders compact, reset, and delete actions", async () => {
        const onCompact = jest.fn();
        const onReset = jest.fn();
        const onDelete = jest.fn();

        render(
            <SessionActionsDropdown
                onCompact={onCompact}
                onReset={onReset}
                onDelete={onDelete}
            />
        );

        await userEvent.click(screen.getByRole("button", { name: "Session actions" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Compact" }));
        await userEvent.click(screen.getByRole("button", { name: "Session actions" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Reset" }));
        await userEvent.click(screen.getByRole("button", { name: "Session actions" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

        expect(onCompact).toHaveBeenCalledTimes(1);
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("hides delete when disabled or missing", async () => {
        render(
            <SessionActionsDropdown
                onCompact={jest.fn()}
                onReset={jest.fn()}
                showDelete={false}
            />
        );

        await userEvent.click(screen.getByRole("button", { name: "Session actions" }));

        expect(
            await screen.findByRole("menuitem", { name: "Compact" })
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("menuitem", { name: "Delete" })
        ).not.toBeInTheDocument();
    });

    it("uses custom trigger labels when provided", () => {
        render(
            <SessionActionsDropdown
                ariaLabel="Actions for Main"
                onCompact={jest.fn()}
                onReset={jest.fn()}
            />
        );

        expect(screen.getByRole("button", { name: "Actions for Main" })).toHaveAttribute(
            "aria-haspopup",
            "menu"
        );
    });
});
