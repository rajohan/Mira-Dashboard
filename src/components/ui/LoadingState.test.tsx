import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LoadingState } from "./LoadingState";

describe("LoadingState", () => {
    it("renders optional message and size classes", () => {
        const { container } = render(<LoadingState message="Loading tasks" size="lg" />);

        expect(screen.getByText("Loading tasks")).toBeInTheDocument();
        expect(container.firstElementChild).toHaveClass("h-64");
    });
});
