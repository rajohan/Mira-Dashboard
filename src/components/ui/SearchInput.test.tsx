import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { SearchInput } from "./SearchInput";

describe("SearchInput", () => {
    it("renders placeholder and emits typed values", async () => {
        const onChange = jest.fn();
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
                onChange={jest.fn()}
                label="Filter task board"
                placeholder="Search tasks"
            />
        );

        expect(
            screen.getByRole("textbox", { name: "Filter task board" })
        ).toHaveAttribute("placeholder", "Search tasks");
    });

    it("uses the first non-empty accessible label fallback", () => {
        render(
            <SearchInput
                value=""
                onChange={jest.fn()}
                label="   "
                placeholder=" Search tasks "
            />
        );

        expect(screen.getByRole("textbox", { name: "Search tasks" })).toHaveAttribute(
            "aria-label",
            "Search tasks"
        );
    });

    it("uses a fallback accessible label when label and placeholder are empty", () => {
        render(
            <SearchInput value="" onChange={jest.fn()} label="   " placeholder="   " />
        );

        expect(screen.getByRole("textbox", { name: "Search" })).toHaveAttribute(
            "aria-label",
            "Search"
        );
    });

    it("clears the value with a default accessible label", async () => {
        const onChange = jest.fn();
        render(
            <SearchInput
                value="deploy"
                onChange={onChange}
                label="Find deployments"
                placeholder="Search"
            />
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Clear find deployments" })
        );

        expect(onChange).toHaveBeenCalledWith("");
    });
});
