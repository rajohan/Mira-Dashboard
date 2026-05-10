import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
    it("renders default and custom content", () => {
        const { rerender } = render(<EmptyState />);
        expect(screen.getByText("No items found.")).toBeInTheDocument();

        rerender(
            <EmptyState message="No tasks">
                <button type="button">Create task</button>
            </EmptyState>
        );
        expect(screen.getByText("No tasks")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Create task" })).toBeInTheDocument();
    });
});
