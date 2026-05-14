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
    runtimeEventsOptions: null as {
        updateActiveStreams: (
            updater: (previous: Record<string, unknown>) => Record<string, unknown>
        ) => void;
    } | null,
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
    useChatRuntimeEvents: vi.fn(
        (options: {
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

        writeDeletedMessageKeys("session-a", new Set(["three"]));
        expect(window.localStorage.getItem("openclaw:deleted:session-a")).toBe(
            '["three"]'
        );
        writeDeletedMessageKeys("", new Set(["ignored"]));
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
});

describe("Chat", () => {
    beforeEach(() => {
        installLocalStorageMock();
        mocks.isConnected = true;
        mocks.socketError = null;
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
});
