import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatRow } from "../components/features/chat/chatTypes";
import {
    Chat,
    historyHasNewerAssistantMessage,
    readDeletedMessageKeys,
    readStoredChatDiagnosticVisibility,
    sessionTimestampMs,
    supportedAudioRecordingMimeType,
    writeDeletedMessageKeys,
    writeStoredChatDiagnosticVisibility,
} from "./Chat";

interface MockLiveSession {
    agentType?: string;
    displayLabel: string;
    key: string;
    label: string;
    model: string;
    type: string;
    updatedAt: string;
}

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
    ] as MockLiveSession[],
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
    runtimeEventsOptions: null as {
        connectionId: number;
        isConnected: boolean;
        updateActiveStreams: (
            updater: (previous: Record<string, unknown>) => Record<string, unknown>
        ) => void;
    } | null,
}));

vi.mock("@tanstack/react-db", () => ({
    useLiveQuery: (
        buildQuery: (query: { from: (collection: unknown) => unknown }) => unknown
    ) => ({
        data: buildQuery({ from: vi.fn(() => mocks.liveSessions) }),
    }),
}));

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({
        count,
        estimateSize,
        getItemKey,
        getScrollElement,
    }: {
        count: number;
        estimateSize: (index: number) => number;
        getItemKey: (index: number) => string;
        getScrollElement: () => Element | null;
    }) => {
        getScrollElement();

        return {
            getTotalSize: () => count * 100,
            getVirtualItems: () =>
                Array.from({ length: count }, (_, index) => ({
                    end: (index + 1) * estimateSize(index),
                    index,
                    key: getItemKey(index),
                    start: index * estimateSize(index),
                })),
            measureElement: vi.fn(),
        };
    },
}));

vi.mock("../collections/sessions", () => ({
    sessionsCollection: {},
}));

vi.mock("../hooks/useAgents", () => ({
    useAgentsStatus: () => ({ data: mocks.agentsStatus }),
}));

vi.mock("../hooks/useOpenClawSocket", () => ({
    useOpenClawSocket: () => ({
        connectionId: 1,
        error: mocks.socketError,
        isConnected: mocks.isConnected,
        request: mocks.request,
        subscribe: mocks.subscribe,
    }),
}));

vi.mock("../components/features/chat/useChatRuntimeEvents", () => ({
    useChatRuntimeEvents: vi.fn(
        (options: {
            connectionId: number;
            isConnected: boolean;
            updateActiveStreams: (
                updater: (previous: Record<string, unknown>) => Record<string, unknown>
            ) => void;
        }) => {
            mocks.runtimeEventsOptions = options;
        }
    ),
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
        onSelectAgent,
        onSelectSession,
        onToggleThinking,
        onToggleTools,
        selectedSessionKey,
        sessionOptions,
        showThinking,
        showTools,
    }: {
        agentOptions: Array<{ label: string; value: string }>;
        onSelectAgent: (agentId: string) => void;
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
            <button type="button" onClick={() => onSelectSession("agent:main:scratch")}>
                select scratch chat
            </button>
            <button type="button" onClick={() => onSelectAgent("main")}>
                select main agent
            </button>
            <button type="button" onClick={() => onSelectAgent("ops")}>
                select ops agent
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
        isAtBottom,
        isLoadingHistory,
        messagesBottomReference,
        messagesContainerReference,
        onDeleteMessage,
        onDynamicContentLoad,
        onFollow,
        onPreview,
        onScroll,
        visibility,
    }: {
        chatRows: ChatRow[];
        isAtBottom: boolean;
        isLoadingHistory: boolean;
        messagesBottomReference: React.RefObject<HTMLDivElement | null>;
        messagesContainerReference: React.RefObject<HTMLDivElement | null>;
        onDeleteMessage: (messageKey: string) => void;
        onDynamicContentLoad: () => void;
        onFollow: () => void;
        onPreview: (preview: { title: string; kind: "text" }) => void;
        onScroll: () => void;
        visibility: { showThinking: boolean; showTools: boolean };
    }) => (
        <section
            ref={messagesContainerReference}
            aria-label="chat messages"
            onScroll={onScroll}
        >
            <div data-testid="loading-history">{String(isLoadingHistory)}</div>
            <div data-testid="bottom-state">{String(isAtBottom)}</div>
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
            <div ref={messagesBottomReference} data-testid="messages-bottom" />
            <button
                type="button"
                onClick={() => onPreview({ kind: "text", title: "preview.txt" })}
            >
                preview attachment
            </button>
            <button type="button" onClick={onDynamicContentLoad}>
                dynamic content loaded
            </button>
            <button type="button" onClick={onFollow}>
                follow bottom
            </button>
        </section>
    ),
}));

