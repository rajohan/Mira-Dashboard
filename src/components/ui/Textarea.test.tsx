import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Textarea } from "./Textarea";

describe("Textarea", () => {
    it("renders default textarea metadata and reports changes", async () => {
        const onChange = vi.fn();
        render(
            <Textarea
                label="Notes"
                description="Markdown supported"
                error="Too short"
                value="hello"
                onChange={onChange}
            />
        );

        const textarea = screen.getByRole("textbox");
        await userEvent.type(textarea, " world");

        expect(screen.getByText("Notes")).toBeInTheDocument();
        expect(screen.getByText("Markdown supported")).toBeInTheDocument();
        expect(screen.getByText("Too short")).toBeInTheDocument();
        expect(textarea).toHaveClass("border-red-500");
        expect(onChange).toHaveBeenCalled();
    });

    it("supports code variant", () => {
        render(<Textarea label="JSON" variant="code" value="{}" readOnly />);

        expect(screen.getByText("JSON")).toBeInTheDocument();
        expect(screen.getByRole("textbox")).toHaveClass("font-mono", "bg-transparent");
    });
});
