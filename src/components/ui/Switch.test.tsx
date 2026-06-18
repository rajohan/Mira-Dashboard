import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { Switch } from "./Switch";

describe("Switch", () => {
    it("renders label/description and emits changes", async () => {
        const onChange = jest.fn();
        render(
            <Switch
                checked={false}
                onChange={onChange}
                label="Auto review"
                description="Review every push"
            />
        );

        await userEvent.click(screen.getByRole("switch", { name: "Auto review" }));

        expect(screen.getByText("Review every push")).toBeInTheDocument();
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it("renders without label or description", () => {
        const { container } = render(
            <Switch checked={false} onChange={jest.fn()} className="extra" />
        );

        expect(screen.getByRole("switch")).toBeInTheDocument();
        expect(container.firstElementChild).toHaveClass("extra");
    });

    it("shows checked and disabled state", () => {
        render(<Switch checked onChange={jest.fn()} label="Enabled" disabled />);

        expect(screen.getByRole("switch", { name: "Enabled" })).toBeChecked();
        expect(screen.getByRole("switch", { name: "Enabled" })).toBeDisabled();
    });
});