vi.mock("../components/features/chat/ChatComposer", () => ({
    ChatComposer: ({
        attachments,
        canSend,
        draft,
        isConnected,
        isRecording,
        isTranscribing,
        onApplySlashSuggestion,
        onAttachFiles,
        onChangeDraft,
        onRemoveAttachment,
        onSend,
        onToggleRecording,
        slashCommandSuggestions,
    }: {
        attachments: Array<{ id: string; fileName: string }>;
        canSend: boolean;
        draft: string;
        isConnected: boolean;
        isRecording: boolean;
        isTranscribing: boolean;
        onApplySlashSuggestion: (value: string) => void;
        onAttachFiles: (files: FileList | null) => void;
        onChangeDraft: (draft: string) => void;
        onRemoveAttachment: (id: string) => void;
        onSend: () => void;
        onToggleRecording: () => void;
        slashCommandSuggestions: Array<{ value: string }>;
    }) => (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                onSend();
            }}
        >
            <div data-testid="composer-state">
                {String(isConnected)}:{String(canSend)}:{String(isRecording)}:
                {String(isTranscribing)}
            </div>
            <label>
                Draft
                <textarea
                    value={draft}
                    onChange={(event) => onChangeDraft(event.target.value)}
                />
            </label>
            <label>
                Attach file
                <input
                    aria-label="Attach file"
                    type="file"
                    multiple
                    onChange={(event) => onAttachFiles(event.target.files)}
                />
            </label>
            {attachments.map((attachment) => (
                <button
                    key={attachment.id}
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                >
                    remove {attachment.fileName}
                </button>
            ))}
            {slashCommandSuggestions[0] ? (
                <button
                    type="button"
                    onClick={() =>
                        onApplySlashSuggestion(slashCommandSuggestions[0]!.value)
                    }
                >
                    apply first slash suggestion
                </button>
            ) : null}
            <button type="button" onClick={onToggleRecording}>
                toggle recording
            </button>
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

/** Installs an isolated localStorage mock for chat page tests. */
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

/** Configures the default OpenClaw request mock responses. */
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

describe("Chat helpers", () => {
    beforeEach(() => {
        installLocalStorageMock();
        Object.defineProperty(window, "MediaRecorder", {
            configurable: true,
            value: undefined,
        });
    });

    it("stores deleted message keys and tolerates invalid storage", () => {
        expect(readDeletedMessageKeys("")).toEqual(new Set());

        window.localStorage.setItem(
            "openclaw:deleted:session-a",
            JSON.stringify(["one", 2, "two"])
        );
        expect(readDeletedMessageKeys("session-a")).toEqual(new Set(["one", "two"]));

        window.localStorage.setItem("openclaw:deleted:session-a", "not json");
        expect(readDeletedMessageKeys("session-a")).toEqual(new Set());

        window.localStorage.setItem("openclaw:deleted:session-a", '{"one":true}');
        expect(readDeletedMessageKeys("session-a")).toEqual(new Set());

        writeDeletedMessageKeys("session-a", new Set(["three"]));
        expect(window.localStorage.getItem("openclaw:deleted:session-a")).toBe(
            '["three"]'
        );
        writeDeletedMessageKeys("", new Set(["ignored"]));
    });

    it("falls back when deleted-message storage is unavailable", () => {
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: {
                getItem: vi.fn(() => {
                    throw new Error("storage blocked");
                }),
                setItem: vi.fn(() => {
                    throw new Error("storage blocked");
                }),
            },
        });

        expect(readDeletedMessageKeys("session-a")).toEqual(new Set());
        expect(() =>
            writeDeletedMessageKeys("session-a", new Set(["hidden"]))
        ).not.toThrow();
    });

    it("reads and writes diagnostic visibility storage", () => {
        expect(readStoredChatDiagnosticVisibility()).toEqual({
            thinking: false,
            tools: false,
        });

        writeStoredChatDiagnosticVisibility({ thinking: true, tools: true });
        expect(readStoredChatDiagnosticVisibility()).toEqual({
            thinking: true,
            tools: true,
        });

        window.localStorage.setItem(
            "mira-dashboard-chat-diagnostic-visibility",
            JSON.stringify({ thinking: true, tools: "yes" })
        );
        expect(readStoredChatDiagnosticVisibility()).toEqual({
            thinking: true,
            tools: false,
        });

        window.localStorage.setItem(
            "mira-dashboard-chat-diagnostic-visibility",
            "not json"
        );
        expect(readStoredChatDiagnosticVisibility()).toEqual({
            thinking: false,
            tools: false,
        });
    });

    it("uses diagnostic visibility defaults when browser storage is unavailable", () => {
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: {
                getItem: vi.fn(() => {
                    throw new Error("storage blocked");
                }),
                setItem: vi.fn(() => {
                    throw new Error("storage blocked");
                }),
            },
        });

        expect(readStoredChatDiagnosticVisibility()).toEqual({
            thinking: false,
            tools: false,
        });
        expect(() =>
            writeStoredChatDiagnosticVisibility({ thinking: true, tools: true })
        ).not.toThrow();
    });

    it("uses helper defaults outside a browser window", () => {
        const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            "window"
        );

        try {
            const removed = Reflect.deleteProperty(globalThis, "window");
            expect(removed).toBe(true);

            expect(readDeletedMessageKeys("session-a")).toEqual(new Set());
            expect(readStoredChatDiagnosticVisibility()).toEqual({
                thinking: false,
                tools: false,
            });
        } finally {
            if (originalWindowDescriptor) {
                Object.defineProperty(globalThis, "window", originalWindowDescriptor);
            }
        }
    });

    it("normalizes timestamps and detects recovered assistant history", () => {
        expect(sessionTimestampMs(42)).toBe(42);
        expect(sessionTimestampMs(Number.NaN)).toBeNull();
        expect(sessionTimestampMs("2026-05-11T00:00:00.000Z")).toBe(
            Date.parse("2026-05-11T00:00:00.000Z")
        );
        expect(sessionTimestampMs("not-a-date")).toBeNull();
        expect(sessionTimestampMs({})).toBeNull();

        expect(historyHasNewerAssistantMessage([])).toBe(false);
        expect(
            historyHasNewerAssistantMessage(
                [
                    {
                        content: "hello",
                        role: "user",
                        text: "hello",
                        timestamp: "2026-05-11T00:01:00.000Z",
                    },
                    {
                        content: "",
                        role: "assistant",
                        text: "",
                        timestamp: "2026-05-11T00:02:00.000Z",
                    },
                    {
                        content: "done",
                        role: "assistant",
                        text: "done",
                        timestamp: "2026-05-11T00:03:00.000Z",
                    },
                ],
                "2026-05-11T00:02:30.000Z"
            )
        ).toBe(true);
        expect(
            historyHasNewerAssistantMessage(
                [
                    {
                        content: "old",
                        role: "assistant",
                        text: "old",
                        timestamp: "2026-05-11T00:01:00.000Z",
                    },
                ],
                "2026-05-11T00:02:30.000Z"
            )
        ).toBe(false);
    });

    it("selects the first supported recorder mime type", () => {
        expect(supportedAudioRecordingMimeType()).toBeUndefined();

        Object.defineProperty(window, "MediaRecorder", {
            configurable: true,
            value: {
                isTypeSupported: vi.fn((mimeType: string) => mimeType === "audio/mp4"),
            },
        });

        expect(supportedAudioRecordingMimeType()).toBe("audio/mp4");
    });

    it("returns undefined when no recorder mime types are supported", () => {
        Object.defineProperty(window, "MediaRecorder", {
            configurable: true,
            value: {
                isTypeSupported: vi.fn(() => false),
            },
        });

        expect(supportedAudioRecordingMimeType()).toBeUndefined();
    });
});

