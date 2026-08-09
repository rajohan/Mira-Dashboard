import { describe, expect, mock, test } from "bun:test";

import type {
    TerminalRuntime,
    TerminalSessionSummary,
} from "../../contracts/terminal.ts";
import { TerminalWorkspace, type TerminalWorkspaceProps } from "./TerminalWorkspace.tsx";

const { fireEvent, render, screen, within } = await import("@testing-library/react");

const runtime: TerminalRuntime = {
    clientMessageMaximumBytes: 16 * 1024,
    defaultLocation: { path: "/", rootId: "dashboard" },
    idleTimeoutMs: 10 * 60 * 1000,
    mode: "pty",
    outputReplayMaximumBytes: 256 * 1024,
    reconnectGraceMs: 15 * 1000,
    roots: [
        { defaultPath: "/", id: "dashboard", label: "Dashboard project" },
        { defaultPath: "/", id: "workspace", label: "Mira workspace" },
    ],
    serverMessageMaximumBytes: 32 * 1024,
    sessionMaximumDurationMs: 30 * 60 * 1000,
    supportsInput: true,
    supportsPty: true,
    supportsResize: true,
    supportsSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
    webSocketProtocol: "mira-terminal-v1",
};
const session: TerminalSessionSummary = Object.freeze({
    dimensions: { columns: 100, rows: 30 },
    expiresAtMs: 1_800_001_800_000,
    idleExpiresAtMs: 1_800_000_600_000,
    location: { path: "/", rootId: "dashboard" },
    nextSequence: 4,
    sessionId: "019fe7a8-03fe-7000-8ea2-874b1ea1b40e",
    startedAtMs: 1_800_000_000_000,
    state: "connected",
});

function renderWorkspace(overrides: Partial<TerminalWorkspaceProps> = {}) {
    const handlers = {
        onClear: mock(() => {}),
        onCopySelection: mock(() => {}),
        onEnd: mock(() => {}),
        onFocus: mock(() => {}),
        onLocation: mock(() => {}),
        onRefreshSession: mock(() => {}),
        onResume: mock(() => {}),
        onSearch: mock(() => {}),
        onSendInterrupt: mock(() => {}),
        onStart: mock(() => {}),
    };
    render(
        <TerminalWorkspace
            announcement="Terminal is ready to start."
            canvas={<div data-testid="terminal-canvas" />}
            dimensions={{ columns: 80, rows: 24 }}
            location={runtime.defaultLocation}
            phase="idle"
            runtime={runtime}
            terminalReady
            {...handlers}
            {...overrides}
        />
    );
    return handlers;
}

describe("interactive terminal workspace", () => {
    test("starts only from a canonical reviewed location", () => {
        const handlers = renderWorkspace();
        fireEvent.click(screen.getByRole("button", { name: "Start terminal" }));
        expect(handlers.onStart).toHaveBeenCalledTimes(1);

        fireEvent.change(
            screen.getByRole("textbox", {
                name: "Terminal starting folder or subfolder",
            }),
            { target: { value: "/../private" } }
        );
        expect(handlers.onLocation).toHaveBeenCalledWith({
            path: "/../private",
            rootId: "dashboard",
        });
    });

    test("exposes keyboard, search, copy, clear, and focus controls without React terminal content", () => {
        const handlers = renderWorkspace({ phase: "connected", session });
        const search = screen.getByRole("searchbox", {
            name: "Search terminal output",
        });
        fireEvent.change(search, { target: { value: "worker" } });
        fireEvent.keyDown(search, { key: "Enter" });
        fireEvent.click(screen.getByRole("button", { name: "Send Ctrl+C" }));
        fireEvent.click(screen.getByRole("button", { name: "Copy terminal selection" }));
        fireEvent.click(screen.getByRole("button", { name: "Focus terminal" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Clear local terminal buffer" })
        );

        expect(handlers.onSearch).toHaveBeenCalledWith("worker", "next");
        expect(handlers.onSendInterrupt).toHaveBeenCalledTimes(1);
        expect(handlers.onCopySelection).toHaveBeenCalledTimes(1);
        expect(handlers.onFocus).toHaveBeenCalledTimes(1);
        expect(handlers.onClear).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("terminal-canvas")).toBeTruthy();
    });

    test("requires explicit confirmation before ending the worker PTY", () => {
        const handlers = renderWorkspace({ phase: "connected", session });
        fireEvent.click(screen.getByRole("button", { name: "End terminal" }));
        const dialog = screen.getByRole("dialog", {
            name: "End interactive terminal?",
        });
        expect(handlers.onEnd).not.toHaveBeenCalled();
        fireEvent.click(within(dialog).getByRole("button", { name: "End terminal" }));
        expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    });

    test("announces replay resynchronization and only offers resume during grace", () => {
        const reconnectingSession = {
            ...session,
            state: "awaiting-reconnect" as const,
        };
        const handlers = renderWorkspace({
            announcement:
                "Some earlier output is no longer available. Showing the newest output.",
            phase: "active-elsewhere",
            replayGap: true,
            session: reconnectingSession,
        });

        expect(
            screen.getByText(
                "Some earlier output is no longer available. Showing the newest terminal output."
            )
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Resume terminal" }));
        expect(handlers.onResume).toHaveBeenCalledTimes(1);
        expect(
            screen.getByText(
                "Some earlier output is no longer available. Showing the newest output."
            )
        ).toBeTruthy();
    });
});
