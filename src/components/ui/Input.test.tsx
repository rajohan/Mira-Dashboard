import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Input } from "./Input";

describe("Input", () => {
    it("renders label, description, value changes, error and custom classes", async () => {
        const onChange = vi.fn();
        render(
            <Input
                label="Username"
                description="Pick a short name"
                error="Required"
                className="custom-input"
                value="mi"
                onChange={onChange}
            />
        );

        const input = screen.getByLabelText("Username");
        await userEvent.type(input, "ra");

        expect(screen.getByText("Pick a short name")).toBeInTheDocument();
        expect(screen.getByText("Required")).toBeInTheDocument();
        expect(input).toHaveClass("border-red-500", "custom-input");
        expect(onChange).toHaveBeenCalled();
    });
});
