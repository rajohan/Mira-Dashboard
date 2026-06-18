import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
    it("renders label/description and emits changes", async () => {
        const onChange = jest.fn();
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

    it("renders without label or description", () => {
        render(<Checkbox checked={false} onChange={jest.fn()} />);

        expect(screen.getByRole("checkbox")).toBeInTheDocument();
    });

    it("shows checked state and respects disabled", () => {
        render(<Checkbox checked onChange={jest.fn()} label="Done" disabled />);

        const checkbox = screen.getByRole("checkbox", { name: "Done" });

        expect(checkbox).toBeChecked();
        expect(checkbox).toHaveAttribute("aria-disabled", "true");
    });
});
