import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FileNode } from "../../../types/file";
import { FilesSidebar } from "./FilesSidebar";

const files: FileNode[] = [
    { name: "zeta.md", path: "/zeta.md", type: "file" },
    { loaded: true, name: "src", path: "/src", type: "directory" },
    { name: "alpha.json", path: "/alpha.json", type: "file" },
];

describe("FilesSidebar", () => {
    it("renders loading and empty states", () => {
        const { rerender } = render(
            <FilesSidebar
                files={[]}
                rootLoading
                selectedPath={null}
                expandedPaths={new Set()}
                onSelect={vi.fn()}
                onToggle={vi.fn()}
            />
        );

        expect(screen.getByText("Loading...")).toBeInTheDocument();

        rerender(
            <FilesSidebar
                files={[]}
                rootLoading={false}
                selectedPath={null}
                expandedPaths={new Set()}
                onSelect={vi.fn()}
                onToggle={vi.fn()}
            />
        );

        expect(screen.getByText("No files found")).toBeInTheDocument();
    });

    it("sorts workspace files and delegates selection/toggle events", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const onToggle = vi.fn();

        render(
            <FilesSidebar
                files={[...files]}
                rootLoading={false}
                selectedPath="/alpha.json"
                expandedPaths={new Set()}
                onSelect={onSelect}
                onToggle={onToggle}
            />
        );

        const names = screen
            .getAllByText(/^(src|alpha\.json|zeta\.md)$/u)
            .map((element) => element.textContent);
        expect(names).toEqual(["src", "alpha.json", "zeta.md"]);

        await user.click(screen.getByText("src"));
        await user.click(screen.getByText("alpha.json"));
        await user.click(screen.getByText("openclaw.json"));

        expect(onToggle).toHaveBeenCalledWith("/src");
        expect(onSelect).toHaveBeenNthCalledWith(1, "/alpha.json");
        expect(onSelect).toHaveBeenNthCalledWith(2, "config:openclaw.json");
    });
});
