import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Sessions } from "./Sessions";

const mocks = vi.hoisted(() => ({
    compact: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
    sessions: [] as Array<{
        displayLabel?: string;
        displayName?: string;
        key: string;
        lastActivityAt?: string;
        type?: string;
    }> | null,
    useOpenClawSocket: vi.fn(),
    useSessionActions: vi.fn(),
}));

vi.mock("@tanstack/react-db", () => ({
    useLiveQuery: (select: (query: { from: () => typeof mocks.sessions }) => unknown) => {
        const data = select({ from: () => mocks.sessions });
        return { data };
    },
}));

vi.mock("../collections/sessions", () => ({
    sessionsCollection: {},
}));

vi.mock("../hooks/useOpenClawSocket", () => ({
    useOpenClawSocket: mocks.useOpenClawSocket,
}));

vi.mock("../hooks/useSessionActions", () => ({
    useSessionActions: mocks.useSessionActions,
}));

vi.mock("../components/ui/ConfirmModal", () => ({
    ConfirmModal: ({
        isOpen,
        message,
        onCancel,
        onConfirm,
        title,
    }: {
        isOpen: boolean;
        message: string;
        onCancel: () => void;
        onConfirm: () => void;
        title: string;
    }) =>
        isOpen ? (
            <section data-testid="confirm-modal">
                <h2>{title}</h2>
                <p>{message}</p>
                <button type="button" onClick={onCancel}>
                    Cancel delete
                </button>
                <button type="button" onClick={onConfirm}>
                    Confirm delete
                </button>
            </section>
        ) : null,
}));

vi.mock("../components/features/sessions", () => ({
    SESSION_TYPES: ["ALL", "DIRECT", "CHANNEL"],
    SessionsTable: ({
        onCompact,
        onDelete,
        onReset,
        sessions,
    }: {
        onCompact: (key: string) => void;
        onDelete: (session: { displayLabel?: string; key: string }) => void;
        onReset: (key: string) => void;
        sessions: Array<{ displayLabel?: string; key: string }>;
    }) => (
        <section data-testid="sessions-table">
            sessions: {sessions.length}
            {sessions.map((session) => (
                <div key={session.key}>
                    <button type="button" onClick={() => onCompact(session.key)}>
                        Compact {session.key}
                    </button>
                    <button type="button" onClick={() => onReset(session.key)}>
                        Reset {session.key}
                    </button>
                    <button type="button" onClick={() => onDelete(session)}>
                        Delete {session.key}
                    </button>
                </div>
            ))}
        </section>
    ),
}));

/** Resets mocked session, socket, and action hook state for one test case. */
function mockSessions(
    overrides: {
        actions?: unknown;
        sessions?: typeof mocks.sessions;
        socket?: unknown;
    } = {}
) {
    mocks.sessions = [
        {
            displayLabel: "Main session",
            key: "main",
            lastActivityAt: "2026-05-11T00:00:00.000Z",
            type: "direct",
        },
        {
            displayLabel: "Channel session",
            key: "channel-1",
            lastActivityAt: "2026-05-10T23:00:00.000Z",
            type: "channel",
        },
    ];
    mocks.useOpenClawSocket.mockReturnValue({
        error: null,
        isConnected: true,
    });
    mocks.useSessionActions.mockReturnValue({
        compact: mocks.compact,
        isDeleting: false,
        remove: mocks.remove,
        reset: mocks.reset,
    });

    if ("sessions" in overrides) {
        mocks.sessions = overrides.sessions ?? null;
    }
    if (overrides.socket) {
        mocks.useOpenClawSocket.mockReturnValue(overrides.socket);
    }
    if (overrides.actions) {
        mocks.useSessionActions.mockReturnValue(overrides.actions);
    }
}

