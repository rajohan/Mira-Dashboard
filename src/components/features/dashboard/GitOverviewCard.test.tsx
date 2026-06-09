import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GitOverviewCard } from "./GitOverviewCard";

const hooks = vi.hoisted(() => ({
    useCacheEntry: vi.fn(),
}));

vi.mock("../../../hooks/useCache", () => ({
    useCacheEntry: hooks.useCacheEntry,
}));

describe("GitOverviewCard", () => {
    it("renders loading and unavailable states", () => {
        hooks.useCacheEntry.mockReturnValueOnce({ isLoading: true });
        const { rerender } = render(<GitOverviewCard />);

        expect(screen.getByText("Loading git cache…")).toBeInTheDocument();

        hooks.useCacheEntry.mockReturnValueOnce({ isError: true });
        rerender(<GitOverviewCard />);

        expect(screen.getByText("Git cache unavailable.")).toBeInTheDocument();
    });

    it("shows green dirty repo count when every repo is clean", () => {
        hooks.useCacheEntry.mockReturnValue({
            data: {
                data: {
                    checkedAt: "2026-05-10T10:00:00.000Z",
                    dirtyRepos: [],
                    repos: [],
                },
            },
            isError: false,
            isLoading: false,
        });

        render(<GitOverviewCard />);

        const dirtyRepoRow = screen.getByText("Dirty repos").parentElement!;
        expect(within(dirtyRepoRow).getByText("0")).toHaveClass("text-green-300");
    });

    it("summarizes tracked git repos and dirty status", () => {
        hooks.useCacheEntry.mockReturnValue({
            data: {
                data: {
                    repos: [
                        {
                            key: "workspace",
                            name: "Mira Workspace",
                            branch: "main",
                            remote: null,
                            dirty: false,
                            statusSummary: {
                                staged: 0,
                                modified: 0,
                                deleted: 0,
                                untracked: 0,
                                renamed: 0,
                                conflicted: 0,
                                total: 0,
                            },
                        },
                        {
                            key: "dashboard",
                            name: "Mira Dashboard",
                            branch: null,
                            remote: null,
                            dirty: true,
                            statusSummary: {
                                staged: 0,
                                modified: 2,
                                deleted: 0,
                                untracked: 1,
                                renamed: 0,
                                conflicted: 0,
                                total: 3,
                            },
                        },
                        {
                            key: "n8n",
                            name: "n8n",
                            branch: "main",
                            remote: null,
                            dirty: true,
                            statusSummary: {
                                staged: 0,
                                modified: 1,
                                deleted: 0,
                                untracked: 0,
                                renamed: 0,
                                conflicted: 0,
                                total: 1,
                            },
                        },
                    ],
                    dirtyRepos: ["dashboard", "n8n"],
                    dirtyCount: 2,
                    missingRepos: [],
                    checkedAt: "2026-05-10T10:00:00.000Z",
                },
            },
            isError: false,
            isLoading: false,
        });

        const { container } = render(<GitOverviewCard />);

        expect(screen.getByText("Git workspace")).toBeInTheDocument();
        expect(screen.getByText("Mira Workspace")).toBeInTheDocument();
        expect(screen.getByText("Mira Dashboard")).toBeInTheDocument();
        expect(screen.getByText("Clean")).toBeInTheDocument();
        expect(screen.getAllByText("Dirty")).toHaveLength(2);
        expect(container).toHaveTextContent("main · no changes");
        expect(container).toHaveTextContent("unknown branch · 3 changes");
        expect(container).toHaveTextContent("main · 1 change");
    });

    it("flags clean repos that are checked out away from main", () => {
        hooks.useCacheEntry.mockReturnValue({
            data: {
                data: {
                    repos: [
                        {
                            key: "dashboard",
                            name: "Mira Dashboard",
                            branch: "feature-branch",
                            remote: null,
                            dirty: false,
                            statusSummary: {
                                staged: 0,
                                modified: 0,
                                deleted: 0,
                                untracked: 0,
                                renamed: 0,
                                conflicted: 0,
                                total: 0,
                            },
                        },
                    ],
                    dirtyRepos: [],
                    dirtyCount: 0,
                    missingRepos: [],
                    checkedAt: "2026-05-16T08:00:00.000Z",
                },
            },
            isError: false,
            isLoading: false,
        });

        const { container } = render(<GitOverviewCard />);

        const offMainRow = screen.getByText("Repos off main").parentElement!;
        expect(within(offMainRow).getByText("1")).toHaveClass("text-yellow-300");
        expect(screen.getByText("Off main")).toBeInTheDocument();
        expect(screen.getByText("Clean")).toBeInTheDocument();
        expect(container).toHaveTextContent("feature-branch · no changes");
    });

    it("treats missing repo status summaries as no changes", () => {
        hooks.useCacheEntry.mockReturnValue({
            data: {
                data: {
                    repos: [
                        {
                            key: "workspace",
                            name: "Mira Workspace",
                            branch: null,
                            remote: null,
                            dirty: true,
                        },
                    ],
                    dirtyRepos: ["workspace"],
                    dirtyCount: 1,
                    missingRepos: [],
                    checkedAt: "2026-06-10T00:00:00.000Z",
                },
            },
            isError: false,
            isLoading: false,
        });

        const { container } = render(<GitOverviewCard />);

        expect(screen.getByText("Mira Workspace")).toBeInTheDocument();
        expect(container).toHaveTextContent("unknown branch · no changes");
    });
});
