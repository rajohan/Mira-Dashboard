import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Alert } from "./Alert";

describe("Alert", () => {
    it("renders title and children with variant styles", () => {
        render(
            <Alert variant="warning" title="Careful" className="custom-alert">
                Something changed
            </Alert>
        );

        expect(screen.getByText("Careful")).toBeInTheDocument();
        expect(screen.getByText("Something changed")).toBeInTheDocument();
        expect(screen.getByText("Careful").closest("div")?.parentElement).toHaveClass(
            "border-yellow-500",
            "custom-alert"
        );
    });

    it("renders children without title", () => {
        render(<Alert>Plain info</Alert>);

        expect(screen.getByText("Plain info")).toBeInTheDocument();
    });
});
