import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FileNode } from "../../../types/file";
import { FileTreeItem } from "./FileTreeItem";

const tree: FileNode = {
    children: [
        { name: "README.md", path: "/repo/README.md", type: "file" },
        {
            children: [{ name: "index.ts", path: "/repo/src/index.ts", type: "file" }],
            loaded: true,
            name: "src",
            path: "/repo/src",
            type: "directory",
        },
        { name: "package.json", path: "/repo/package.json", type: "file" },
    ],
    loaded: true,
    name: "repo",
    path: "/repo",
    type: "directory",
};

describe("FileTreeItem", () => {
    it("toggles directories and selects files", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const onToggle = vi.fn();

        render(
            <FileTreeItem
                node={tree}
                selectedPath="/repo/package.json"
                expandedPaths={new Set(["/repo", "/repo/src"])}
                onSelect={onSelect}
                onToggle={onToggle}
            />
        );

        await user.click(screen.getByText("repo"));
        await user.click(screen.getByText("package.json"));

        expect(onToggle).toHaveBeenCalledWith("/repo");
        expect(onSelect).toHaveBeenCalledWith("/repo/package.json");
        expect(screen.getByText("TS")).toBeInTheDocument();
        expect(screen.getByText("MD")).toBeInTheDocument();
        expect(screen.getAllByText("{ }")).toHaveLength(1);
    });

    it("sorts directories before files and shows loading directories", () => {
        const loadingDirectory: FileNode = {
            loaded: false,
            name: "loading",
            path: "/loading",
            type: "directory",
        };

        const { rerender } = render(
            <FileTreeItem
                node={tree}
                selectedPath={null}
                expandedPaths={new Set(["/repo"])}
                onSelect={vi.fn()}
                onToggle={vi.fn()}
            />
        );

        const names = screen
            .getAllByText(/^(repo|src|README\.md|package\.json)$/u)
            .map((element) => element.textContent);
        expect(names).toEqual(["repo", "src", "package.json", "README.md"]);

        rerender(
            <FileTreeItem
                node={loadingDirectory}
                selectedPath={null}
                expandedPaths={new Set(["/loading"])}
                onSelect={vi.fn()}
                onToggle={vi.fn()}
            />
        );

        expect(screen.getByText("loading")).toBeInTheDocument();
    });
});
