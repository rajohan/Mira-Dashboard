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
});
