import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "bun:test";
import { Circle } from "lucide-react";

import { ExpandableCard, ReadOnlyField } from "./ExpandableCard";

describe("ExpandableCard", () => {
    it("toggles children and supports default expanded state", async () => {
        render(
            <ExpandableCard title="Details" icon={Circle} defaultExpanded>
                <p>Expanded content</p>
            </ExpandableCard>
        );

        expect(screen.getByText("Expanded content")).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: /Details/u }));
        expect(screen.queryByText("Expanded content")).not.toBeInTheDocument();
    });
});

describe("ReadOnlyField", () => {
    it("renders values and empty fallback", () => {
        const { rerender } = render(<ReadOnlyField label="Status" value={false} />);

        expect(screen.getByText("Status")).toBeInTheDocument();
        expect(screen.getByText("false")).toBeInTheDocument();

        rerender(<ReadOnlyField label="Status" />);

        expect(screen.getByText("—")).toBeInTheDocument();
    });
});
