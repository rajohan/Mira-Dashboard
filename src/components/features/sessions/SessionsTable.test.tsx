import { render, screen, within } from "@testing-library/react";
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

/** Renders the sessions table with default action spies and optional props. */
function renderTable(overrides = {}) {
    const handlers = {
        onCompact: vi.fn(),
        onDelete: vi.fn(),
        onReset: vi.fn(),
    };

    render(<SessionsTable sessions={sessions} {...handlers} {...overrides} />);
    return handlers;
}

/** Returns the rendered action menu trigger buttons. */
function getActionMenuButtons() {
    return screen
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-haspopup") === "menu");
}

describe("SessionsTable", () => {
    it("renders empty state", () => {
        renderTable({ sessions: [] });

        expect(screen.getByText("No sessions found")).toBeInTheDocument();
    });

    it("renders sessions", () => {
        renderTable();

        expect(screen.getAllByText("Main").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Research helper").length).toBeGreaterThan(0);
        expect(screen.getAllByText("codex").length).toBeGreaterThan(0);
        expect(screen.getAllByText("25.0k / 100k").length).toBeGreaterThan(0);
    });

    it("invokes compact, reset, and delete actions", async () => {
        const user = userEvent.setup();
        const handlers = renderTable();

        await user.click(getActionMenuButtons()[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Compact" }));
        await user.click(getActionMenuButtons()[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Reset" }));
        await user.click(getActionMenuButtons()[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

        expect(handlers.onCompact).toHaveBeenCalledWith("agent:main:main");
        expect(handlers.onReset).toHaveBeenCalledWith("agent:main:main");
        expect(handlers.onDelete).toHaveBeenCalledWith(sessions[0]);
    });

    it("sorts and handles desktop table row/actions", async () => {
        const user = userEvent.setup();
        const handlers = renderTable();
        const table = screen.getByRole("table");

        await user.click(within(table).getByRole("columnheader", { name: /Type/u }));

        const tableActionButton = within(table)
            .getAllByRole("button")
            .find((button) => button.getAttribute("aria-haspopup") === "menu")!;
        await user.click(tableActionButton);
        await user.click(await screen.findByRole("menuitem", { name: "Compact" }));

        expect(handlers.onCompact).toHaveBeenCalled();
    });

    it("handles fallback labels", () => {
        const fallbackSession: Session = {
            ...sessions[0],
            displayLabel: "",
            displayName: "",
            id: "fallback-id",
            key: "fallback-key",
            label: "",
            maxTokens: 0,
            model: "",
            tokenCount: 0,
            updatedAt: null,
        };
        renderTable({ sessions: [fallbackSession] });

        expect(screen.getAllByText("fallback-id").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
        expect(screen.getAllByText("0.0k / 200k").length).toBeGreaterThan(0);
    });

    it("treats non-array session data as empty", () => {
        renderTable({ sessions: null as unknown as Session[] });

        expect(screen.getByText("No sessions found")).toBeInTheDocument();
    });
});
