import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
    it("renders label/description and emits changes", async () => {
        const onChange = vi.fn();
        render(
            <Checkbox
                checked={false}
                onChange={onChange}
                label="Enable checks"
                description="Run tests before deploy"
            />
        );

        await userEvent.click(screen.getByRole("checkbox", { name: "Enable checks" }));

        expect(screen.getByText("Run tests before deploy")).toBeInTheDocument();
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it("shows checked state and respects disabled", () => {
        render(<Checkbox checked onChange={vi.fn()} label="Done" disabled />);

        const checkbox = screen.getByRole("checkbox", { name: "Done" });

        expect(checkbox).toBeChecked();
        expect(checkbox).toHaveAttribute("aria-disabled", "true");
    });
});
