import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    type FeedRow,
    findFeedRowIndex,
    getFeedRowsSignature,
    getFeedViewportAnchor,
    mergeLiveFeedItems,
    restoreFeedViewportOffset,
    Sessions,
    trimLiveFeedItems,
} from "./Sessions";

const mocks = vi.hoisted(() => ({
    compact: vi.fn(),
    feedItemFromSocketEvent: vi.fn(),
    liveFeed: [] as Array<{
        content?: string;
        id: string;
        role: string;
        sessionLabel?: string;
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
    subscribe: vi.fn(),
    useLiveFeed: vi.fn(),
    useOpenClawSocket: vi.fn(),
    useSessionActions: vi.fn(),
}));

vi.mock("@tanstack/react-db", () => ({
    useLiveQuery: (select: (query: { from: () => typeof mocks.sessions }) => unknown) => {
        const data = select({ from: () => mocks.sessions });
        return { data };
    },
}));

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({
        count,
        estimateSize,
        getItemKey,
        getScrollElement,
        measureElement,
    }: {
        count: number;
        estimateSize: (index: number) => number;
        getItemKey: (index: number) => string;
        getScrollElement: () => Element | null;
        measureElement: (element: Element) => number;
    }) => {
        if (count > 0) {
            getItemKey(0);
            estimateSize(0);
        }
        if (count > 1) {
            getItemKey(1);
            estimateSize(1);
        }
        getScrollElement();
        measureElement({ getBoundingClientRect: () => ({ height: 123 }) } as Element);
        return {
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
        };
    },
}));

vi.mock("../collections/sessions", () => ({
    sessionsCollection: {},
}));

