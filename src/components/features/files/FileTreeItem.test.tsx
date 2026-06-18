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

        await user.click(screen.getByRole("button", { name: "repo" }));
        await user.click(screen.getByRole("button", { name: "package.json" }));

        expect(onToggle).toHaveBeenCalledWith("/repo");
        expect(onSelect).toHaveBeenCalledWith("/repo/package.json");
        expect(screen.getByRole("button", { name: "repo" })).toHaveAttribute(
            "aria-expanded",
            "true"
        );
        expect(screen.getByRole("button", { name: "package.json" })).toHaveAttribute(
            "aria-current",
            "true"
        );
        expect(screen.getByText("TS")).toBeInTheDocument();
        expect(screen.getByText("MD")).toBeInTheDocument();
        expect(screen.getAllByText("{ }")).toHaveLength(1);
    });

    it("supports keyboard activation for tree rows", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const onToggle = vi.fn();

        render(
            <FileTreeItem
                node={tree}
                selectedPath={undefined}
                expandedPaths={new Set(["/repo"])}
                onSelect={onSelect}
                onToggle={onToggle}
            />
        );

        await user.tab();
        expect(screen.getByRole("button", { name: "repo" })).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(onToggle).toHaveBeenCalledWith("/repo");

        await user.tab();
        expect(screen.getByRole("button", { name: "src" })).toHaveFocus();
        await user.keyboard(" ");
        expect(onToggle).toHaveBeenCalledWith("/repo/src");

        await user.tab();
        expect(screen.getByRole("button", { name: "package.json" })).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(onSelect).toHaveBeenCalledWith("/repo/package.json");
    });

    it("uses the generic file icon for unknown file extensions", () => {
        render(
            <FileTreeItem
                node={{ name: "archive.bin", path: "/repo/archive.bin", type: "file" }}
                selectedPath={undefined}
                expandedPaths={new Set()}
                onSelect={vi.fn()}
                onToggle={vi.fn()}
            />
        );

        expect(screen.getByText("archive.bin")).toBeInTheDocument();
        expect(screen.queryByText("BIN")).not.toBeInTheDocument();
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
                selectedPath={undefined}
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
                selectedPath={undefined}
                expandedPaths={new Set(["/loading"])}
                onSelect={vi.fn()}
                onToggle={vi.fn()}
            />
        );

        expect(screen.getByText("loading")).toBeInTheDocument();
    });

    it("does not mutate child order while rendering sorted entries", () => {
        const childOrder = ["zeta.txt", "src", "alpha.txt"];
        const node: FileNode = {
            children: [
                { name: childOrder[0], path: "/repo/zeta.txt", type: "file" },
                { name: childOrder[1], path: "/repo/src", type: "directory" },
                { name: childOrder[2], path: "/repo/alpha.txt", type: "file" },
            ],
            loaded: true,
            name: "repo",
            path: "/repo",
            type: "directory",
        };

        render(
            <FileTreeItem
                node={node}
                selectedPath={undefined}
                expandedPaths={new Set(["/repo"])}
                onSelect={vi.fn()}
                onToggle={vi.fn()}
            />
        );

        const renderedNames = screen
            .getAllByText(/^(repo|src|alpha\.txt|zeta\.txt)$/u)
            .map((element) => element.textContent);
        expect(renderedNames).toEqual(["repo", "src", "alpha.txt", "zeta.txt"]);
        expect(node.children?.map((child) => child.name)).toEqual(childOrder);
    });

    it("does not sort hidden children while collapsed", () => {
        const sortSpy = vi.spyOn(Array.prototype, "sort");

        try {
            render(
                <FileTreeItem
                    node={tree}
                    selectedPath={undefined}
                    expandedPaths={new Set()}
                    onSelect={vi.fn()}
                    onToggle={vi.fn()}
                />
            );

            expect(screen.getByText("repo")).toBeInTheDocument();
            expect(screen.queryByText("src")).not.toBeInTheDocument();
            expect(sortSpy).not.toHaveBeenCalled();
        } finally {
            sortSpy.mockRestore();
        }
    });
});
