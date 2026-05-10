import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CacheStatusCard } from "./CacheStatusCard";

const hooks = vi.hoisted(() => ({
    useCacheHeartbeat: vi.fn(),
    useRefreshCacheEntry: vi.fn(),
}));

vi.mock("../../../hooks", () => ({
    useCacheHeartbeat: hooks.useCacheHeartbeat,
    useRefreshCacheEntry: hooks.useRefreshCacheEntry,
}));

describe("CacheStatusCard", () => {
    it("renders cache entries and refreshes grouped keys", async () => {
        const mutate = vi.fn();
        hooks.useCacheHeartbeat.mockReturnValue({
            data: {
                entries: [
                    {
                        key: "system.host",
                        status: "fresh",
                        updatedAt: "2026-05-10T10:00:00.000Z",
                    },
                    {
                        key: "git.workspace",
                        status: "error",
                        errorMessage: "git failed",
                        updatedAt: null,
                    },
                ],
            },
        });
        hooks.useRefreshCacheEntry.mockReturnValue({
            isPending: false,
            mutate,
            variables: undefined,
        });

        render(
            <CacheStatusCard
                title="System cache"
                items={[
                    {
                        key: "system.host",
                        label: "Host",
                        description: "Host snapshot",
                        refreshKeys: ["system.host", "system.openclaw"],
                    },
                    { key: "git.workspace", label: "Git" },
                    { key: "missing.entry", label: "Missing" },
                ]}
            />
        );

        expect(screen.getByText("System cache")).toBeInTheDocument();
        expect(screen.getByText("Host snapshot")).toBeInTheDocument();
        expect(screen.getByText("fresh")).toBeInTheDocument();
        expect(screen.getByText("error")).toBeInTheDocument();
        expect(screen.getByText("git failed")).toBeInTheDocument();
        expect(screen.getByText("missing")).toBeInTheDocument();

        await userEvent.click(
            screen.getAllByRole("button", { name: /Force update/u })[0]
        );

        expect(mutate).toHaveBeenCalledWith("system.host,system.openclaw");
    });

    it("disables the matching refresh button while refreshing", () => {
        hooks.useCacheHeartbeat.mockReturnValue({
            data: { entries: [{ key: "system.host", status: "stale" }] },
        });
        hooks.useRefreshCacheEntry.mockReturnValue({
            isPending: true,
            mutate: vi.fn(),
            variables: "system.host",
        });

        render(
            <CacheStatusCard
                title="System cache"
                items={[{ key: "system.host", label: "Host" }]}
            />
        );

        expect(screen.getByRole("button", { name: /Force update/u })).toBeDisabled();
        expect(screen.getByText("stale")).toBeInTheDocument();
    });
});
