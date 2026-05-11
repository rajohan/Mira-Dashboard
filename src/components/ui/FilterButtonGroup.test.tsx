import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FilterButtonGroup } from "./FilterButtonGroup";

describe("FilterButtonGroup", () => {
    it("renders without optional className", () => {
        const { container } = render(
            <FilterButtonGroup
                options={[{ value: "all", label: "All" }]}
                value="all"
                onChange={vi.fn()}
            />
        );

        expect(container.firstElementChild).toHaveClass("flex", "gap-2");
    });

    it("renders options and emits selected values", async () => {
        const onChange = vi.fn();
        render(
            <FilterButtonGroup
                options={[
                    { value: "all", label: "All" },
                    { value: "open", label: "Open" },
                ]}
                value="all"
                onChange={onChange}
                className="extra"
            />
        );

        expect(screen.getByRole("button", { name: "All" })).toHaveClass("bg-accent-500");
        await userEvent.click(screen.getByRole("button", { name: "Open" }));

        expect(onChange).toHaveBeenCalledWith("open");
    });
});
