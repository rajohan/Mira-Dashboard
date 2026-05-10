import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Session } from "../../../types/session";
import { SessionsTable } from "./SessionsTable";

const sessions: Session[] = [
    {
        agentType: "main",
        channel: "webchat",
        createdAt: "2026-05-10T09:00:00.000Z",
        displayLabel: "Main",
        displayName: "Main session",
        hookName: "",
        id: "main",
        key: "agent:main:main",
        kind: "direct",
        label: "main",
        maxTokens: 100_000,
        model: "codex",
        tokenCount: 25_000,
        type: "main",
        updatedAt: Date.now() - 60_000,
    },
    {
        agentType: "subagent",
        channel: "cron",
        createdAt: "2026-05-10T08:00:00.000Z",
        displayLabel: "Research helper",
        displayName: "Research helper",
        hookName: "",
        id: "research",
        key: "agent:research:main",
        kind: "direct",
        label: "research",
        maxTokens: 200_000,
        model: "kimi",
        tokenCount: 10_000,
        type: "subagent",
        updatedAt: Date.now() - 120_000,
    },
];

function renderTable(overrides = {}) {
    const handlers = {
        onCompact: vi.fn(),
        onDelete: vi.fn(),
        onReset: vi.fn(),
        onSelectSession: vi.fn(),
    };

    render(<SessionsTable sessions={sessions} {...handlers} {...overrides} />);
    return handlers;
}

describe("SessionsTable", () => {
    it("renders empty state", () => {
        renderTable({ sessions: [] });

        expect(screen.getByText("No sessions found")).toBeInTheDocument();
    });

    it("renders sessions and selects rows", async () => {
        const user = userEvent.setup();
        const handlers = renderTable();

        expect(screen.getAllByText("Main").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Research helper").length).toBeGreaterThan(0);
        expect(screen.getAllByText("codex").length).toBeGreaterThan(0);
        expect(screen.getAllByText("25.0k / 100k").length).toBeGreaterThan(0);

        await user.click(screen.getAllByText("Main")[0]);

        expect(handlers.onSelectSession).toHaveBeenCalledWith(sessions[0]);
    });

    it("invokes compact, reset, and delete actions without selecting the row", async () => {
        const user = userEvent.setup();
        const handlers = renderTable();

        const actionButtons = () =>
            screen
                .getAllByRole("button")
                .filter((button) => button.getAttribute("aria-haspopup") === "menu");

        await user.click(actionButtons()[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Compact" }));
        await user.click(actionButtons()[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Reset" }));
        await user.click(actionButtons()[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

        expect(handlers.onCompact).toHaveBeenCalledWith("agent:main:main");
        expect(handlers.onReset).toHaveBeenCalledWith("agent:main:main");
        expect(handlers.onDelete).toHaveBeenCalledWith(sessions[0]);
        expect(handlers.onSelectSession).not.toHaveBeenCalled();
    });
});
