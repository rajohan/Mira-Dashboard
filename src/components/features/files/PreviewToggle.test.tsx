import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PreviewToggle } from "./PreviewToggle";

describe("PreviewToggle", () => {
    it("renders default labels and toggles preview mode", async () => {
        const user = userEvent.setup();
        const onToggle = vi.fn();

        render(<PreviewToggle preview={false} onToggle={onToggle} />);

        await user.click(screen.getByRole("button", { name: "Preview" }));
        await user.click(screen.getByRole("button", { name: "Raw" }));

        expect(onToggle).toHaveBeenNthCalledWith(1, true);
        expect(onToggle).toHaveBeenNthCalledWith(2, false);
    });

    it("supports custom labels", () => {
        render(
            <PreviewToggle
                preview
                onToggle={vi.fn()}
                previewLabel="Rendered"
                editLabel="Source"
            />
        );

        expect(screen.getByRole("button", { name: "Rendered" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Source" })).toBeInTheDocument();
    });
});
