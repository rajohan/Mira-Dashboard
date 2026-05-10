import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SearchInput } from "./SearchInput";

describe("SearchInput", () => {
    it("renders placeholder and emits typed values", async () => {
        const onChange = vi.fn();
        render(<SearchInput value="" onChange={onChange} placeholder="Search tasks" />);

        await userEvent.type(screen.getByPlaceholderText("Search tasks"), "task");

        expect(onChange).toHaveBeenCalledWith("t");
    });
});