vi.mock("../hooks", () => ({
    feedItemFromSocketEvent: mocks.feedItemFromSocketEvent,
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
    LiveFeedRow: ({ item }: { item: { content?: string; text: string } }) => (
        <article data-testid="feed-row">{item.content || item.text}</article>
    ),
    SESSION_TYPES: ["ALL", "DIRECT", "CHANNEL"],
    SessionsTable: ({
        onCompact,
        onDelete,
        onReset,
        sessions,
    }: {
        onCompact: (key: string) => void;
        onDelete: (session: { key: string }) => void;
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

/** Resets mocked session, feed, socket, and action hook state for one test case. */
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
            content: "assistant message",
            id: "feed-1",
            role: "assistant",
            sessionLabel: "Main session",
            sessionKey: "main",
            sessionType: "direct",
            text: "assistant message",
            timestamp: Date.parse("2026-05-11T00:00:00.000Z"),
        },
        {
            content: "user message",
            id: "feed-2",
            role: "user",
            sessionLabel: "Channel session",
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
        subscribe: mocks.subscribe,
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
        mocks.feedItemFromSocketEvent.mockReset();
        mocks.remove.mockResolvedValue(Promise.resolve());
        mocks.reset.mockReset();
        mocks.scrollToIndex.mockReset();
        mocks.subscribe.mockReset();
        mocks.subscribe.mockReturnValue(() => {});
        mocks.useLiveFeed.mockReset();
        mocks.useOpenClawSocket.mockReset();
        mocks.useSessionActions.mockReset();
        mockSessions();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("handles feed anchor helper edge cases", () => {
        const rows: FeedRow[] = [
            { kind: "separator", key: "sep", label: "Now" },
            { kind: "message", key: "message", item: mocks.liveFeed[0] as never },
        ];
        const container = document.createElement("div");
        Object.defineProperty(container, "scrollTop", {
            configurable: true,
            value: 75,
            writable: true,
        });

        expect(getFeedViewportAnchor(null, rows, [])).toBeNull();
        expect(
            getFeedViewportAnchor(container, rows, [{ end: 10, index: 0, start: 0 }])
        ).toBeNull();
        expect(
            getFeedViewportAnchor(container, rows, [{ end: 80, index: 1, start: 50 }])
        ).toEqual({ key: "message", offset: 25 });
        expect(findFeedRowIndex(rows, "message")).toBe(1);
        expect(findFeedRowIndex(rows, "missing")).toBe(-1);
        expect(
            restoreFeedViewportOffset(null, { key: "message", offset: 10 })
        ).toBeNull();
        expect(restoreFeedViewportOffset(container, { key: "message", offset: 10 })).toBe(
            85
        );
    });

    it("trims retained live feed items to the sticky history limit", () => {
        const items = Array.from({ length: 501 }, (_, index) => ({
            content: `message ${index}`,
            id: `feed-${index}`,
            role: "assistant",
            sessionKey: "main",
            sessionLabel: "Main",
            sessionType: "direct",
            timestamp: index,
        }));

        expect(trimLiveFeedItems(items)).toHaveLength(500);
        expect(trimLiveFeedItems(items)[0]?.id).toBe("feed-1");
        expect(trimLiveFeedItems(items.slice(0, 2))).toHaveLength(2);
    });

    it("merges updated live feed rows with stable ids", () => {
        const previous = [
            {
                content: "memory_search",
                id: "main-0",
                role: "tool",
                sessionKey: "main",
                sessionLabel: "Main",
                sessionType: "DIRECT",
                timestamp: 1,
            },
        ];
        const updated = [{ ...previous[0], content: "exec gh pr checks 54" }];

        expect(mergeLiveFeedItems(previous, previous)).toEqual({
            changed: false,
            items: previous,
        });
        expect(mergeLiveFeedItems(previous, updated)).toEqual({
            changed: true,
            items: updated,
        });
    });

    it("tracks feed row changes when retained row count is unchanged", () => {
        const firstRows: FeedRow[] = [
            {
                kind: "message",
                key: "main-0",
                item: {
                    content: "memory_search",
                    id: "main-0",
                    role: "tool",
                    sessionKey: "main",
                    sessionLabel: "Main",
                    sessionType: "DIRECT",
                    timestamp: 1,
                },
            },
        ];
        const firstMessage = firstRows[0] as Extract<FeedRow, { kind: "message" }>;
        const secondRows: FeedRow[] = [
            {
                kind: "message",
                key: firstMessage.key,
                item: {
                    ...firstMessage.item,
                    content: "exec gh pr checks 54",
                },
            },
        ];

        expect(getFeedRowsSignature(secondRows)).not.toBe(
            getFeedRowsSignature(firstRows)
        );
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

        await user.selectOptions(selects[1], "DIRECT");
        expect(screen.getByText("No live messages yet.")).toBeInTheDocument();
        await user.selectOptions(selects[2], "channel-1");
        expect(screen.queryByText("assistant message")).not.toBeInTheDocument();
        expect(screen.getByText("No live messages yet.")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "CHANNEL" }));
        expect(screen.getByTestId("sessions-table")).toHaveTextContent("sessions: 1");
    });

    it("counts system and tool roles in the live feed filter", () => {
        mockSessions({
            feed: [
                {
                    id: "system-event",
                    role: "system",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "system message",
                    timestamp: Date.parse("2026-05-11T00:00:00.000Z"),
                },
                {
                    id: "tool-call",
                    role: "tool",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "tool call",
                    timestamp: Date.parse("2026-05-11T00:01:00.000Z"),
                },
                {
                    id: "tool-result",
                    role: "tool_result",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "tool result",
                    timestamp: Date.parse("2026-05-11T00:02:00.000Z"),
                },
            ],
        });

        render(<Sessions />);

        expect(screen.getByRole("option", { name: "system (1)" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "tool (1)" })).toBeInTheDocument();
        expect(
            screen.getByRole("option", { name: "tool_result (1)" })
        ).toBeInTheDocument();
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

    it("handles empty data, live feed scrolling, and delete guard branches", async () => {
        const user = userEvent.setup();
        mockSessions({
            feed: [],
            sessions: [
                {
                    displayName: "Display name only",
                    key: "name-only",
                    lastActivityAt: "2026-05-09T00:00:00.000Z",
                },
            ],
        });
        const { rerender } = render(<Sessions />);
        expect(screen.getByText("No live messages yet.")).toBeInTheDocument();
        expect(screen.getByText("All sessions")).toBeInTheDocument();

        mockSessions({ sessions: null });
        rerender(<Sessions />);
        expect(screen.getByTestId("sessions-table")).toHaveTextContent("sessions: 0");

        mockSessions({
            actions: {
                compact: mocks.compact,
                isDeleting: true,
                remove: mocks.remove,
                reset: mocks.reset,
            },
        });
        rerender(<Sessions />);
        await user.click(screen.getByRole("button", { name: "Delete main" }));
        await user.click(screen.getByRole("button", { name: "Cancel delete" }));
        expect(screen.queryByTestId("confirm-modal")).not.toBeInTheDocument();

        mocks.remove.mockClear();
        await user.click(screen.getByRole("button", { name: "Delete main" }));
        await user.click(screen.getByRole("button", { name: "Confirm delete" }));
        expect(mocks.remove).not.toHaveBeenCalled();

        mockSessions();
        rerender(<Sessions />);
        const feedContainer = screen
            .getByText("assistant message")
            .closest("div[style]") as HTMLDivElement;
        Object.defineProperties(feedContainer, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 300 },
            scrollTop: { configurable: true, value: 0, writable: true },
        });
        fireEvent.scroll(feedContainer);
        expect(
            await screen.findByRole("button", { name: "↓ Follow" })
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "↓ Follow" }));
        expect(mocks.scrollToIndex).toHaveBeenCalled();
    });

    it("preserves the visible feed anchor when rows are backfilled while unpinned", async () => {
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            callback(0);
            return 1;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
        mockSessions({
            feed: [
                {
                    id: "anchor",
                    role: "assistant",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "anchor message",
                    timestamp: Date.parse("2026-05-11T00:01:00.000Z"),
                },
            ],
        });
        const { rerender } = render(<Sessions />);
        const feedContainer = screen
            .getByText("anchor message")
            .closest("div[style]") as HTMLDivElement;
        Object.defineProperties(feedContainer, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 400 },
            scrollTop: { configurable: true, value: 150, writable: true },
        });
        fireEvent.scroll(feedContainer);
        mocks.scrollToIndex.mockClear();

        mockSessions({
            feed: [
                {
                    id: "backfill",
                    role: "user",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "backfilled message",
                    timestamp: Date.parse("2026-05-11T00:00:00.000Z"),
                },
                {
                    id: "anchor",
                    role: "assistant",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "anchor message",
                    timestamp: Date.parse("2026-05-11T00:01:00.000Z"),
                },
            ],
        });
        rerender(<Sessions />);

        await waitFor(() =>
            expect(mocks.scrollToIndex).toHaveBeenCalledWith(expect.any(Number), {
                align: "start",
            })
        );
        expect(screen.getByText("backfilled message")).toBeInTheDocument();
        expect(feedContainer.scrollTop).toBe(200);
    });

    it("restores the anchor when capped feed updates keep row count unchanged", async () => {
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            callback(0);
            return 1;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
        const firstFeed = Array.from({ length: 500 }, (_, index) => ({
            content: index === 499 ? "anchor message" : `message ${index}`,
            id: `feed-${index}`,
            role: "assistant",
            sessionLabel: "Main session",
            sessionKey: "main",
            sessionType: "direct",
            text: index === 499 ? "anchor message" : `message ${index}`,
            timestamp: Date.parse("2026-05-11T00:00:00.000Z") + index,
        }));
        mockSessions({ feed: firstFeed });
        const { rerender } = render(<Sessions />);
        const feedContainer = screen
            .getByText("anchor message")
            .closest("div[style]") as HTMLDivElement;
        Object.defineProperties(feedContainer, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 20_000 },
            scrollTop: { configurable: true, value: 250, writable: true },
        });
        fireEvent.scroll(feedContainer);
        mocks.scrollToIndex.mockClear();

        mockSessions({
            feed: [
                ...firstFeed,
                {
                    content: "new capped message",
                    id: "feed-500",
                    role: "assistant",
                    sessionLabel: "Main session",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "new capped message",
                    timestamp: Date.parse("2026-05-11T00:00:00.000Z") + 500,
                },
            ],
        });
        rerender(<Sessions />);

        await waitFor(() =>
            expect(mocks.scrollToIndex).toHaveBeenCalledWith(expect.any(Number), {
                align: "start",
            })
        );
        expect(screen.getByText("new capped message")).toBeInTheDocument();
        expect(feedContainer.scrollTop).toBe(300);
    });

    it("updates retained live feed rows when streamed content changes in place", () => {
        mockSessions({
            feed: [
                {
                    content: "memory_search",
                    id: "active-row",
                    role: "tool",
                    sessionLabel: "Main session",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "memory_search",
                    timestamp: Date.parse("2026-05-11T00:01:00.000Z"),
                },
            ],
        });
        const { rerender } = render(<Sessions />);
        expect(screen.getByText("memory_search")).toBeInTheDocument();

        mockSessions({
            feed: [
                {
                    content: "exec gh pr checks 54",
                    id: "active-row",
                    role: "tool",
                    sessionLabel: "Main session",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "exec gh pr checks 54",
                    timestamp: Date.parse("2026-05-11T00:01:00.000Z"),
                },
            ],
        });
        rerender(<Sessions />);

        expect(screen.getByText("exec gh pr checks 54")).toBeInTheDocument();
        expect(screen.queryByText("memory_search")).not.toBeInTheDocument();
    });

    it("appends live runtime websocket events without waiting for history polling", async () => {
        let socketListener: ((data: unknown) => void) | undefined;
        mocks.subscribe.mockImplementation((listener: (data: unknown) => void) => {
            socketListener = listener;
            return () => {};
        });
        mocks.feedItemFromSocketEvent.mockReturnValue({
            content: "Exec: gh pr checks 54",
            id: "main-live-tool-1",
            role: "tool",
            sessionLabel: "Main session",
            sessionKey: "main",
            sessionType: "DIRECT",
            text: "Exec: gh pr checks 54",
            timestamp: Date.parse("2026-05-11T00:02:00.000Z"),
        });

        render(<Sessions />);
        act(() => {
            socketListener?.({
                event: "session.tool",
                payload: { sessionKey: "main" },
                type: "event",
            });
        });

        expect(await screen.findByText("Exec: gh pr checks 54")).toBeInTheDocument();
        expect(mocks.feedItemFromSocketEvent).toHaveBeenCalledWith(
            expect.objectContaining({ event: "session.tool" }),
            expect.any(Array)
        );
    });

    it("leaves an unpinned feed alone when no visible anchor can be captured", () => {
        mockSessions({
            feed: [
                {
                    id: "anchor",
                    role: "assistant",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "anchor message",
                    timestamp: Date.parse("2026-05-11T00:01:00.000Z"),
                },
            ],
        });
        const { rerender } = render(<Sessions />);
        const feedContainer = screen
            .getByText("anchor message")
            .closest("div[style]") as HTMLDivElement;
        Object.defineProperties(feedContainer, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 20_000 },
            scrollTop: { configurable: true, value: 10_000, writable: true },
        });
        fireEvent.scroll(feedContainer);
        mocks.scrollToIndex.mockClear();

        mockSessions({
            feed: [
                {
                    id: "backfill",
                    role: "user",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "backfilled message",
                    timestamp: Date.parse("2026-05-11T00:00:00.000Z"),
                },
                {
                    id: "anchor",
                    role: "assistant",
                    sessionKey: "main",
                    sessionType: "direct",
                    text: "anchor message",
                    timestamp: Date.parse("2026-05-11T00:01:00.000Z"),
                },
            ],
        });
        rerender(<Sessions />);

        expect(screen.getByText("backfilled message")).toBeInTheDocument();
        expect(mocks.scrollToIndex).not.toHaveBeenCalled();
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
});
