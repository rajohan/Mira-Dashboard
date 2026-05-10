import { screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SessionActionsDropdown } from "./SessionActionsDropdown";

describe("SessionActionsDropdown", () => {
    it("renders compact, reset, and delete actions", async () => {
        const onCompact = vi.fn();
        const onReset = vi.fn();
        const onDelete = vi.fn();

        render(
            <SessionActionsDropdown
                onCompact={onCompact}
                onReset={onReset}
                onDelete={onDelete}
            />
        );

        await userEvent.click(screen.getByRole("button"));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Compact" }));
        await userEvent.click(screen.getByRole("button"));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Reset" }));
        await userEvent.click(screen.getByRole("button"));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

        expect(onCompact).toHaveBeenCalledTimes(1);
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("hides delete when disabled or missing", async () => {
        render(
            <SessionActionsDropdown
                onCompact={vi.fn()}
                onReset={vi.fn()}
                showDelete={false}
            />
        );

        await userEvent.click(screen.getByRole("button"));

        expect(
            await screen.findByRole("menuitem", { name: "Compact" })
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("menuitem", { name: "Delete" })
        ).not.toBeInTheDocument();
    });
});
