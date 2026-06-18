import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { Dropdown } from "./Dropdown";

describe("Dropdown", () => {
    it("renders items and invokes enabled item actions", async () => {
        const onEdit = jest.fn();
        const onDelete = jest.fn();
        render(
            <Dropdown
                label="Actions"
                items={[
                    { label: "Edit", onClick: onEdit },
                    { label: "Delete", onClick: onDelete, variant: "danger" },
                    { label: "Disabled", disabled: true },
                ]}
            />
        );

        await userEvent.click(screen.getByRole("button", { name: /Actions/u }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
        await userEvent.click(screen.getByRole("button", { name: /Actions/u }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

        expect(onEdit).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("supports icon-only left-aligned primary trigger", async () => {
        render(
            <Dropdown
                align="left"
                ariaLabel="More actions"
                variant="primary"
                size="md"
                icon={<span data-testid="more-icon" />}
                items={[{ label: "Open" }]}
            />
        );

        const button = screen.getByRole("button", { name: "More actions" });
        expect(screen.getByTestId("more-icon")).toBeInTheDocument();
        expect(button).toHaveClass("bg-accent-500", "px-4");
        await userEvent.click(button);
        expect(await screen.findByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    });

    it("renders custom menu content", async () => {
        render(<Dropdown label="More" content={<div>Custom content</div>} />);

        await userEvent.click(screen.getByRole("button", { name: /More/u }));

        expect(await screen.findByText("Custom content")).toBeInTheDocument();
    });
});
