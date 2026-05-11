import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Sessions } from "./Sessions";

const mocks = vi.hoisted(() => ({
    compact: vi.fn(),
    liveFeed: [] as Array<{
        id: string;
        role: string;
        sessionKey: string;
        sessionType: string;
        text: string;
        timestamp: number;
    }>,
    measureElement: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
    scrollToIndex: vi.fn(),
    sessions: [] as Array<{
        displayLabel?: string;
        displayName?: string;
        key: string;
        lastActivityAt?: string;
        type?: string;
    }>,
    useLiveFeed: vi.fn(),
    useOpenClawSocket: vi.fn(),
    useSessionActions: vi.fn(),
}));

vi.mock("@tanstack/react-db", () => ({
    useLiveQuery: () => ({ data: mocks.sessions }),
}));

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 100,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                end: (index + 1) * 100,
                index,
                key: `row-${index}`,
                start: index * 100,
            })),
        measureElement: mocks.measureElement,
        scrollToIndex: mocks.scrollToIndex,
    }),
}));

vi.mock("../collections/sessions", () => ({
    sessionsCollection: {},
}));

vi.mock("../hooks", () => ({
    useLiveFeed: mocks.useLiveFeed,
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

vi.mock("../components/ui/Select", () => ({
    Select: ({
        onChange,
        options,
        value,
    }: {
        onChange: (value: string) => void;
        options: Array<{ label: string; value: string }>;
        value: string;
    }) => (
        <select
            aria-label="select"
            value={value}
            onChange={(event) => onChange(event.target.value)}
        >
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    ),
}));

vi.mock("../components/features/sessions", () => ({
    LiveFeedRow: ({ item }: { item: { text: string } }) => (
        <article data-testid="feed-row">{item.text}</article>
    ),
    SESSION_TYPES: ["ALL", "DIRECT", "CHANNEL"],
    SessionDetails: ({
        onClose,
        onCompact,
        onDelete,
        onReset,
        session,
    }: {
        onClose: () => void;
        onCompact: () => void;
        onDelete: () => void;
        onReset: () => void;
        session: { key: string } | null;
    }) =>
        session ? (
            <section data-testid="session-details">
                details: {session.key}
                <button type="button" onClick={onClose}>
                    Close details
                </button>
                <button type="button" onClick={onCompact}>
                    Compact selected
                </button>
                <button type="button" onClick={onReset}>
                    Reset selected
                </button>
                <button type="button" onClick={onDelete}>
                    Delete selected
                </button>
            </section>
        ) : null,
    SessionsTable: ({
        onCompact,
        onDelete,
        onReset,
        onSelectSession,
        sessions,
    }: {
        onCompact: (key: string) => void;
        onDelete: (session: { key: string }) => void;
        onReset: (key: string) => void;
        onSelectSession: (session: { key: string }) => void;
        sessions: Array<{ displayLabel?: string; key: string }>;
    }) => (
        <section data-testid="sessions-table">
            sessions: {sessions.length}
            {sessions.map((session) => (
                <div key={session.key}>
                    <button type="button" onClick={() => onSelectSession(session)}>
                        Select {session.displayLabel || session.key}
                    </button>
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

function mockSessions(overrides = {}) {
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
    mocks.liveFeed = [
        {
            id: "feed-1",
            role: "assistant",
            sessionKey: "main",
            sessionType: "direct",
            text: "assistant message",
            timestamp: Date.parse("2026-05-11T00:00:00.000Z"),
        },
        {
            id: "feed-2",
            role: "user",
            sessionKey: "channel-1",
            sessionType: "channel",
            text: "user message",
            timestamp: Date.parse("2026-05-11T00:01:00.000Z"),
        },
    ];
    mocks.useLiveFeed.mockReturnValue({ data: mocks.liveFeed });
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

    for (const [key, value] of Object.entries(overrides)) {
        if (key === "sessions") mocks.sessions = value as typeof mocks.sessions;
        if (key === "feed") {
            mocks.liveFeed = value as typeof mocks.liveFeed;
            mocks.useLiveFeed.mockReturnValue({ data: mocks.liveFeed });
        }
        if (key === "socket") mocks.useOpenClawSocket.mockReturnValue(value);
        if (key === "actions") mocks.useSessionActions.mockReturnValue(value);
    }
}

describe("Sessions page", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        mocks.compact.mockReset();
        mocks.measureElement.mockReset();
        mocks.remove.mockResolvedValue(Promise.resolve());
        mocks.reset.mockReset();
        mocks.scrollToIndex.mockReset();
        mocks.useLiveFeed.mockReset();
        mocks.useOpenClawSocket.mockReset();
        mocks.useSessionActions.mockReset();
        mockSessions();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders live feed and connected sessions", async () => {
        render(<Sessions />);

        expect(await screen.findByText("assistant message")).toBeInTheDocument();
        expect(screen.getByText("user message")).toBeInTheDocument();
        expect(screen.getByTestId("sessions-table")).toHaveTextContent("sessions: 2");
    });

    it("filters live feed and session type", async () => {
        const user = userEvent.setup();

        render(<Sessions />);

        const selects = screen.getAllByLabelText("select");
        await user.selectOptions(selects[0], "assistant");
        expect(screen.getByText("assistant message")).toBeInTheDocument();
        expect(screen.queryByText("user message")).not.toBeInTheDocument();

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

    it("runs table and detail actions, including delete confirmation", async () => {
        const user = userEvent.setup();

        render(<Sessions />);

        await user.click(screen.getByRole("button", { name: "Compact main" }));
        await user.click(screen.getByRole("button", { name: "Reset main" }));
        expect(mocks.compact).toHaveBeenCalledWith("main");
        expect(mocks.reset).toHaveBeenCalledWith("main");

        await user.click(screen.getByRole("button", { name: "Select Main session" }));
        expect(screen.getByTestId("session-details")).toHaveTextContent("details: main");

        await user.click(screen.getByRole("button", { name: "Compact selected" }));
        expect(mocks.compact).toHaveBeenCalledWith("main");

        await user.click(screen.getByRole("button", { name: "Select Main session" }));
        await user.click(screen.getByRole("button", { name: "Delete selected" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("Main session");
        await user.click(screen.getByRole("button", { name: "Confirm delete" }));
        expect(mocks.remove).toHaveBeenCalledWith("main");
    });

    it("shows delete errors from failed session removal", async () => {
        const user = userEvent.setup();
        mocks.remove.mockRejectedValueOnce(new Error("Delete failed"));

        render(<Sessions />);

        await user.click(screen.getByRole("button", { name: "Delete main" }));
        await user.click(screen.getByRole("button", { name: "Confirm delete" }));
        expect(await screen.findByText("Delete failed")).toBeInTheDocument();
    });
});
