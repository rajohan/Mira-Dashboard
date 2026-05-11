import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Card, CardTitle } from "./Card";

describe("Card", () => {
    it("renders bordered cards with custom props", () => {
        render(
            <Card variant="bordered" className="extra" data-testid="card">
                Body
            </Card>
        );

        expect(screen.getByTestId("card")).toHaveClass("border", "extra");
        expect(screen.getByText("Body")).toBeInTheDocument();
    });

    it("renders card titles", () => {
        render(<CardTitle className="title-extra">Overview</CardTitle>);

        expect(screen.getByRole("heading", { name: "Overview", level: 3 })).toHaveClass(
            "title-extra"
        );
    });
});
