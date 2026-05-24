import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SearchInput } from "./SearchInput";

describe("SearchInput", () => {
    it("renders placeholder and emits typed values", async () => {
        const onChange = vi.fn();
        render(<SearchInput value="" onChange={onChange} placeholder="Search tasks" />);

        await userEvent.type(
            screen.getByRole("textbox", { name: "Search tasks" }),
            "task"
        );

        expect(onChange).toHaveBeenCalledWith("t");
    });

    it("allows a distinct accessible label", () => {
        render(
            <SearchInput
                value=""
                onChange={vi.fn()}
                label="Filter task board"
                placeholder="Search tasks"
            />
        );

        expect(
            screen.getByRole("textbox", { name: "Filter task board" })
        ).toHaveAttribute("placeholder", "Search tasks");
    });
});
