import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ServiceActionsCard } from "./ServiceActionsCard";

const hooks = vi.hoisted(() => ({
    actions: [
        {
            id: "system_restart",
            label: "Restart system",
            description: "Reboot server immediately",
            command: "sudo reboot",
            confirmLabel: "Restart system",
            confirmMessage: "Reboot system now?",
            scope: "system",
            danger: true,
        },
        {
            id: "system_cleanup",
            label: "Cleanup system",
            description: "Clean unused packages",
            command: "cleanup",
            confirmLabel: "Run system cleanup",
            confirmMessage: "Run cleanup now?",
            scope: "system",
        },
        {
            id: "openclaw_update",
            label: "Update OpenClaw",
            description: "Update to latest OpenClaw version",
            command: "openclaw update --yes",
            confirmLabel: "Update OpenClaw",
            confirmMessage: "Update OpenClaw to latest version now?",
            scope: "openclaw",
        },
    ],
    refreshCache: vi.fn(),
    startAction: vi.fn(),
    useCacheEntry: vi.fn(),
    useExecJob: vi.fn(),
    useRefreshCacheEntry: vi.fn(),
    useStartOpsAction: vi.fn(),
}));

vi.mock("../../../hooks", () => ({
    OPS_ACTIONS: hooks.actions,
    useCacheEntry: hooks.useCacheEntry,
    useExecJob: hooks.useExecJob,
    useRefreshCacheEntry: hooks.useRefreshCacheEntry,
    useStartOpsAction: hooks.useStartOpsAction,
}));

function setupHooks() {
    hooks.startAction.mockReset();
    hooks.refreshCache.mockReset();
    hooks.refreshCache.mockResolvedValue({});
    hooks.useCacheEntry.mockReturnValue({
        data: {
            data: {
                version: {
                    current: "2026.5.4",
                    latest: "2026.5.5",
                    updateAvailable: true,
                },
            },
        },
    });
    hooks.useStartOpsAction.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.startAction,
    });
    hooks.useRefreshCacheEntry.mockReturnValue({ mutateAsync: hooks.refreshCache });
    hooks.useExecJob.mockReturnValue({ data: null });
}

describe("ServiceActionsCard", () => {
    it("renders action groups, version warning, and starts confirmed actions", async () => {
        setupHooks();
        const user = userEvent.setup();
        hooks.startAction.mockResolvedValue({ jobId: "job-cleanup" });

        render(<ServiceActionsCard />);

        expect(screen.getByText("Actions")).toBeInTheDocument();
        expect(screen.getByText("System Actions")).toBeInTheDocument();
        expect(screen.getByText("OpenClaw Actions")).toBeInTheDocument();
        expect(screen.getByText(/2026\.5\.4 → 2026\.5\.5/u)).toBeInTheDocument();
        expect(screen.getByText("Caution")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Cleanup system/u }));
        expect(screen.getByText("Run cleanup now?")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByText("Run cleanup now?")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Cleanup system/u }));
        await user.click(screen.getByRole("button", { name: "Run system cleanup" }));

        expect(hooks.startAction).toHaveBeenCalledWith(hooks.actions[1]);
    });

    it("keeps output visible while an action is running and tracks manual scroll state", async () => {
        setupHooks();
        hooks.startAction.mockResolvedValue({ jobId: "job-cleanup" });
        hooks.useExecJob.mockImplementation((jobId: string | null) => ({
            data: jobId
                ? {
                      code: null,
                      endedAt: null,
                      jobId,
                      startedAt: Date.UTC(2026, 4, 10, 18, 59, 0),
                      status: "running",
                      stderr: "stderr line",
                      stdout: "stdout line",
                  }
                : null,
        }));
        const user = userEvent.setup();

        render(<ServiceActionsCard />);

        await user.click(screen.getByRole("button", { name: /Cleanup system/u }));
        await user.click(screen.getByRole("button", { name: "Run system cleanup" }));

        expect(await screen.findByText(/Running: Cleanup system/u)).toBeInTheDocument();
        expect(screen.getByText(/stdout line/u)).toBeInTheDocument();
        expect(screen.getByText(/stderr line/u)).toBeInTheDocument();
        const output = screen.getByText(/stdout line/u);
        Object.defineProperties(output, {
            clientHeight: { configurable: true, value: 10 },
            scrollHeight: { configurable: true, value: 100 },
            scrollTop: { configurable: true, value: 10 },
        });
        fireEvent.scroll(output);
    });

    it("clears running state when starting an action fails", async () => {
        setupHooks();
        hooks.startAction.mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();

        render(<ServiceActionsCard />);

        await user.click(screen.getByRole("button", { name: /Cleanup system/u }));
        await user.click(screen.getByRole("button", { name: "Run system cleanup" }));

        await waitFor(() => expect(hooks.startAction).toHaveBeenCalled());
        expect(screen.queryByText(/Running: Cleanup system/u)).not.toBeInTheDocument();
    });

    it("shows completed action output and refreshes host cache after OpenClaw update", async () => {
        setupHooks();
        const user = userEvent.setup();
        hooks.startAction.mockResolvedValue({ jobId: "job-update" });
        hooks.useExecJob.mockImplementation((jobId: string | null) => ({
            data: jobId
                ? {
                      code: 0,
                      endedAt: Date.UTC(2026, 4, 10, 19, 0, 0),
                      jobId,
                      startedAt: Date.UTC(2026, 4, 10, 18, 59, 0),
                      status: "done",
                      stderr: "",
                      stdout: "updated successfully",
                  }
                : null,
        }));

        render(<ServiceActionsCard />);

        await user.click(screen.getByRole("button", { name: /Update OpenClaw/u }));
        await user.click(screen.getByRole("button", { name: "Update OpenClaw" }));

        await waitFor(() => {
            expect(screen.getByText("updated successfully")).toBeInTheDocument();
        });
        expect(screen.getByText(/Last run: Update OpenClaw/u)).toBeInTheDocument();
        expect(screen.getByText(/exit code 0/u)).toBeInTheDocument();
        expect(hooks.refreshCache).toHaveBeenCalledWith("system.host");
    });
});