describe("Chat", () => {
    beforeEach(() => {
        installLocalStorageMock();
        mocks.isConnected = true;
        mocks.socketError = null;
        mocks.liveSessions = [
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
        ];
        mocks.agentsStatus = {
            agents: [
                {
                    id: "mira",
                    currentTask: "Testing chat",
                    sessionKey: "agent:main:main",
                    status: "online",
                },
            ],
        };
        mocks.slashCommand.mockResolvedValue(false);
        mocks.subscribe.mockReturnValue(vi.fn());
        mocks.request.mockReset();
        mocks.runtimeEventsOptions = null;
        setupRequest();
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: undefined,
        });
        Object.defineProperty(window, "MediaRecorder", {
            configurable: true,
            value: undefined,
        });
        Element.prototype.scrollIntoView = vi.fn();
        vi.stubGlobal("fetch", vi.fn());
    });

    it("loads sessions, models, history, and toggles diagnostic visibility", async () => {
        const user = userEvent.setup();

        render(<Chat />);

        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent("session-a")
        );
        expect(screen.getByTestId("session-options")).toHaveTextContent("Main chat");
        expect(screen.getByTestId("agent-options")).toHaveTextContent("direct");
        expect(screen.getByTestId("agent-options")).toHaveTextContent("channel");
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
        expect(mocks.runtimeEventsOptions).toEqual(
            expect.objectContaining({
                connectionId: 1,
                isConnected: true,
            })
        );
    });

    it("groups chat sessions by agent bucket and selects the first session in a bucket", async () => {
        const user = userEvent.setup();
        mocks.agentsStatus = {
            agents: [
                {
                    id: "main",
                    currentTask: "Main work",
                    sessionKey: "agent:main:scratch",
                    status: "online",
                },
                {
                    id: "ops",
                    currentTask: "Ops work",
                    sessionKey: "agent:Ops:main",
                    status: "online",
                },
            ],
        };
        mocks.liveSessions = [
            {
                key: "agent:Main:main",
                displayLabel: "Main chat",
                label: "main",
                model: "codex",
                type: "MAIN",
                updatedAt: "2026-05-11T00:00:00.000Z",
            },
            {
                key: "agent:main:scratch",
                displayLabel: "Scratch",
                label: "scratch",
                model: "codex",
                type: "MAIN",
                updatedAt: "2026-05-10T23:30:00.000Z",
            },
            {
                key: "agent:Ops:main",
                displayLabel: "Ops",
                label: "ops",
                model: "codex",
                type: "SUBAGENT",
                updatedAt: "2026-05-10T23:00:00.000Z",
            },
            {
                key: "",
                agentType: "",
                displayLabel: "Unknown",
                label: "unknown",
                model: "codex",
                type: "",
                updatedAt: "2026-05-10T22:00:00.000Z",
            },
        ];

        render(<Chat />);

        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent(
                "agent:Main:main"
            )
        );
        expect(screen.getByTestId("agent-options")).toHaveTextContent("main");
        expect(screen.getByTestId("agent-options")).not.toHaveTextContent("Main");
        expect(screen.getByTestId("agent-options")).toHaveTextContent("ops");
        expect(screen.getByTestId("agent-options")).toHaveTextContent("unknown");
        expect(screen.getByTestId("session-options")).toHaveTextContent("main");
        expect(screen.getByTestId("session-options")).toHaveTextContent("scratch");

        await user.click(screen.getByRole("button", { name: "select scratch chat" }));
        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent(
                "agent:main:scratch"
            )
        );
        await user.click(screen.getByRole("button", { name: "select main agent" }));
        expect(screen.getByTestId("selected-session")).toHaveTextContent(
            "agent:main:scratch"
        );

        await user.click(screen.getByRole("button", { name: "select ops agent" }));

        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent(
                "agent:Ops:main"
            )
        );
        expect(screen.getByTestId("session-options")).toHaveTextContent("main");
        expect(screen.getByTestId("session-options")).not.toHaveTextContent("scratch");
    });

    it("groups non-agent chat sessions by stable session metadata", async () => {
        mocks.liveSessions = [
            {
                key: "session-a",
                agentType: "direct",
                displayLabel: "Main chat",
                label: "main",
                model: "codex",
                type: "direct",
                updatedAt: "2026-05-11T00:00:00.000Z",
            },
            {
                key: "session-b",
                agentType: "DIRECT",
                displayLabel: "Side chat",
                label: "side",
                model: "kimi",
                type: "direct",
                updatedAt: "2026-05-10T23:00:00.000Z",
            },
        ];

        render(<Chat />);

        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent("session-a")
        );
        expect(screen.getByTestId("agent-options")).toHaveTextContent("direct");
        expect(screen.getByTestId("agent-options")).not.toHaveTextContent("session-a");
        expect(screen.getByTestId("session-options")).toHaveTextContent("Main chat");
        expect(screen.getByTestId("session-options")).toHaveTextContent("Side chat");
    });

    it("selects an agent-reported active session when switching buckets", async () => {
        const user = userEvent.setup();
        mocks.agentsStatus = {
            agents: [
                {
                    id: "ops",
                    currentTask: "Ops work",
                    sessionKey: "agent:ops:active",
                    status: "online",
                },
            ],
        };
        mocks.liveSessions = [
            {
                key: "agent:main:main",
                displayLabel: "Main",
                label: "main",
                model: "codex",
                type: "MAIN",
                updatedAt: "2026-05-11T00:00:00.000Z",
            },
            {
                key: "agent:ops:scratch",
                displayLabel: "Ops scratch",
                label: "scratch",
                model: "codex",
                type: "SUBAGENT",
                updatedAt: "2026-05-10T23:30:00.000Z",
            },
            {
                key: "agent:ops:active",
                displayLabel: "Ops active",
                label: "active",
                model: "codex",
                type: "SUBAGENT",
                updatedAt: "2026-05-10T23:00:00.000Z",
            },
        ];

        render(<Chat />);

        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent(
                "agent:main:main"
            )
        );

        await user.click(screen.getByRole("button", { name: "select ops agent" }));

        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent(
                "agent:ops:active"
            )
        );
    });

    it("handles sessions without a key while deriving chat buckets", async () => {
        mocks.liveSessions = [
            {
                key: undefined as unknown as string,
                agentType: "direct",
                displayLabel: "Missing key chat",
                label: "missing",
                model: "codex",
                type: "direct",
                updatedAt: "2026-05-11T00:00:00.000Z",
            },
        ];

        render(<Chat />);

        await waitFor(() =>
            expect(screen.getByTestId("agent-options")).toHaveTextContent("direct")
        );
        expect(screen.getByTestId("session-options")).toHaveTextContent(
            "Missing key chat"
        );
    });

    it("filters hidden tool result rows before message virtualization", async () => {
        mocks.request.mockImplementation(async (method: string) => {
            if (method === "models.list") {
                return { models: [{ id: "codex", label: "Codex" }] };
            }

            if (method === "chat.history") {
                return {
                    messages: [
                        {
                            content: "raw tool output",
                            role: "tool_result",
                            text: "raw tool output",
                            toolResult: { content: "formatted tool output" },
                        },
                        {
                            content: "visible assistant message",
                            role: "assistant",
                            text: "visible assistant message",
                        },
                    ],
                };
            }

            return {};
        });

        render(<Chat />);

        expect(await screen.findByText("visible assistant message")).toBeInTheDocument();
        expect(screen.queryByText("raw tool output")).not.toBeInTheDocument();
        expect(screen.queryByText("formatted tool output")).not.toBeInTheDocument();
    });

    it("sends chat text and renders optimistic/user stream rows", async () => {
        const user = userEvent.setup();

        render(<Chat />);
        await screen.findByText("old user message");

        await user.type(screen.getByLabelText("Draft"), "Hello from test");
        expect(screen.getByTestId("composer-state")).toHaveTextContent("true:true");
        await user.click(screen.getByRole("button", { name: "send" }));

        await waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith("sessions.patch", {
                key: "session-a",
                verboseLevel: "full",
            })
        );
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
        const verbosePatchCall = mocks.request.mock.calls.findIndex(
            ([method, params]) =>
                method === "sessions.patch" &&
                (params as { verboseLevel?: string })?.verboseLevel === "full"
        );
        const chatSendCall = mocks.request.mock.calls.findIndex(
            ([method]) => method === "chat.send"
        );
        expect(verbosePatchCall).toBeLessThan(chatSendCall);
        expect(screen.getByText("Hello from test")).toBeInTheDocument();
        expect(screen.getByText("Thinking")).toBeInTheDocument();
    });

    it("still sends chat text when enabling verbose diagnostics fails", async () => {
        const user = userEvent.setup();
        mocks.request.mockImplementation(async (method: string) => {
            if (method === "sessions.patch") {
                throw new Error("verbose unavailable");
            }

            if (method === "chat.send") {
                return { runId: "run-123" };
            }

            return method === "chat.history"
                ? { messages: [] }
                : { models: [{ id: "codex", label: "Codex" }] };
        });

        render(<Chat />);
        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent("session-a")
        );

        await user.type(screen.getByLabelText("Draft"), "Still send");
        await user.click(screen.getByRole("button", { name: "send" }));

        await waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith(
                "chat.send",
                expect.objectContaining({
                    message: "Still send",
                    sessionKey: "session-a",
                })
            )
        );
        expect(screen.queryByText("verbose unavailable")).not.toBeInTheDocument();
    });

    it("renders runtime stream rows and clears them when disconnected", async () => {
        const { rerender } = render(<Chat />);
        await screen.findByText("old user message");

        act(() => {
            mocks.runtimeEventsOptions?.updateActiveStreams((previous) => ({
                ...previous,
                "session-a": {
                    aliases: ["run-live"],
                    message: {
                        content: "streaming answer",
                        role: "assistant",
                        text: "streaming answer",
                    },
                    runId: "run-live",
                    sessionKey: "session-a",
                    statusText: "Using tools",
                    text: "streaming answer",
                    updatedAt: "2026-05-11T00:02:00.000Z",
                },
            }));
        });

        expect(await screen.findByText("streaming answer")).toBeInTheDocument();
        expect(screen.getByText("Using tools")).toBeInTheDocument();

        mocks.isConnected = false;
        rerender(<Chat />);

        await waitFor(() =>
            expect(screen.queryByText("streaming answer")).not.toBeInTheDocument()
        );
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

    it("attaches, removes, and sends files without draft text", async () => {
        const user = userEvent.setup();
        const file = new File(["hello"], "notes.txt", {
            type: "text/plain",
            lastModified: 123,
        });

        render(<Chat />);
        await screen.findByText("old user message");

        await user.upload(screen.getByLabelText("Attach file"), file);
        expect(
            await screen.findByRole("button", { name: "remove notes.txt" })
        ).toBeInTheDocument();
        expect(screen.getByTestId("composer-state")).toHaveTextContent("true:true");

        await user.click(screen.getByRole("button", { name: "remove notes.txt" }));
        expect(
            screen.queryByRole("button", { name: "remove notes.txt" })
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("composer-state")).toHaveTextContent("true:false");

        const secondFile = new File(["hello"], "notes.txt", {
            type: "text/plain",
            lastModified: 456,
        });
        await user.upload(screen.getByLabelText("Attach file"), secondFile);
        await user.click(screen.getByRole("button", { name: "send" }));

        await waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith(
                "chat.send",
                expect.objectContaining({
                    attachments: [
                        expect.objectContaining({
                            content: "aGVsbG8=",
                            fileName: "notes.txt",
                            mimeType: "text/plain",
                        }),
                    ],
                    message: "",
                    sessionKey: "session-a",
                })
            )
        );
        expect(
            screen.queryByRole("button", { name: "remove notes.txt" })
        ).not.toBeInTheDocument();
    });

    it("reports attachment limits, voice fallback, and slash command handling", async () => {
        const user = userEvent.setup();
        mocks.slashCommand.mockResolvedValueOnce(true);
        const oversizedFile = new File(["x"], "huge.txt", {
            type: "text/plain",
        });
        Object.defineProperty(oversizedFile, "size", { value: 21 * 1024 * 1024 });

        render(<Chat />);
        await screen.findByText("old user message");

        await user.upload(screen.getByLabelText("Attach file"), oversizedFile);
        expect(await screen.findByText(/huge\.txt is too large/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "toggle recording" }));
        expect(
            await screen.findByText(
                /Direct voice recording .* Choose or record an audio file instead\./
            )
        ).toBeInTheDocument();

        await user.type(screen.getByLabelText("Draft"), "/model codex");
        await user.click(screen.getByRole("button", { name: "send" }));

        await waitFor(() =>
            expect(mocks.slashCommand).toHaveBeenCalledWith("/model codex")
        );
        expect(mocks.request).not.toHaveBeenCalledWith(
            "chat.send",
            expect.objectContaining({ message: "/model codex" })
        );
    });

    it("sends unknown slash commands as normal chat messages", async () => {
        const user = userEvent.setup();
        mocks.slashCommand.mockResolvedValueOnce(false);

        render(<Chat />);
        await screen.findByText("old user message");

        await user.type(screen.getByLabelText("Draft"), "/unknown command");
        await user.click(screen.getByRole("button", { name: "send" }));

        await waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith(
                "chat.send",
                expect.objectContaining({
                    message: "/unknown command",
                    sessionKey: "session-a",
                })
            )
        );
    });

    it("keeps the optimistic stream when chat send returns without a run id", async () => {
        const user = userEvent.setup();
        mocks.request.mockImplementation(async (method: string) => {
            if (method === "chat.send") {
                return {};
            }

            return method === "chat.history" ? { messages: [] } : { models: [] };
        });

        render(<Chat />);
        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent("session-a")
        );

        await user.type(screen.getByLabelText("Draft"), "No run id");
        await user.click(screen.getByRole("button", { name: "send" }));

        await waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith(
                "chat.send",
                expect.objectContaining({ message: "No run id" })
            )
        );
        expect(screen.getByText("Thinking")).toBeInTheDocument();
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

    it("applies slash suggestions and follows dynamic message content", async () => {
        const user = userEvent.setup();

        render(<Chat />);
        await screen.findByText("old user message");

        await user.type(screen.getByLabelText("Draft"), "/mo");
        await user.click(
            screen.getByRole("button", { name: "apply first slash suggestion" })
        );
        expect((screen.getByLabelText("Draft") as HTMLTextAreaElement).value).toMatch(
            /^\//u
        );

        await user.click(screen.getByRole("button", { name: "dynamic content loaded" }));
        await user.click(screen.getByRole("button", { name: "follow bottom" }));
        fireEvent.scroll(screen.getByLabelText("chat messages"));
        expect(screen.getByTestId("bottom-state")).toHaveTextContent("true");
    });

    it("transcribes selected voice files and reports audio errors", async () => {
        const user = userEvent.setup();
        const fetchMock = vi.mocked(fetch);
        fetchMock
            .mockResolvedValueOnce({
                json: async () => ({ text: "  voice draft  " }),
                ok: true,
            } as Response)
            .mockResolvedValueOnce({
                json: async () => ({ text: "" }),
                ok: true,
            } as Response)
            .mockResolvedValueOnce({
                json: async () => ({ error: "speech service unavailable" }),
                ok: false,
                status: 503,
            } as Response);

        render(<Chat />);
        await screen.findByText("old user message");
        const voiceInput = document.querySelector<HTMLInputElement>(
            'input[accept="audio/*"]'
        )!;

        fireEvent.change(voiceInput, {
            target: {
                files: [new File(["voice"], "voice.webm", { type: "audio/webm" })],
            },
        });
        await waitFor(() =>
            expect(screen.getByLabelText("Draft")).toHaveValue("voice draft")
        );

        await user.clear(screen.getByLabelText("Draft"));
        fireEvent.change(voiceInput, {
            target: {
                files: [new File(["silence"], "silence.webm", { type: "audio/webm" })],
            },
        });
        expect(
            await screen.findByText("Whisper did not detect any speech.")
        ).toBeInTheDocument();

        fireEvent.change(voiceInput, {
            target: { files: [new File(["bad"], "bad.webm", { type: "audio/webm" })] },
        });
        expect(await screen.findByText("speech service unavailable")).toBeInTheDocument();

        const oversizedFile = new File(["x"], "too-big.webm", { type: "audio/webm" });
        Object.defineProperty(oversizedFile, "size", { value: 21 * 1024 * 1024 });
        fireEvent.change(voiceInput, { target: { files: [oversizedFile] } });
        expect(
            await screen.findByText(/too-big\.webm is too large/u)
        ).toBeInTheDocument();

        fireEvent.change(voiceInput, { target: { files: [] } });
    });

    it("uses generic transcription errors when the response body is unavailable", async () => {
        const fetchMock = vi.mocked(fetch).mockResolvedValue({
            json: async () => {
                throw new Error("invalid json");
            },
            ok: false,
            status: 502,
        } as unknown as Response);

        render(<Chat />);
        await screen.findByText("old user message");
        const voiceInput = document.querySelector<HTMLInputElement>(
            'input[accept="audio/*"]'
        )!;

        fireEvent.change(voiceInput, {
            target: {
                files: [new File(["bad"], "bad.webm", { type: "audio/webm" })],
            },
        });

        expect(await screen.findByText("Failed to transcribe audio")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("records direct microphone audio and transcribes the stopped recording", async () => {
        const user = userEvent.setup();
        const stopTrack = vi.fn();
        const fetchMock = vi.mocked(fetch).mockResolvedValue({
            json: async () => ({ text: "recorded text" }),
            ok: true,
        } as Response);
        let recorder: {
            listeners: Record<string, Array<(event?: { data: Blob }) => void>>;
            mimeType: string;
            stop: () => void;
        } | null = null;
        const MediaRecorderMock = vi.fn(function (this: typeof recorder) {
            recorder = {
                listeners: {},
                mimeType: "audio/webm",
                stop: () => {
                    const dataListeners = recorder?.listeners.dataavailable;
                    if (dataListeners) {
                        for (const listener of dataListeners) {
                            listener({
                                data: new Blob(["audio"], { type: "audio/webm" }),
                            });
                        }
                    }

                    const stopListeners = recorder?.listeners.stop;
                    if (stopListeners) {
                        for (const listener of stopListeners) listener();
                    }
                },
            };
            Object.assign(this as object, recorder, {
                addEventListener: (
                    type: string,
                    listener: (event?: { data: Blob }) => void
                ) => {
                    recorder!.listeners[type] = [
                        ...(recorder!.listeners[type] || []),
                        listener,
                    ];
                },
                start: vi.fn(),
            });
        });
        Object.assign(MediaRecorderMock, {
            isTypeSupported: vi.fn((mimeType: string) => mimeType === "audio/webm"),
        });
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                getUserMedia: vi.fn().mockResolvedValue({
                    getTracks: () => [{ stop: stopTrack }],
                }),
            },
        });
        Object.defineProperty(window, "MediaRecorder", {
            configurable: true,
            value: MediaRecorderMock,
        });

        render(<Chat />);
        await screen.findByText("old user message");

        await user.click(screen.getByRole("button", { name: "toggle recording" }));
        await waitFor(() =>
            expect(screen.getByTestId("composer-state")).toHaveTextContent(
                "true:false:true:false"
            )
        );
        await user.click(screen.getByRole("button", { name: "toggle recording" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/stt/transcribe",
                expect.objectContaining({ method: "POST" })
            )
        );
        expect(stopTrack).toHaveBeenCalledTimes(1);
        await waitFor(() =>
            expect(screen.getByLabelText("Draft")).toHaveValue("recorded text")
        );
    });

    it("reports an empty recording when no audio chunks are captured", async () => {
        const user = userEvent.setup();
        const stopTrack = vi.fn();
        let stopListener: (() => void) | null = null;
        const MediaRecorderMock = vi.fn(function (this: {
            addEventListener: (type: string, listener: () => void) => void;
            mimeType: string;
            start: () => void;
            stop: () => void;
        }) {
            Object.assign(this, {
                addEventListener: (type: string, listener: () => void) => {
                    if (type === "stop") stopListener = listener;
                },
                mimeType: "",
                start: vi.fn(),
                stop: () => stopListener?.(),
            });
        });
        Object.assign(MediaRecorderMock, {
            isTypeSupported: vi.fn(() => false),
        });
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                getUserMedia: vi.fn().mockResolvedValue({
                    getTracks: () => [{ stop: stopTrack }],
                }),
            },
        });
        Object.defineProperty(window, "MediaRecorder", {
            configurable: true,
            value: MediaRecorderMock,
        });

        render(<Chat />);
        await screen.findByText("old user message");

        await user.click(screen.getByRole("button", { name: "toggle recording" }));
        await user.click(screen.getByRole("button", { name: "toggle recording" }));

        expect(await screen.findByText("No audio was recorded.")).toBeInTheDocument();
        expect(MediaRecorderMock).toHaveBeenCalledWith(expect.anything());
        expect(stopTrack).toHaveBeenCalledTimes(1);
    });

    it("shows the HTTPS recording fallback when the page is not secure", async () => {
        const user = userEvent.setup();
        const originalIsSecureContextDescriptor = Object.getOwnPropertyDescriptor(
            window,
            "isSecureContext"
        );

        try {
            Object.defineProperty(window, "isSecureContext", {
                configurable: true,
                value: false,
            });

            render(<Chat />);
            await screen.findByText("old user message");

            await user.click(screen.getByRole("button", { name: "toggle recording" }));

            expect(
                await screen.findByText(
                    /Direct voice recording requires HTTPS or localhost/u
                )
            ).toBeInTheDocument();
        } finally {
            if (originalIsSecureContextDescriptor) {
                Object.defineProperty(
                    window,
                    "isSecureContext",
                    originalIsSecureContextDescriptor
                );
            } else {
                Reflect.deleteProperty(window, "isSecureContext");
            }
        }
    });

    it("switches sessions, reloads history, and clears queued attachments", async () => {
        const user = userEvent.setup();
        const file = new File(["hello"], "queued.txt", {
            type: "text/plain",
            lastModified: 789,
        });

        render(<Chat />);
        await screen.findByText("old user message");

        await user.upload(screen.getByLabelText("Attach file"), file);
        expect(
            await screen.findByRole("button", { name: "remove queued.txt" })
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "select side chat" }));
        await waitFor(() =>
            expect(screen.getByTestId("selected-session")).toHaveTextContent("session-b")
        );
        await waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith("chat.history", {
                limit: 1000,
                sessionKey: "session-b",
            })
        );
        expect(
            screen.queryByRole("button", { name: "remove queued.txt" })
        ).not.toBeInTheDocument();
    });

    it("handles history/model loading fallbacks and disconnected send state", async () => {
        mocks.request.mockImplementation(async (method: string) => {
            if (method === "models.list") {
                throw new Error("models unavailable");
            }
            if (method === "chat.history") {
                throw new Error("history unavailable");
            }
            return {};
        });

        const { rerender } = render(<Chat />);
        expect(await screen.findByText("history unavailable")).toBeInTheDocument();
        expect(screen.getByTestId("loading-history")).toHaveTextContent("false");

        mocks.isConnected = false;
        mocks.socketError = "socket down";
        rerender(<Chat />);
        expect(screen.getByTestId("composer-state")).toHaveTextContent("false:false");
    });

    it("polls visible history while connected and following the bottom", async () => {
        const intervalCallbacks: Array<() => void> = [];
        const setIntervalSpy = vi
            .spyOn(window, "setInterval")
            .mockImplementation((callback: TimerHandler) => {
                intervalCallbacks.push(callback as () => void);
                return intervalCallbacks.length as unknown as ReturnType<
                    typeof setInterval
                >;
            });

        try {
            render(<Chat />);
            await screen.findByText("old user message");
            await waitFor(() => expect(intervalCallbacks.length).toBeGreaterThan(0));
            mocks.request.mockClear();

            await act(async () => {
                for (const callback of intervalCallbacks) {
                    callback();
                }
            });

            await waitFor(() =>
                expect(mocks.request).toHaveBeenCalledWith("chat.history", {
                    limit: 1000,
                    sessionKey: "session-a",
                })
            );
        } finally {
            setIntervalSpy.mockRestore();
        }
    });

    it("limits attachment batches and surfaces recorder startup failures", async () => {
        const user = userEvent.setup();
        const files = Array.from(
            { length: 11 },
            (_, index) =>
                new File(["x"], `file-${index}.txt`, {
                    type: "text/plain",
                    lastModified: index,
                })
        );

        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                getUserMedia: vi.fn().mockRejectedValue(new Error("microphone denied")),
            },
        });
        Object.defineProperty(window, "MediaRecorder", {
            configurable: true,
            value: vi.fn(),
        });

        render(<Chat />);
        await screen.findByText("old user message");

        await user.upload(screen.getByLabelText("Attach file"), files);
        expect(
            await screen.findByText("Only 10 attachments can be sent at once.")
        ).toBeInTheDocument();
        expect(
            await screen.findByRole("button", { name: "remove file-0.txt" })
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "remove file-10.txt" })
        ).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "toggle recording" }));
        expect(await screen.findByText("microphone denied")).toBeInTheDocument();
    });

    it("stops opened microphone tracks when recorder construction fails", async () => {
        const user = userEvent.setup();
        const stopTrack = vi.fn();
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                getUserMedia: vi.fn().mockResolvedValue({
                    getTracks: () => [{ stop: stopTrack }],
                }),
            },
        });
        class MediaRecorderMock {
            static isTypeSupported = vi.fn(() => false);

            constructor() {
                throw new Error("recorder unavailable");
            }
        }
        Object.defineProperty(window, "MediaRecorder", {
            configurable: true,
            value: MediaRecorderMock,
        });

        render(<Chat />);
        await screen.findByText("old user message");

        await user.click(screen.getByRole("button", { name: "toggle recording" }));

        expect(await screen.findByText("recorder unavailable")).toBeInTheDocument();
        expect(stopTrack).toHaveBeenCalledTimes(1);
    });
});
