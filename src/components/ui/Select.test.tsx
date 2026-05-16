import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Select } from "./Select";

describe("Select", () => {
    const options = [
        { value: "todo", label: "Todo", description: "New work" },
        { value: "done", label: "Done" },
    ];

    it("renders selected option and calls onChange from menu", async () => {
        const onChange = vi.fn();
        render(<Select value="todo" onChange={onChange} options={options} />);

        expect(screen.getByRole("button", { name: /Todo/u })).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: /Todo/u }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Done" }));

        expect(onChange).toHaveBeenCalledWith("done");
    });

    it("supports icon, full-width layout, and custom menu width", async () => {
        const { container } = render(
            <Select
                value="todo"
                onChange={vi.fn()}
                options={options}
                icon={<span data-testid="select-icon" />}
                width="w-full"
                menuWidth="w-64"
                className="custom-trigger"
            />
        );

        expect(screen.getByTestId("select-icon")).toBeInTheDocument();
        expect(container.firstElementChild).toHaveClass("block", "w-full");
        expect(screen.getByRole("button", { name: /Todo/u })).toHaveClass(
            "custom-trigger"
        );

        await userEvent.click(screen.getByRole("button", { name: /Todo/u }));
        expect(await screen.findByRole("menu")).toHaveClass("w-64");
    });

    it("renders placeholder when no selected option exists", () => {
        render(
            <Select
                value="missing"
                onChange={vi.fn()}
                options={options}
                placeholder="Pick"
            />
        );

        expect(screen.getByRole("button", { name: /Pick/u })).toBeInTheDocument();
    });

    it("keeps selected option in the accessible name with a control label", () => {
        render(
            <Select
                value="todo"
                onChange={vi.fn()}
                options={options}
                ariaLabel="Status"
            />
        );

        expect(screen.getByRole("button", { name: "Status: Todo" })).toBeInTheDocument();
    });
});
