import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./Button";

describe("Button", () => {
    it("renders children and forwards click handlers", async () => {
        const onClick = vi.fn();
        render(<Button onClick={onClick}>Save</Button>);

        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("applies variant, size, disabled, and custom classes", () => {
        render(
            <Button variant="danger" size="lg" className="custom-class" disabled>
                Delete
            </Button>
        );

        const button = screen.getByRole("button", { name: "Delete" });
        expect(button).toBeDisabled();
        expect(button).toHaveClass("bg-red-500", "px-6", "py-3", "custom-class");
    });
});
