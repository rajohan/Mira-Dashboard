import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dropdown } from "./Dropdown";

describe("Dropdown", () => {
    it("renders items and invokes enabled item actions", async () => {
        const onEdit = vi.fn();
        const onDelete = vi.fn();
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

    it("renders custom menu content", async () => {
        render(<Dropdown label="More" content={<div>Custom content</div>} />);

        await userEvent.click(screen.getByRole("button", { name: /More/u }));

        expect(await screen.findByText("Custom content")).toBeInTheDocument();
    });
});
