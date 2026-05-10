import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatRow } from "../components/features/chat/chatTypes";
import { Chat } from "./Chat";

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    subscribe: vi.fn(),
    slashCommand: vi.fn(),
    socketError: null as string | null,
    isConnected: true,
    liveSessions: [
        {
            key: "session-a",
            displayLabel: "Main chat",
            label: "main",
            model: "codex",
            type: "direct",
            updatedAt: "2026-05-11T00:00:00.000Z",
        },
        {
            key: "session-b",
            displayLabel: "Side chat",
            label: "side",
            model: "kimi",
            type: "channel",
            updatedAt: "2026-05-10T23:00:00.000Z",
        },
    ],
    agentsStatus: {
        agents: [
            {
                id: "mira",
                currentTask: "Testing chat",
                sessionKey: "agent:main:main",
                status: "online",
            },
        ],
    },
}));

vi.mock("@tanstack/react-db", () => ({
    useLiveQuery: () => ({ data: mocks.liveSessions }),
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
        measureElement: vi.fn(),
    }),
}));

vi.mock("../collections/sessions", () => ({
    sessionsCollection: {},
}));

vi.mock("../hooks/useAgents", () => ({
    useAgentsStatus: () => ({ data: mocks.agentsStatus }),
}));

vi.mock("../hooks/useOpenClawSocket", () => ({
    useOpenClawSocket: () => ({
        error: mocks.socketError,
        isConnected: mocks.isConnected,
        request: mocks.request,
        subscribe: mocks.subscribe,
    }),
}));

vi.mock("../components/features/chat/useChatRuntimeEvents", () => ({
    useChatRuntimeEvents: vi.fn(),
}));

vi.mock("../components/features/chat/useChatSlashCommands", () => ({
    useChatSlashCommands: () => mocks.slashCommand,
}));

vi.mock("../components/features/chat/AttachmentPreviewModal", () => ({
    AttachmentPreviewModal: ({
        previewItem,
        onClose,
    }: {
        previewItem: { title: string } | null;
        onClose: () => void;
    }) =>
        previewItem ? (
            <div role="dialog" aria-label="attachment preview">
                <span>{previewItem.title}</span>
                <button type="button" onClick={onClose}>
                    close preview
                </button>
            </div>
        ) : null,
}));

vi.mock("../components/features/chat/ChatHeader", () => ({
    ChatHeader: ({
        agentOptions,
        onSelectSession,
        onToggleThinking,
        onToggleTools,
        selectedSessionKey,
        sessionOptions,
        showThinking,
        showTools,
    }: {
        agentOptions: Array<{ label: string; value: string }>;
        onSelectSession: (sessionKey: string) => void;
        onToggleThinking: () => void;
        onToggleTools: () => void;
        selectedSessionKey: string;
        sessionOptions: Array<{ label: string; value: string }>;
        showThinking: boolean;
        showTools: boolean;
    }) => (
        <header>
            <div data-testid="selected-session">{selectedSessionKey || "none"}</div>
            <div data-testid="session-options">
                {sessionOptions.map((option) => option.label).join(",")}
            </div>
            <div data-testid="agent-options">
                {agentOptions.map((option) => option.label).join(",")}
            </div>
            <button type="button" onClick={() => onSelectSession("session-b")}>
                select side chat
            </button>
            <button type="button" onClick={onToggleThinking}>
                thinking {String(showThinking)}
            </button>
            <button type="button" onClick={onToggleTools}>
                tools {String(showTools)}
            </button>
        </header>
    ),
}));

vi.mock("../components/features/chat/ChatMessagesList", () => ({
    ChatMessagesList: ({
        chatRows,
        isLoadingHistory,
        onDeleteMessage,
        onPreview,
        visibility,
    }: {
        chatRows: ChatRow[];
        isLoadingHistory: boolean;
        onDeleteMessage: (messageKey: string) => void;
        onPreview: (preview: { title: string; kind: "text" }) => void;
        visibility: { showThinking: boolean; showTools: boolean };
    }) => (
        <section aria-label="chat messages">
            <div data-testid="loading-history">{String(isLoadingHistory)}</div>
            <div data-testid="visibility">
                {String(visibility.showThinking)}:{String(visibility.showTools)}
            </div>
            {chatRows.map((row) => (
                <article key={row.key}>
                    <span>{row.kind}</span>
                    <span>{row.message.text}</span>
                    {row.message.role === "user" ? (
                        <button type="button" onClick={() => onDeleteMessage(row.key)}>
                            delete {row.key}
                        </button>
                    ) : null}
                </article>
            ))}
            <button
                type="button"
                onClick={() => onPreview({ kind: "text", title: "preview.txt" })}
            >
                preview attachment
            </button>
        </section>
    ),
}));

vi.mock("../components/features/chat/ChatComposer", () => ({
    ChatComposer: ({
        canSend,
        draft,
        isConnected,
        onChangeDraft,
        onSend,
    }: {
        canSend: boolean;
        draft: string;
        isConnected: boolean;
        onChangeDraft: (draft: string) => void;
        onSend: () => void;
    }) => (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                onSend();
            }}
        >
            <div data-testid="composer-state">
                {String(isConnected)}:{String(canSend)}
            </div>
            <label>
                Draft
                <textarea
                    value={draft}
                    onChange={(event) => onChangeDraft(event.target.value)}
                />
            </label>
            <button type="submit" disabled={!canSend}>
                send
            </button>
        </form>
    ),
}));