describe("Sessions page", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        mocks.compact.mockReset();
        mocks.remove.mockResolvedValue(Promise.resolve());
        mocks.reset.mockReset();
        mocks.useOpenClawSocket.mockReset();
        mocks.useSessionActions.mockReset();
        mockSessions();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders connected sessions without the removed live feed", () => {
        render(<Sessions />);

        expect(screen.getByTestId("sessions-table")).toHaveTextContent("sessions: 2");
        expect(screen.queryByText("Live Feed (cross-session)")).not.toBeInTheDocument();
        expect(screen.queryByText("No live messages yet.")).not.toBeInTheDocument();
    });

    it("filters sessions by type", async () => {
        const user = userEvent.setup();

        render(<Sessions />);

        await user.click(screen.getByRole("button", { name: "CHANNEL" }));

        expect(screen.getByTestId("sessions-table")).toHaveTextContent("sessions: 1");
    });

    it("shows connecting and socket error states", () => {
        const { rerender } = render(<Sessions />);

        mockSessions({ socket: { error: null, isConnected: false } });
        rerender(<Sessions />);
        expect(screen.getByText("Connecting to OpenClaw...")).toBeInTheDocument();

        mockSessions({ socket: { error: "Socket failed", isConnected: false } });
        rerender(<Sessions />);
        expect(screen.getByText("Socket failed")).toBeInTheDocument();
    });

    it("handles empty collection data", () => {
        mockSessions({
            sessions: null,
        });

        render(<Sessions />);

        expect(screen.getByTestId("sessions-table")).toHaveTextContent("sessions: 0");
    });

    it("runs table actions and delete confirmation", async () => {
        const user = userEvent.setup();

        render(<Sessions />);

        await user.click(screen.getByRole("button", { name: "Compact main" }));
        await user.click(screen.getByRole("button", { name: "Reset main" }));
        expect(mocks.compact).toHaveBeenCalledWith("main");
        expect(mocks.reset).toHaveBeenCalledWith("main");

        await user.click(screen.getByRole("button", { name: "Delete main" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("Main session");
        await user.click(screen.getByRole("button", { name: "Confirm delete" }));
        expect(mocks.remove).toHaveBeenCalledWith("main");
    });

    it("guards delete while already deleting", async () => {
        const user = userEvent.setup();
        mockSessions({
            actions: {
                compact: mocks.compact,
                isDeleting: true,
                remove: mocks.remove,
                reset: mocks.reset,
            },
        });

        render(<Sessions />);

        await user.click(screen.getByRole("button", { name: "Delete main" }));
        mocks.remove.mockClear();
        await user.click(screen.getByRole("button", { name: "Confirm delete" }));

        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it("shows delete errors from failed session removal", async () => {
        const user = userEvent.setup();
        mocks.remove.mockRejectedValueOnce(new Error("Delete failed"));

        const { rerender } = render(<Sessions />);

        await user.click(screen.getByRole("button", { name: "Delete main" }));
        await user.click(screen.getByRole("button", { name: "Confirm delete" }));
        expect(await screen.findByText("Delete failed")).toBeInTheDocument();

        mockSessions({
            sessions: [
                {
                    key: "raw-key",
                    lastActivityAt: "2026-05-09T00:00:00.000Z",
                    type: "direct",
                },
            ],
        });
        mocks.remove.mockRejectedValueOnce("string delete failure");
        rerender(<Sessions />);
        await user.click(screen.getByRole("button", { name: "Delete raw-key" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("raw-key");
        await user.click(screen.getByRole("button", { name: "Confirm delete" }));
        expect(await screen.findByText("Failed to delete session")).toBeInTheDocument();
    });

    it("cancels delete confirmation", async () => {
        const user = userEvent.setup();

        render(<Sessions />);

        await user.click(screen.getByRole("button", { name: "Delete main" }));
        await user.click(screen.getByRole("button", { name: "Cancel delete" }));

        expect(screen.queryByTestId("confirm-modal")).not.toBeInTheDocument();
    });
});