vi.mock("../components/ui/ConfirmModal", () => ({
    ConfirmModal: ({
        isOpen,
        onCancel,
        onConfirm,
        title,
    }: {
        isOpen: boolean;
        onCancel: () => void;
        onConfirm: () => void;
        title: string;
    }) =>
        isOpen ? (
            <div role="dialog" aria-label={title}>
                <button type="button" onClick={onCancel}>
                    cancel delete
                </button>
                <button type="button" onClick={onConfirm}>
                    confirm delete
                </button>
            </div>
        ) : null,
}));

function installLocalStorageMock() {
    const store = new Map<string, string>();

    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            clear: vi.fn(() => store.clear()),
            getItem: vi.fn((key: string) => store.get(key) ?? null),
            removeItem: vi.fn((key: string) => store.delete(key)),
            setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        },
    });
}

function setupRequest() {
    mocks.request.mockImplementation(async (method: string) => {
        if (method === "models.list") {
            return { models: [{ id: "codex", label: "Codex" }] };
        }

        if (method === "chat.history") {
            return {
                messages: [
                    {
                        content: "old user message",
                        role: "user",
                        text: "old user message",
                        timestamp: "2026-05-11T00:00:00.000Z",
                    },
                    {
                        content: "old assistant message",
                        role: "assistant",
                        text: "old assistant message",
                        timestamp: "2026-05-11T00:01:00.000Z",
                    },
                ],
            };
        }

        if (method === "chat.send") {
            return { runId: "run-123" };
        }

        return {};
    });
}

describe("Chat", () => {
    beforeEach(() => {
        installLocalStorageMock();
        mocks.isConnected = true;
        mocks.socketError = null;
        mocks.slashCommand.mockResolvedValue(false);
        mocks.subscribe.mockReturnValue(vi.fn());
        mocks.request.mockReset();
        setupRequest();
    });

    it("loads sessions, models, history, and toggles diagnostic visibility", async () => {
        const user = userEvent.setup();

        render(<Chat />);

        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent("session-a")
        );
        expect(screen.getByTestId("session-options")).toHaveTextContent("Main chat");
        expect(screen.getByTestId("agent-options")).toHaveTextContent("mira");
        expect(await screen.findByText("old assistant message")).toBeInTheDocument();
        expect(mocks.request).toHaveBeenCalledWith("models.list", {
            view: "configured",
        });
        expect(mocks.request).toHaveBeenCalledWith("chat.history", {
            limit: 1000,
            sessionKey: "session-a",
        });

        await user.click(screen.getByRole("button", { name: "thinking false" }));
        await user.click(screen.getByRole("button", { name: "tools false" }));
        expect(screen.getByTestId("visibility")).toHaveTextContent("true:true");
    });

    it("sends chat text and renders optimistic/user stream rows", async () => {
        const user = userEvent.setup();

        render(<Chat />);
        await screen.findByText("old user message");

        await user.type(screen.getByLabelText("Draft"), "Hello from test");
        expect(screen.getByTestId("composer-state")).toHaveTextContent("true:true");
        await user.click(screen.getByRole("button", { name: "send" }));

        await waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith(
                "chat.send",
                expect.objectContaining({
                    deliver: false,
                    message: "Hello from test",
                    sessionKey: "session-a",
                })
            )
        );
        expect(screen.getByText("Hello from test")).toBeInTheDocument();
        expect(screen.getByText("Thinking")).toBeInTheDocument();
    });

    it("persists deleted message keys and can open attachment previews", async () => {
        const user = userEvent.setup();

        render(<Chat />);
        await screen.findByText("old user message");

        await user.click(
            screen.getByRole("button", {
                name: /delete user::2026-05-11T00:00:00.000Z.*old user message/,
            })
        );
        await user.click(screen.getByRole("button", { name: "confirm delete" }));
        expect(screen.queryByText("old user message")).not.toBeInTheDocument();
        expect(window.localStorage.getItem("openclaw:deleted:session-a")).toContain(
            "old user message"
        );

        await user.click(screen.getByRole("button", { name: "preview attachment" }));
        expect(
            screen.getByRole("dialog", { name: "attachment preview" })
        ).toHaveTextContent("preview.txt");
        await user.click(screen.getByRole("button", { name: "close preview" }));
        expect(
            screen.queryByRole("dialog", { name: "attachment preview" })
        ).not.toBeInTheDocument();
    });

    it("surfaces socket and send failures", async () => {
        const user = userEvent.setup();
        mocks.socketError = "Gateway disconnected";
        mocks.request.mockImplementation(async (method: string) => {
            if (method === "chat.send") {
                throw new Error("send failed");
            }

            return method === "chat.history" ? { messages: [] } : { models: [] };
        });

        render(<Chat />);

        expect(await screen.findByText("Gateway disconnected")).toBeInTheDocument();
        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent("session-a")
        );
        await user.type(screen.getByLabelText("Draft"), "Will fail");
        await user.click(screen.getByRole("button", { name: "send" }));

        expect(await screen.findByText("send failed")).toBeInTheDocument();
    });
});
