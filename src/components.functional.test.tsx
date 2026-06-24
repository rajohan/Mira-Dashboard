import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    act,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { ReactNode, RefObject } from "react";

import { TaskHistorySidebar } from "./components/features/agents/TaskHistorySidebar";
import { AttachmentPreviewModal } from "./components/features/chat/AttachmentPreviewModal";
import { ChatComposer } from "./components/features/chat/ChatComposer";
import { ChatHeader } from "./components/features/chat/ChatHeader";
import {
    ChatMarkdown,
    childrenToText,
    getPreCodeBlock,
    markdownComponents,
} from "./components/features/chat/ChatMarkdown";
import { ChatMessageDetails } from "./components/features/chat/ChatMessageDetails";
import {
    AttachmentIcon,
    base64ToText as messageListBase64ToText,
    ChatMessagesList,
    previewFromAttachment,
} from "./components/features/chat/ChatMessagesList";
import {
    compactStatusText,
    detailFromArguments,
    formatToolName,
    isNewRunForStream,
    isRuntimeWorkEvent,
    normalizeRuntimeStream,
    runtimeProgressText,
    stringValue,
    useChatRuntimeEvents,
} from "./components/features/chat/useChatRuntimeEvents";
import { useChatSlashCommands } from "./components/features/chat/useChatSlashCommands";
import { CronJobDetails } from "./components/features/cron/CronJobDetails";
import { CronJobList } from "./components/features/cron/CronJobList";
import { BackupOverviewCard } from "./components/features/dashboard/BackupOverviewCard";
import { CronOverviewCard } from "./components/features/dashboard/CronOverviewCard";
import { LogRotationCard } from "./components/features/dashboard/LogRotationCard";
import { QuotaOverviewCard } from "./components/features/dashboard/QuotaOverviewCard";
import { ServiceActionsCard } from "./components/features/dashboard/ServiceActionsCard";
import { AutovacuumHealthTable } from "./components/features/database/AutovacuumHealthTable";
import { DatabaseTableShell } from "./components/features/database/DatabaseTableShell";
import { TopQueriesTable } from "./components/features/database/TopQueriesTable";
import { DockerContainersTable } from "./components/features/docker/DockerContainersTable";
import {
    formatBytes,
    formatDockerMemory,
    formatFullVersionDisplay,
    formatTimestamp,
    formatUpdaterTransition,
    formatVersionDisplay,
} from "./components/features/docker/dockerFormatters";
import { DockerImagesTable } from "./components/features/docker/DockerImagesTable";
import { DockerVolumesTable } from "./components/features/docker/DockerVolumesTable";
import { ConfigSection } from "./components/features/files/ConfigSection";
import { FileContentViewer } from "./components/features/files/FileContentViewer";
import { FileEditorPanel } from "./components/features/files/FileEditorPanel";
import { FileTreeItem } from "./components/features/files/FileTreeItem";
import { PreviewToggle } from "./components/features/files/PreviewToggle";
import { LogLine } from "./components/features/logs/LogLine";
import { MyCommentCard } from "./components/features/moltbook/MyCommentCard";
import { MyPostCard } from "./components/features/moltbook/MyPostCard";
import { ProfileCard } from "./components/features/moltbook/ProfileCard";
import { SessionActionsDropdown } from "./components/features/sessions/SessionActionsDropdown";
import { SessionsTable } from "./components/features/sessions/SessionsTable";
import { AgentAccessSection } from "./components/features/settings/AgentAccessSection";
import { ChannelSection } from "./components/features/settings/ChannelSection";
import { HeartbeatSection } from "./components/features/settings/HeartbeatSection";
import { ModelSection } from "./components/features/settings/ModelSection";
import { SessionSection } from "./components/features/settings/SessionSection";
import { SkillsSection } from "./components/features/settings/SkillsSection";
import { ToolSection } from "./components/features/settings/ToolSection";
import { Alert } from "./components/ui/Alert";
import { getProgressColor, ProgressBar } from "./components/ui/ProgressBar";
import { useFileExplorerState } from "./hooks/useFileExplorerState";
import { useSessionActions } from "./hooks/useSessionActions";

const originalFetch = fetch;
const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};

const animationFrameState = {
    id: 0,
    frames: new Map<number, FrameRequestCallback>(),
};

function requestAnimationFrameForTest(callback: FrameRequestCallback): number {
    const id = ++animationFrameState.id;
    animationFrameState.frames.set(id, callback);
    return id;
}

function cancelAnimationFrameForTest(handle: number): void {
    animationFrameState.frames.delete(handle);
}

beforeEach(() => {
    Object.defineProperties(globalThis, {
        requestAnimationFrame: {
            configurable: true,
            value: requestAnimationFrameForTest,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: cancelAnimationFrameForTest,
            writable: true,
        },
    });
});

afterEach(() => {
    Object.defineProperties(globalThis, {
        fetch: {
            configurable: true,
            value: originalFetch,
            writable: true,
        },
        requestAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.requestAnimationFrame,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.cancelAnimationFrame,
            writable: true,
        },
    });
    animationFrameState.frames.clear();
});

function textToBase64(text: string): string {
    return new TextEncoder().encode(text).toBase64();
}

function renderWithQueryClient(children: ReactNode) {
    const queryClient = createQueryClient();

    return {
        ...render(
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
        queryClient,
    };
}

function createQueryClient() {
    return new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { retry: false, staleTime: Infinity },
        },
    });
}

describe("shared component helpers", () => {
    it("flattens nested React children and detects fenced code blocks", () => {
        expect(
            childrenToText([
                "hello ",
                <span key="world">world</span>,
                [<strong key="bang">!</strong>, 7],
            ])
        ).toBe("hello world!7");

        expect(
            getPreCodeBlock(
                <code className="language-ts">{["const answer = 42;\n"]}</code>
            )
        ).toEqual({
            code: "const answer = 42;",
            language: "ts",
        });
        expect(getPreCodeBlock(<span>plain</span>)).toEqual({
            code: "plain",
            language: "text",
        });
        expect(getPreCodeBlock("plain")).toBeUndefined();
    });

    it("renders markdown links, images, tables, fallbacks, and code blocks", () => {
        const renderImage = markdownComponents.img as (properties: {
            alt?: string;
            node: unknown;
            src?: string;
        }) => unknown;
        const image = renderImage({
            alt: "Dashboard image",
            node: undefined,
            src: "https://example.test/image.png",
        });
        const missingImage = renderImage({
            alt: "",
            node: undefined,
            src: "",
        });

        expect(image).toBeTruthy();
        expect(missingImage).toBeUndefined();

        render(
            <ChatMarkdown
                text={[
                    "[link](https://example.test)",
                    "> quoted",
                    "",
                    "| A |",
                    "| - |",
                    "| B |",
                    "",
                    "`inline`",
                    "",
                    "```json",
                    "{value: 1}",
                    "```",
                    "",
                    "```sh",
                    "echo ok",
                    "```",
                ].join("\n")}
            />
        );

        expect(screen.getByRole("link", { name: "link" })).toHaveAttribute(
            "target",
            "_blank"
        );
        expect(screen.getByText("quoted")).toBeInTheDocument();
        expect(screen.getByText("inline")).toBeInTheDocument();
        expect(screen.getByText("json")).toBeInTheDocument();
        expect(screen.getByText("sh")).toBeInTheDocument();
    });

    it("renders alert variants and clamps progress bar width", () => {
        expect(getProgressColor(10)).toBe("green");
        expect(getProgressColor(50)).toBe("blue");
        expect(getProgressColor(89)).toBe("orange");
        expect(getProgressColor(99)).toBe("red");

        render(
            <>
                <Alert variant="success" title="Saved">
                    Done
                </Alert>
                <Alert variant="warning">Careful</Alert>
                <ProgressBar percent={140} color="purple" size="sm" />
            </>
        );

        expect(screen.getByText("Saved")).toBeInTheDocument();
        expect(screen.getByText("Done")).toBeInTheDocument();
        expect(screen.getByText("Careful")).toBeInTheDocument();
        expect(document.querySelector(".bg-purple-500")).toHaveStyle({
            width: "100%",
        });
    });

    it("renders file preview, log, session, cron, and Moltbook cards", async () => {
        const user = userEvent.setup();
        const onToggle = jest.fn();
        const onCompact = jest.fn();
        const onReset = jest.fn();
        const onDelete = jest.fn();
        const onSelect = jest.fn();

        render(
            <>
                <PreviewToggle
                    isPreview={false}
                    onToggle={onToggle}
                    previewLabel="Preview file"
                    editLabel="Raw file"
                />
                <LogLine
                    log={{
                        id: "log-1",
                        level: "info",
                        msg: "Started",
                        raw: "",
                        subsystem: "api",
                        ts: "2026-06-24T10:00:00.000Z",
                    }}
                />
                <SessionActionsDropdown
                    onCompact={onCompact}
                    onReset={onReset}
                    onDelete={onDelete}
                />
                <CronJobList
                    selectedId=""
                    currentJobId="heartbeat"
                    onSelect={onSelect}
                    jobs={[
                        {
                            enabled: true,
                            id: "heartbeat",
                            name: "Heartbeat",
                            state: {
                                lastRunAtMs: 1_719_216_000_000,
                                nextRunAtMs: 1_719_219_600_000,
                            },
                        },
                        { enabled: false, id: "cleanup", name: "Cleanup", state: {} },
                    ]}
                />
                <MyPostCard
                    post={{
                        comment_count: 3,
                        content_preview: "Post preview",
                        created_at: "2026-06-24T10:00:00.000Z",
                        downvotes: 1,
                        id: "42",
                        submolt: { name: "dashboard" },
                        title: "Coverage post",
                        upvotes: 7,
                    }}
                />
                <MyCommentCard
                    comment={{
                        content: "Comment body",
                        created_at: "2026-06-24T10:00:00.000Z",
                        downvotes: 0,
                        id: "9",
                        post: {
                            id: "42",
                            submolt: { name: "dashboard" },
                            title: "Coverage post",
                        },
                        upvotes: 4,
                    }}
                />
                <ProfileCard
                    unreadCount={2}
                    profile={{
                        avatar_url: "",
                        description: "Dashboard agent",
                        display_name: "Mira",
                        follower_count: 11,
                        following_count: 5,
                        karma: 99,
                        name: "mira_2026",
                        comments_count: 8,
                        posts_count: 6,
                    }}
                />
                <ProfileCard
                    unreadCount={0}
                    profile={{
                        avatar_url: "https://example.test/avatar.png",
                        description: "With avatar",
                        display_name: "",
                        follower_count: 1,
                        following_count: 2,
                        karma: 3,
                        name: "mira_avatar",
                        comments_count: 4,
                        posts_count: 5,
                    }}
                />
            </>
        );

        fireEvent.click(screen.getByRole("button", { name: /preview file/i }));
        fireEvent.click(screen.getByRole("button", { name: /raw file/i }));
        expect(onToggle).toHaveBeenNthCalledWith(1, true);
        expect(onToggle).toHaveBeenNthCalledWith(2, false);

        expect(screen.getByText("INFO")).toBeInTheDocument();
        expect(screen.getByText("[api]")).toBeInTheDocument();
        expect(screen.getByText("Started")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /session actions/i }));
        await user.click(screen.getByRole("menuitem", { name: /compact/i }));
        await user.click(screen.getByRole("button", { name: /session actions/i }));
        await user.click(screen.getByRole("menuitem", { name: /reset/i }));
        await user.click(screen.getByRole("button", { name: /session actions/i }));
        await user.click(screen.getByRole("menuitem", { name: /delete/i }));
        expect(onCompact).toHaveBeenCalledTimes(1);
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: /cleanup/i }));
        expect(onSelect).toHaveBeenCalledWith("cleanup");
        expect(screen.getAllByText("Coverage post").length).toBeGreaterThan(0);
        expect(screen.getByText("Comment body")).toBeInTheDocument();
        expect(screen.getByText("2 new")).toBeInTheDocument();
        expect(screen.getByAltText("mira_avatar")).toHaveAttribute(
            "src",
            "https://example.test/avatar.png"
        );
    });

    it("renders chat attachment previews, header toggles, and diagnostic details", async () => {
        const user = userEvent.setup();
        const onClose = jest.fn();
        const onToggleThinking = jest.fn();
        const onToggleTools = jest.fn();
        const onSelectAgent = jest.fn();
        const onSelectSession = jest.fn();

        const { rerender } = render(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "image",
                    mimeType: "image/png",
                    sizeBytes: 1024,
                    title: "Preview image",
                    url: "data:image/png;base64,a",
                }}
                onClose={onClose}
            />
        );
        expect(screen.getByAltText("Preview image")).toBeInTheDocument();

        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "text",
                    mimeType: "text/plain",
                    text: "hello attachment",
                    title: "Preview text",
                }}
                onClose={onClose}
            />
        );
        expect(screen.getByText("hello attachment")).toBeInTheDocument();

        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "file",
                    mimeType: "application/pdf",
                    title: "report.pdf",
                    url: "data:application/pdf;base64,a",
                }}
                onClose={onClose}
            />
        );
        expect(screen.getByText("Download file")).toBeInTheDocument();

        rerender(
            <AttachmentPreviewModal
                previewItem={{ kind: "file", title: "historic.bin" }}
                onClose={onClose}
            />
        );
        expect(
            screen.getByText("This historical attachment has no preview data available.")
        ).toBeInTheDocument();

        rerender(
            <>
                <ChatHeader
                    selectedSession={{
                        agentType: "codex",
                        channel: "web",
                        createdAt: "2026-06-24T10:00:00.000Z",
                        displayLabel: "Main",
                        displayName: "Main",
                        hookName: "",
                        id: "session-1",
                        key: "agent:main:main",
                        kind: "agent",
                        label: "Main",
                        maxTokens: 1000,
                        model: "codex",
                        thinkingLevel: "high",
                        tokenCount: 5,
                        type: "agent",
                        updatedAt: Date.now(),
                    }}
                    selectedAgentId="main"
                    selectedSessionKey="agent:main:main"
                    agentOptions={[{ label: "Main agent", value: "main" }]}
                    sessionOptions={[{ label: "Main session", value: "agent:main:main" }]}
                    shouldShowThinking={true}
                    shouldShowTools={false}
                    onToggleThinking={onToggleThinking}
                    onToggleTools={onToggleTools}
                    onSelectAgent={onSelectAgent}
                    onSelectSession={onSelectSession}
                />
                <ChatMessageDetails
                    visibility={{ shouldShowThinking: true, shouldShowTools: true }}
                    message={{
                        attachments: [],
                        content: "answer",
                        images: [],
                        role: "assistant",
                        text: "answer",
                        thinking: [{ text: "working" }],
                        toolCalls: [
                            { arguments: { ok: true }, id: "tool-1", name: "run" },
                            { id: "tool-2", name: "empty" },
                        ],
                        toolResult: {
                            content: "tool output",
                            isError: true,
                            name: "run",
                        },
                    }}
                />
                <ChatMessageDetails
                    visibility={{ shouldShowThinking: false, shouldShowTools: false }}
                    message={{
                        attachments: [],
                        content: "hidden",
                        images: [],
                        role: "assistant",
                        text: "hidden",
                    }}
                />
            </>
        );

        await user.click(screen.getByRole("button", { name: /thinking/i }));
        await user.click(screen.getByRole("button", { name: /tools/i }));
        expect(onToggleThinking).toHaveBeenCalledTimes(1);
        expect(onToggleTools).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Thinking: high/)).toBeInTheDocument();
        expect(screen.getByText("Thinking / working")).toBeInTheDocument();
        expect(screen.getByText("Tool call · run")).toBeInTheDocument();
        expect(screen.getByText("No arguments")).toBeInTheDocument();
        expect(screen.getByText("Tool result · run")).toBeInTheDocument();
    });

    it("drives chat composer attachments, slash suggestions, emoji, and submit controls", async () => {
        const user = userEvent.setup();
        const fileInputReference = {
            current: undefined,
        } as RefObject<HTMLInputElement | undefined>;
        const onApplySlashSuggestion = jest.fn();
        const onAttachFiles = jest.fn();
        const onChangeDraft = jest.fn();
        const onPreview = jest.fn();
        const onRemoveAttachment = jest.fn();
        const onSend = jest.fn();
        const onToggleRecording = jest.fn();

        render(
            <ChatComposer
                attachments={[
                    {
                        contentBase64: textToBase64("hello"),
                        file: new File(["hello"], "note.txt", { type: "text/plain" }),
                        fileName: "note.txt",
                        id: "a1",
                        kind: "text",
                        mimeType: "text/plain",
                        sizeBytes: 5,
                    },
                    {
                        contentBase64: "a",
                        dataUrl: "data:image/png;base64,a",
                        file: new File(["a"], "image.png", { type: "image/png" }),
                        fileName: "image.png",
                        id: "a2",
                        kind: "image",
                        mimeType: "image/png",
                        sizeBytes: 1,
                    },
                ]}
                canSend={true}
                draft="/he"
                fileInputReference={fileInputReference}
                isConnected={true}
                isRecording={false}
                isSending={false}
                isTranscribing={false}
                selectedSessionKey="agent:main:main"
                slashCommandSuggestions={[
                    {
                        description: "Show commands",
                        title: "/help",
                        value: "/help",
                    },
                ]}
                onApplySlashSuggestion={onApplySlashSuggestion}
                onAttachFiles={onAttachFiles}
                onChangeDraft={onChangeDraft}
                onPreview={onPreview}
                onRemoveAttachment={onRemoveAttachment}
                onSend={onSend}
                onToggleRecording={onToggleRecording}
            />
        );

        await user.click(screen.getAllByRole("button", { name: /note.txt/i })[0]!);
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "text", text: "hello", title: "note.txt" })
        );
        await user.click(screen.getByRole("button", { name: /remove note.txt/i }));
        expect(onRemoveAttachment).toHaveBeenCalledWith("a1");
        await user.click(screen.getByRole("button", { name: /help/i }));
        expect(onApplySlashSuggestion).toHaveBeenCalledWith("/help");

        const textarea = screen.getByPlaceholderText(/Message, attach files/i);
        fireEvent.change(textarea, { target: { value: "/help" } });
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(onChangeDraft).toHaveBeenCalledWith("/help");
        expect(onSend).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: /insert emoji/i }));
        const emojiButton = screen.getByRole("button", { name: "Insert 😀" });
        (textarea as HTMLTextAreaElement).setSelectionRange(0, 0);
        await user.click(emojiButton);
        expect(onChangeDraft).toHaveBeenCalledWith("😀/he");

        await user.click(screen.getByRole("button", { name: /voice/i }));
        await user.click(screen.getByRole("button", { name: /attach/i }));
        await user.click(screen.getByRole("button", { name: /send/i }));
        expect(onToggleRecording).toHaveBeenCalledTimes(1);
        expect(onSend).toHaveBeenCalledTimes(2);
    });

    it("handles chat slash commands without rendering the page", async () => {
        const requestCalls: Array<[string, Record<string, unknown> | undefined]> = [];
        const request = async <T = unknown,>(
            method: string,
            parameters?: Record<string, unknown>
        ): Promise<T> => {
            requestCalls.push([method, parameters]);
            return { ok: true } as T;
        };
        const updateActiveStreams = jest.fn((updater) =>
            updater({
                "agent:main:main": {
                    aliases: [],
                    runId: "r1",
                    sessionKey: "agent:main:main",
                    text: "run",
                    updatedAt: "now",
                },
            })
        );
        const setMessages = jest.fn((updater) => updater([]));
        const setDraft = jest.fn();
        const setSendError = jest.fn();
        const confirmResetSession = jest.fn(async () => false);
        const runSlashCommand = useChatSlashCommands({
            attachments: [],
            confirmResetSession,
            request,
            selectedSessionKey: "agent:main:main",
            setDraft,
            setMessages,
            setSendError,
            updateActiveStreams,
        });

        await expect(runSlashCommand("hello")).resolves.toBe(false);
        await expect(runSlashCommand("/unknown")).resolves.toBe(false);
        await expect(runSlashCommand("/reset")).resolves.toBe(true);
        expect(setMessages).toHaveBeenCalled();
        await expect(runSlashCommand("/stop")).resolves.toBe(true);
        expect(requestCalls).toContainEqual([
            "chat.abort",
            { sessionKey: "agent:main:main" },
        ]);

        const blocked = useChatSlashCommands({
            attachments: [
                {
                    contentBase64: "a",
                    file: new File(["a"], "a.txt", { type: "text/plain" }),
                    fileName: "a.txt",
                    id: "a",
                    kind: "text",
                    mimeType: "text/plain",
                    sizeBytes: 1,
                },
            ],
            confirmResetSession,
            request,
            selectedSessionKey: "agent:main:main",
            setDraft,
            setMessages,
            setSendError,
            updateActiveStreams,
        });
        await expect(blocked("/stop")).resolves.toBe(true);
        expect(setSendError).toHaveBeenCalledWith("/stop cannot include attachments.");
    });

    it("normalizes chat runtime event helper output", () => {
        expect(compactStatusText("  hello   world  ")).toBe("hello world");
        expect(compactStatusText("x".repeat(140))).toHaveLength(120);
        expect(stringValue(" value ")).toBe("value");
        expect(stringValue(" ")).toBeUndefined();
        expect(formatToolName("functions.exec_command")).toBe("Exec command");
        expect(detailFromArguments({ command: "bun test" })).toBe("bun test");
        expect(detailFromArguments("raw detail")).toBe("raw detail");
        expect(detailFromArguments({ unknown: true })).toBeUndefined();
        expect(normalizeRuntimeStream("command_output")).toBe("command-output");
        expect(normalizeRuntimeStream(42)).toBe("");

        expect(
            runtimeProgressText("session.tool", "tool", "start", {
                args: { query: "coverage" },
                name: "functions.web_search",
            })
        ).toBe("Web search: coverage");
        expect(
            runtimeProgressText("session.tool", "tool", "start", {
                name: "message",
            })
        ).toBeUndefined();
        expect(
            runtimeProgressText("session.event", "item", "start", {
                itemKind: "todo",
                summary: "write tests",
            })
        ).toBe("Todo: write tests");
        expect(
            runtimeProgressText("session.event", "plan", "start", {
                explanation: "Update plan",
            })
        ).toBe("Update plan");
        expect(runtimeProgressText("session.event", "approval", "start", {})).toBe(
            "Waiting for approval"
        );
        expect(runtimeProgressText("session.event", "patch", "start", {})).toBe(
            "Applying patch"
        );
        expect(
            runtimeProgressText("session.event", "command-output", "end", {
                exitCode: 1,
                name: "exec",
                title: "lint",
            })
        ).toBe("Exec: exit 1: lint");
        expect(runtimeProgressText("session.event", "compaction", "start", {})).toBe(
            "Compacting context"
        );
        expect(runtimeProgressText("session.event", "lifecycle", "start", {})).toBe(
            "Thinking"
        );
        expect(
            runtimeProgressText("session.event", "unknown", "start", {})
        ).toBeUndefined();

        expect(isNewRunForStream({ aliases: [], runId: "old" }, "new")).toBe(true);
        expect(isNewRunForStream({ aliases: ["new"], runId: "old" }, "new")).toBe(false);
        expect(isRuntimeWorkEvent("session.tool", "tool", "start", "Tool")).toBe(true);
        expect(isRuntimeWorkEvent("session.tool", "tool", "start")).toBe(false);
        expect(isRuntimeWorkEvent("session.event", "lifecycle", "start")).toBe(true);
    });

    it("drives chat runtime event subscription, stream buffering, and refreshes", async () => {
        let listener: ((data: unknown) => void) | undefined;
        const unsubscribe = jest.fn();
        const subscribe = jest.fn((nextListener: (data: unknown) => void) => {
            listener = nextListener;
            return unsubscribe;
        });
        const requestCalls: Array<[string, Record<string, unknown> | undefined]> = [];
        const request = async <T,>(
            method: string,
            parameters?: Record<string, unknown>
        ): Promise<T> => {
            requestCalls.push([method, parameters]);
            if (method === "chat.history") {
                return {
                    messages: [
                        {
                            role: "assistant",
                            text: "history answer",
                            timestamp: "2026-06-24T10:00:00.000Z",
                        },
                    ],
                } as T;
            }
            return {} as T;
        };
        let activeStreams = {};
        const activeStreamsReference = { current: activeStreams };
        const liveHistoryRefreshTimerReference = { current: undefined };
        const shouldStickToBottomReference = { current: true };
        let messages: unknown[] = [];
        let sendError: string | undefined;
        let isAtBottom = false;
        let historyLoadVersion = 0;
        const updateActiveStreams = jest.fn((updater) => {
            activeStreams = updater(activeStreams);
            activeStreamsReference.current = activeStreams;
        });
        const setMessages = jest.fn((updater) => {
            messages = typeof updater === "function" ? updater(messages) : updater;
        });
        const setSendError = jest.fn((updater) => {
            sendError = typeof updater === "function" ? updater(sendError) : updater;
        });
        const setIsAtBottom = jest.fn((updater) => {
            isAtBottom = typeof updater === "function" ? updater(isAtBottom) : updater;
        });
        const setHistoryLoadVersion = jest.fn((updater) => {
            historyLoadVersion =
                typeof updater === "function" ? updater(historyLoadVersion) : updater;
        });

        const { unmount } = renderHook(() =>
            useChatRuntimeEvents({
                activeStreamsReference,
                connectionId: 1,
                isConnected: true,
                liveHistoryRefreshTimerReference,
                request,
                selectedSessionKey: "agent:main:main",
                setHistoryLoadVersion,
                setIsAtBottom,
                setMessages,
                setSendError,
                shouldStickToBottomReference,
                showThinkingOutput: true,
                showToolOutput: true,
                subscribe,
                updateActiveStreams,
            })
        );

        await waitFor(() => {
            expect(subscribe).toHaveBeenCalledTimes(1);
        });

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "Hello",
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });

        await waitFor(() => {
            expect(activeStreamsReference.current).toHaveProperty("agent:main:main");
        });

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "bun test" },
                        name: "functions.exec_command",
                        phase: "end",
                        result: { ok: true },
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "tool" &&
                    "text" in message &&
                    typeof message.text === "string" &&
                    message.text.includes("ok")
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: { role: "assistant", text: "final answer" },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "assistant" &&
                    "text" in message &&
                    message.text === "final answer"
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    errorMessage: "failed",
                    runId: "run-2",
                    sessionKey: "agent:main:main",
                    state: "error",
                },
                type: "event",
            });
        });
        expect(sendError).toBe("failed");

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 550));
        });
        expect(requestCalls).toContainEqual([
            "chat.history",
            {
                limit: expect.any(Number),
                sessionKey: "agent:main:main",
            },
        ]);
        expect(isAtBottom).toBe(true);
        expect(historyLoadVersion).toBeGreaterThan(0);

        unmount();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("renders chat messages list helpers and primary row actions", async () => {
        const user = userEvent.setup();
        const onDynamicContentLoad = jest.fn();
        const onFollow = jest.fn();
        const onPreview = jest.fn();
        const onScroll = jest.fn();
        const onTtsError = jest.fn();
        const onDeleteMessage = jest.fn();
        const messagesBottomReference = {
            current: undefined,
        } as RefObject<HTMLDivElement | undefined>;
        const messagesContainerReference = {
            current: undefined,
        } as RefObject<HTMLDivElement | undefined>;
        const virtualizer = {
            getTotalSize: () => 240,
            getVirtualItems: () => [
                { end: 100, index: 0, key: "user", start: 0 },
                { end: 200, index: 1, key: "assistant", start: 100 },
                { end: 230, index: 2, key: "typing", start: 200 },
            ],
            measureElement: jest.fn(),
        };

        expect(messageListBase64ToText(textToBase64("hello"))).toBe("hello");
        expect(messageListBase64ToText("not base64")).toBeUndefined();
        expect(
            previewFromAttachment({
                contentBase64: textToBase64("hello"),
                fileName: "note.txt",
                id: "note",
                kind: "text",
                mimeType: "text/plain",
            })
        ).toMatchObject({ text: "hello", title: "note.txt" });
        expect(
            previewFromAttachment({ fileName: "empty.bin", id: "empty", kind: "file" })
        ).toBeUndefined();

        render(
            <>
                <AttachmentIcon
                    attachment={{ fileName: "image", id: "i", kind: "image" }}
                />
                <AttachmentIcon
                    attachment={{ fileName: "text", id: "t", kind: "text" }}
                />
                <AttachmentIcon
                    attachment={{ fileName: "file", id: "f", kind: "file" }}
                />
                <ChatMessagesList
                    isAtBottom={false}
                    isLoadingHistory={false}
                    chatRows={[
                        {
                            key: "user",
                            kind: "message",
                            message: {
                                attachments: [],
                                content: "hello",
                                images: [],
                                role: "user",
                                text: "hello",
                                timestamp: "2026-06-24T10:00:00.000Z",
                            },
                        },
                        {
                            key: "assistant",
                            kind: "message",
                            message: {
                                attachments: [
                                    {
                                        contentBase64: textToBase64("read me"),
                                        fileName: "readme.txt",
                                        id: "readme",
                                        kind: "text",
                                        mimeType: "text/plain",
                                        sizeBytes: 7,
                                    },
                                ],
                                content: "answer",
                                images: [{ data: "a", type: "image" }],
                                role: "assistant",
                                text: "answer",
                                timestamp: "2026-06-24T10:01:00.000Z",
                            },
                        },
                        {
                            key: "typing",
                            kind: "typing",
                            message: {
                                attachments: [],
                                content: "",
                                images: [],
                                role: "assistant",
                                text: "Working",
                            },
                        },
                    ]}
                    messagesBottomReference={messagesBottomReference}
                    messagesContainerReference={messagesContainerReference}
                    messagesVirtualizer={virtualizer as never}
                    onDeleteMessage={onDeleteMessage}
                    onDynamicContentLoad={onDynamicContentLoad}
                    onFollow={onFollow}
                    onPreview={onPreview}
                    onScroll={onScroll}
                    onTtsError={onTtsError}
                    visibility={{ shouldShowThinking: true, shouldShowTools: true }}
                />
            </>
        );

        fireEvent.scroll(messagesContainerReference.current!);
        await user.click(screen.getByRole("button", { name: /follow/i }));
        await user.click(screen.getByRole("button", { name: /delete your message/i }));
        await user.click(
            screen.getByRole("button", { name: /open chat image 1 preview/i })
        );
        await user.click(screen.getByRole("button", { name: /readme.txt/i }));
        expect(onScroll).toHaveBeenCalledTimes(1);
        expect(onFollow).toHaveBeenCalledTimes(1);
        expect(onDeleteMessage).toHaveBeenCalledWith("user");
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "image", title: "Chat image" })
        );
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "text", title: "readme.txt" })
        );
        expect(screen.getByLabelText("Assistant is working")).toBeInTheDocument();
    });

    it("renders file content variants and editable text changes", () => {
        const onContentChange = jest.fn();
        const baseFile = {
            content: "hello",
            isBinary: false,
            modified: "2026-06-24T10:00:00.000Z",
            path: "/tmp/readme.txt",
            size: 5,
        };

        const { rerender } = render(
            <FileContentViewer
                fileContent={{ ...baseFile, size: 2_000_000 }}
                editedContent="hello"
                onContentChange={onContentChange}
                largeFileWarning={true}
                isEditable={false}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass="syntax-test"
            />
        );
        expect(screen.getByText(/Large file/)).toBeInTheDocument();
        expect(screen.getByText("hello")).toBeInTheDocument();

        rerender(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    content: "",
                    isBinary: true,
                    path: "/tmp/archive.bin",
                }}
                editedContent=""
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={false}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        expect(screen.getByText("Binary file")).toBeInTheDocument();

        rerender(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    content: "a",
                    isImage: true,
                    mimeType: "image/png",
                    path: "/tmp/image.png",
                }}
                editedContent=""
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={false}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        expect(screen.getByAltText("image.png")).toHaveAttribute(
            "src",
            "data:image/png;base64,a"
        );

        rerender(
            <FileContentViewer
                fileContent={{ ...baseFile, path: "/tmp/script.ts" }}
                editedContent="const ok = true;"
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={true}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={true}
                syntaxClass="syntax-test"
            />
        );
        fireEvent.change(screen.getByDisplayValue("const ok = true;"), {
            target: { value: "const ok = false;" },
        });
        expect(onContentChange).toHaveBeenCalledWith("const ok = false;");
    });

    it("drives file explorer hook directory loading, JSON validation, and saves", async () => {
        let savedFileBody: unknown;
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/files" && method === "GET") {
                    return Response.json({
                        files: [
                            {
                                children: [],
                                loaded: false,
                                name: "src",
                                path: "src",
                                type: "directory",
                            },
                            {
                                name: "config.json5",
                                path: "src/config.json5",
                                size: 10,
                                type: "file",
                            },
                        ],
                    });
                }

                if (url === "/api/files?path=src" && method === "GET") {
                    return Response.json({
                        files: [
                            {
                                name: "config.json5",
                                path: "src/config.json5",
                                size: 10,
                                type: "file",
                            },
                        ],
                    });
                }

                if (url === "/api/files/src%2Fconfig.json5" && method === "GET") {
                    return Response.json({
                        content: "{foo: 1}",
                        isBinary: false,
                        path: "src/config.json5",
                        size: 10,
                    });
                }

                if (url === "/api/files/src%2Fconfig.json5" && method === "PUT") {
                    savedFileBody = JSON.parse(String(init?.body));
                    return new Response("", { status: 204 });
                }

                throw new Error(`Unexpected file explorer test fetch: ${method} ${url}`);
            }
        );

        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const queryClient = createQueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const { result, unmount } = renderHook(() => useFileExplorerState(), {
            wrapper,
        });

        await waitFor(() => {
            expect(result.current.files).toHaveLength(2);
        });

        await act(async () => {
            await result.current.handleToggle("src");
        });
        expect(result.current.expandedPaths.has("src")).toBe(true);
        expect(result.current.files[0]?.children).toHaveLength(1);

        await act(async () => {
            await result.current.handleToggle("src");
        });
        expect(result.current.expandedPaths.has("src")).toBe(false);

        act(() => {
            result.current.handleSelect("src/config.json5");
        });
        await waitFor(() => {
            expect(result.current.fileContent?.content).toBe("{foo: 1}");
        });

        act(() => {
            result.current.setJsonPreview(false);
            result.current.handleContentChange("{bad json");
        });
        expect(result.current.isJsonEditing).toBe(true);
        expect(result.current.jsonValidation.valid).toBe(false);

        await act(async () => {
            await result.current.handleSave();
        });
        expect(result.current.error).toMatch(/Invalid JSON/);

        act(() => {
            result.current.handleContentChange("{foo: 2}");
        });
        await act(async () => {
            await result.current.handleSave();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/files/src%2Fconfig.json5",
            expect.objectContaining({ method: "PUT" })
        );
        expect(savedFileBody).toEqual({ content: "{foo: 2}" });

        act(() => {
            result.current.handleRefresh();
        });
        expect(result.current.hasChanges).toBe(false);
        unmount();
        queryClient.clear();
    });

    it("drives dashboard cards, file tree/config branches, and session action hook", async () => {
        const user = userEvent.setup();
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);

                if (url === "/api/sessions/agent%3Amain%3Amain/action") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        action: expect.stringMatching(/^(compact|reset|stop)$/),
                    });
                    return new Response("", { status: 204 });
                }

                const method = init?.method ?? "GET";
                if (url === "/api/sessions/agent%3Amain%3Amain" && method === "DELETE") {
                    return new Response("", { status: 204 });
                }

                if (url === "/api/ops/log-rotation/status") {
                    return Response.json({
                        isSuccess: true,
                        lastRun: {
                            checkedFiles: 3,
                            checkedGroups: 1,
                            compressedFiles: 1,
                            deletedArchives: 0,
                            errors: [],
                            finishedAt: "2026-06-24T10:00:00.000Z",
                            groups: [],
                            isDryRun: false,
                            isOk: true,
                            rotatedFiles: 2,
                            skippedFiles: 0,
                            startedAt: "2026-06-24T09:59:00.000Z",
                            warnings: [],
                        },
                    });
                }

                if (url === "/api/jobs") {
                    return Response.json({
                        jobs: [
                            {
                                actionKey: "ops.logRotation",
                                actionPayload: {},
                                createdAt: "2026-06-24T08:00:00.000Z",
                                description: "Rotate logs",
                                enabled: true,
                                id: "ops.log-rotation",
                                intervalSeconds: 86_400,
                                isRunning: false,
                                name: "Log rotation",
                                nextRunAt: "2026-06-24T22:30:00.000Z",
                                scheduleType: "cron",
                                cronExpression: "30 22 * * *",
                                updatedAt: "2026-06-24T08:00:00.000Z",
                            },
                        ],
                    });
                }

                if (url === "/api/cron/jobs") {
                    return Response.json({
                        jobs: [
                            {
                                enabled: true,
                                id: "heartbeat",
                                name: "Heartbeat",
                                state: {
                                    lastRunAtMs: 1_719_216_000_000,
                                    lastRunStatus: "success",
                                    nextRunAtMs: 1_719_219_600_000,
                                },
                            },
                            {
                                enabled: false,
                                id: "cleanup",
                                name: "Cleanup",
                                state: {},
                            },
                        ],
                    });
                }

                if (
                    url === "/api/ops/log-rotation/dry-run" ||
                    url === "/api/ops/log-rotation/run"
                ) {
                    return Response.json({
                        isSuccess: true,
                        result: {
                            checkedFiles: 1,
                            checkedGroups: 1,
                            compressedFiles: 0,
                            deletedArchives: 0,
                            errors: [],
                            finishedAt: "2026-06-24T10:01:00.000Z",
                            groups: [],
                            isDryRun: url.endsWith("dry-run"),
                            isOk: true,
                            rotatedFiles: 0,
                            skippedFiles: 0,
                            startedAt: "2026-06-24T10:00:00.000Z",
                            warnings: [],
                        },
                        stderr: "",
                    });
                }

                throw new Error(`Unexpected dashboard card fetch: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const queryClient = createQueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const { result, unmount } = renderHook(() => useSessionActions(), {
            wrapper,
        });

        act(() => {
            result.current.stop("agent:main:main");
            result.current.compact("agent:main:main");
            result.current.reset("agent:main:main");
        });
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/sessions/agent%3Amain%3Amain/action",
                expect.objectContaining({
                    body: JSON.stringify({ action: "stop" }),
                    method: "POST",
                })
            );
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/sessions/agent%3Amain%3Amain/action",
                expect.objectContaining({
                    body: JSON.stringify({ action: "compact" }),
                    method: "POST",
                })
            );
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/sessions/agent%3Amain%3Amain/action",
                expect.objectContaining({
                    body: JSON.stringify({ action: "reset" }),
                    method: "POST",
                })
            );
        });
        await act(async () => {
            await result.current.remove("agent:main:main");
        });

        const onConfigSelect = jest.fn();
        const onTreeSelect = jest.fn();
        const onTreeToggle = jest.fn();

        render(
            <QueryClientProvider client={queryClient}>
                <LogRotationCard />
                <CronOverviewCard />
                <QuotaOverviewCard
                    quotas={{
                        cacheAgeMs: 0,
                        checkedAt: 1_719_216_000_000,
                        elevenlabs: {
                            percentUsed: 96,
                            remaining: 4,
                            resetAt: "13:45 on 25 Jun",
                            tier: "creator",
                            total: 100,
                            used: 96,
                        },
                        openai: {
                            account: "raymond",
                            fiveHourLeftPercent: 12,
                            fiveHourReset: "13:45",
                            model: "codex",
                            percentUsed: 88,
                            resetAt: "13:45",
                            weeklyLeftPercent: 30,
                            weeklyReset: "2026-06-25T10:00:00.000Z",
                        },
                        openrouter: {
                            percentUsed: 40,
                            remaining: 6,
                            totalCredits: 10,
                            usage: 4,
                            usageMonthly: 4,
                        },
                        synthetic: {
                            rollingFiveHourLimit: {
                                limited: false,
                                max: 100,
                                nextTickAt: "2026-06-24T11:00:00.000Z",
                                percentUsed: 97,
                                remaining: 3,
                                tickPercent: 0.25,
                            },
                            searchHourly: {
                                limit: 100,
                                percentUsed: 10,
                                remaining: 90,
                                renewsAt: "2026-06-24T11:00:00.000Z",
                                requests: 10,
                            },
                            subscription: {
                                limit: 100,
                                percentUsed: 10,
                                remaining: 90,
                                renewsAt: "2026-06-25T10:00:00.000Z",
                                requests: 10,
                            },
                            weeklyTokenLimit: {
                                nextRegenAt: "bad-date",
                                nextRegenCredits: "50",
                                percentRemaining: 10,
                            },
                        },
                    }}
                />
                <QuotaOverviewCard
                    quotas={{
                        cacheAgeMs: 0,
                        checkedAt: 1_719_216_000_000,
                        elevenlabs: { note: "usage unavailable", status: "error" },
                        openai: { note: "not signed in", status: "not_configured" },
                        openrouter: { note: "offline", status: "error" },
                        synthetic: { note: "unknown", status: "error" },
                    }}
                />
                <ConfigSection
                    selectedPath="config:openclaw.json"
                    onSelect={onConfigSelect}
                />
                <FileTreeItem
                    node={{
                        children: [
                            {
                                name: "b.ts",
                                path: "src/b.ts",
                                size: 1,
                                type: "file",
                            },
                            {
                                children: [],
                                loaded: true,
                                name: "nested",
                                path: "src/nested",
                                type: "directory",
                            },
                            {
                                name: "image.png",
                                path: "src/image.png",
                                size: 1,
                                type: "file",
                            },
                        ],
                        loaded: true,
                        name: "src",
                        path: "src",
                        type: "directory",
                    }}
                    selectedPath="src/b.ts"
                    expandedPaths={new Set(["src"])}
                    onSelect={onTreeSelect}
                    onToggle={onTreeToggle}
                />
                <FileTreeItem
                    node={{
                        children: [],
                        loaded: false,
                        name: "loading",
                        path: "loading",
                        type: "directory",
                    }}
                    selectedPath={undefined}
                    expandedPaths={new Set(["loading"])}
                    onSelect={onTreeSelect}
                    onToggle={onTreeToggle}
                />
            </QueryClientProvider>
        );

        await waitFor(() => {
            expect(screen.getByText("Log rotation")).toBeInTheDocument();
            expect(screen.getByText("Cron jobs")).toBeInTheDocument();
        });

        await user.click(screen.getByRole("button", { name: "hooks" }));
        await user.click(screen.getByRole("button", { name: "agentmail.ts" }));
        await user.click(screen.getByRole("button", { name: "openclaw.json" }));
        await user.click(screen.getByRole("button", { name: "src" }));
        await user.click(screen.getByRole("button", { name: "b.ts" }));
        await user.click(screen.getByRole("button", { name: "Run dry-run now" }));
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/ops/log-rotation/dry-run",
                expect.objectContaining({ method: "POST" })
            );
        });
        await user.click(screen.getByRole("button", { name: "Run real now" }));

        await waitFor(() => {
            expect(onConfigSelect).toHaveBeenCalledWith(
                "config:hooks/transforms/agentmail.ts"
            );
            expect(onConfigSelect).toHaveBeenCalledWith("config:openclaw.json");
            expect(onTreeToggle).toHaveBeenCalledWith("src");
            expect(onTreeSelect).toHaveBeenCalledWith("src/b.ts");
            expect(
                screen.getAllByText(/unavailable|rate limited|unknown/).length
            ).toBeGreaterThan(0);
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/ops/log-rotation/run",
                expect.objectContaining({ method: "POST" })
            );
        });

        unmount();
        queryClient.clear();
    });

    it("drives settings lists, task history, and file editor panel states", async () => {
        const user = userEvent.setup();
        const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === "/api/agents/tasks/history?limit=7") {
                return Response.json({
                    tasks: [
                        {
                            agentId: "mira-2026",
                            completedAt: "2026-06-24T11:00:00.000Z",
                            id: 1,
                            status: "done",
                            task: "Expand tests",
                        },
                    ],
                });
            }

            throw new Error(`Unexpected settings component fetch: ${url}`);
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const onSaveChannels = jest.fn(async () => {});
        const onSaveAgents = jest.fn(async () => {});
        const onToggleSkill = jest.fn();
        const onSaveFile = jest.fn();
        const onContentChange = jest.fn();
        const onMarkdownPreviewChange = jest.fn();
        const onJsonPreviewChange = jest.fn();
        const onCodePreviewChange = jest.fn();

        const { queryClient, rerender } = renderWithQueryClient(
            <>
                <TaskHistorySidebar />
                <ChannelSection
                    channels={[
                        {
                            details: "direct",
                            enabled: true,
                            id: "webchat",
                            policy: "trusted",
                        },
                        { enabled: false, id: "discord" },
                    ]}
                    onSave={onSaveChannels}
                    saving={false}
                />
                <SkillsSection
                    skills={[
                        {
                            description: "Workspace skill",
                            enabled: true,
                            name: "dashboard",
                            source: "workspace",
                        },
                        {
                            description: "Built in skill",
                            enabled: false,
                            name: "browser",
                            source: "builtin",
                        },
                        {
                            enabled: false,
                            name: "extra-tool",
                            source: "extra",
                        },
                    ]}
                    onToggle={onToggleSkill}
                />
                <AgentAccessSection
                    agents={[
                        {
                            id: "mira-2026",
                            name: "Mira",
                            tools: { deny: ["web_search"] },
                        },
                        {
                            id: "researcher",
                            name: "Researcher",
                            tools: { allow: ["web_search"] },
                        },
                    ]}
                    onSave={onSaveAgents}
                    saving={false}
                />
                <FileEditorPanel
                    selectedPath={undefined}
                    contentLoading={false}
                    isEditable={false}
                    hasChanges={false}
                    savePending={false}
                    editedContent=""
                    largeFileWarning={false}
                    markdownPreview={false}
                    jsonPreview={false}
                    codeEditMode={false}
                    syntaxClass=""
                    isJsonEditing={false}
                    jsonValidation={{ error: undefined, valid: true }}
                    onSave={onSaveFile}
                    onContentChange={onContentChange}
                    onMarkdownPreviewChange={onMarkdownPreviewChange}
                    onJsonPreviewChange={onJsonPreviewChange}
                    onCodePreviewChange={onCodePreviewChange}
                />
            </>
        );

        await waitFor(() => {
            expect(screen.getByText("Expand tests")).toBeInTheDocument();
        });
        expect(screen.getByText("Select a file to view")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Channels" }));
        await user.click(screen.getByLabelText("discord"));
        await user.click(screen.getByRole("button", { name: "Save channels" }));
        expect(onSaveChannels).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ enabled: true, id: "discord" }),
            ])
        );

        await user.click(screen.getByRole("button", { name: "Skills" }));
        await user.type(screen.getByPlaceholderText("Search skills..."), "browser");
        await user.click(screen.getByRole("button", { name: "disabled" }));
        await user.click(screen.getByRole("button", { name: "Built-in 1 skills" }));
        await user.click(screen.getAllByRole("switch").at(-1)!);
        expect(onToggleSkill).toHaveBeenCalledWith("browser", true);

        await user.click(screen.getByRole("button", { name: "Agent access control" }));
        await user.type(screen.getByPlaceholderText("Filter tools..."), "web search");
        await user.click(screen.getByText("Researcher"));
        await user.click(screen.getAllByRole("switch").at(-1)!);
        await user.click(screen.getByRole("button", { name: "Save access control" }));
        const latestSaveCall = onSaveAgents.mock.calls.at(-1) as
            | [Array<{ id: string; tools?: { allow?: string[] } }>]
            | undefined;
        const savedAgents = latestSaveCall?.[0] ?? [];
        expect(savedAgents).toContainEqual(
            expect.objectContaining({
                id: "researcher",
                tools: expect.objectContaining({ allow: [] }),
            })
        );

        rerender(
            <QueryClientProvider client={queryClient}>
                <FileEditorPanel
                    selectedPath="config:openclaw.json"
                    fileContent={{
                        content: "{bad json",
                        isBinary: false,
                        modified: "",
                        path: "config:openclaw.json",
                        size: 9,
                    }}
                    contentLoading={false}
                    isEditable={true}
                    hasChanges={true}
                    savePending={false}
                    editedContent="{bad json"
                    largeFileWarning={false}
                    markdownPreview={false}
                    jsonPreview={false}
                    codeEditMode={false}
                    syntaxClass="syntax-test"
                    isJsonEditing={true}
                    jsonValidation={{ error: "Expected brace", valid: false }}
                    onSave={onSaveFile}
                    onContentChange={onContentChange}
                    onMarkdownPreviewChange={onMarkdownPreviewChange}
                    onJsonPreviewChange={onJsonPreviewChange}
                    onCodePreviewChange={onCodePreviewChange}
                />
            </QueryClientProvider>
        );
        expect(screen.getByText("Invalid JSON")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();

        rerender(
            <QueryClientProvider client={queryClient}>
                <FileEditorPanel
                    selectedPath="src/readme.md"
                    fileContent={{
                        content: "# Hello",
                        isBinary: false,
                        modified: "2026-06-24T11:00:00.000Z",
                        path: "src/readme.md",
                        size: 7,
                    }}
                    contentLoading={false}
                    isEditable={true}
                    hasChanges={true}
                    savePending={true}
                    editedContent="# Hello"
                    largeFileWarning={false}
                    markdownPreview={false}
                    jsonPreview={false}
                    codeEditMode={false}
                    syntaxClass=""
                    isJsonEditing={false}
                    jsonValidation={{ error: undefined, valid: true }}
                    onSave={onSaveFile}
                    onContentChange={onContentChange}
                    onMarkdownPreviewChange={onMarkdownPreviewChange}
                    onJsonPreviewChange={onJsonPreviewChange}
                    onCodePreviewChange={onCodePreviewChange}
                />
            </QueryClientProvider>
        );
        await user.click(screen.getByRole("button", { name: "Preview" }));
        expect(onMarkdownPreviewChange).toHaveBeenCalledWith(true);
        expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
        queryClient.clear();
    });

    it("drives sessions table row actions and empty state", async () => {
        const user = userEvent.setup();
        const onCompact = jest.fn();
        const onReset = jest.fn();
        const onDelete = jest.fn();
        const session = {
            agentType: "codex",
            channel: "web",
            createdAt: "2026-06-24T10:00:00.000Z",
            displayLabel: "Main Session",
            displayName: "Main Session",
            hookName: "",
            id: "session-1",
            key: "agent:main:main",
            kind: "agent",
            label: "Main",
            maxTokens: 1000,
            model: "codex",
            tokenCount: 125,
            type: "agent",
            updatedAt: Date.now(),
        };

        const { rerender } = render(
            <SessionsTable
                sessions={[]}
                onCompact={onCompact}
                onReset={onReset}
                onDelete={onDelete}
            />
        );
        expect(screen.getByText("No sessions found")).toBeInTheDocument();

        rerender(
            <SessionsTable
                sessions={[session]}
                onCompact={onCompact}
                onReset={onReset}
                onDelete={onDelete}
            />
        );
        expect(screen.getAllByText("Main Session").length).toBeGreaterThan(0);
        await user.click(
            screen.getAllByRole("button", { name: /actions for main/i })[0]!
        );
        await user.click(screen.getByRole("menuitem", { name: /compact/i }));
        await user.click(
            screen.getAllByRole("button", { name: /actions for main/i })[0]!
        );
        await user.click(screen.getByRole("menuitem", { name: /reset/i }));
        await user.click(
            screen.getAllByRole("button", { name: /actions for main/i })[0]!
        );
        await user.click(screen.getByRole("menuitem", { name: /delete/i }));
        expect(onCompact).toHaveBeenCalledWith("agent:main:main");
        expect(onReset).toHaveBeenCalledWith("agent:main:main");
        expect(onDelete).toHaveBeenCalledWith(session);
    });

    it("drives cron job details controls and edit form", async () => {
        const user = userEvent.setup();
        const job = {
            delivery: { mode: "webhook" },
            enabled: true,
            id: "heartbeat",
            name: "Heartbeat",
            payload: { kind: "ping" },
            schedule: { kind: "interval", seconds: 60 },
            state: {
                lastRunAtMs: 1_719_216_000_000,
                lastRunStatus: "success",
                nextRunAtMs: 1_719_219_600_000,
            },
        };
        const onToggle = jest.fn();
        const onRunNow = jest.fn();
        const onDelete = jest.fn();
        const onEditModeChange = jest.fn();
        const onNameDraftChange = jest.fn();
        const onScheduleDraftChange = jest.fn();
        const onPayloadDraftChange = jest.fn();
        const onDeliveryDraftChange = jest.fn();
        const onSave = jest.fn();

        const { rerender } = render(
            <CronJobDetails
                job={job}
                lastTriggeredAt={1_719_216_000_000}
                togglePending={false}
                runPending={false}
                updatePending={false}
                deletePending={false}
                onToggle={onToggle}
                onRunNow={onRunNow}
                onDelete={onDelete}
                isEditMode={false}
                onEditModeChange={onEditModeChange}
                nameDraft="Heartbeat"
                onNameDraftChange={onNameDraftChange}
                scheduleDraft="{}"
                onScheduleDraftChange={onScheduleDraftChange}
                payloadDraft="{}"
                onPayloadDraftChange={onPayloadDraftChange}
                deliveryDraft="{}"
                onDeliveryDraftChange={onDeliveryDraftChange}
                scheduleValidation={{ error: undefined, valid: true }}
                payloadValidation={{ error: undefined, valid: true }}
                deliveryValidation={{ error: undefined, valid: true }}
                hasInvalidJson={false}
                editError={undefined}
                onSave={onSave}
                formatDate={(value) => `date:${value}`}
            />
        );

        await user.click(screen.getByRole("switch", { name: /enabled/i }));
        await user.click(screen.getByRole("button", { name: /trigger now/i }));
        await user.click(screen.getByRole("button", { name: /delete/i }));
        await user.click(screen.getByRole("button", { name: /edit/i }));
        expect(onToggle).toHaveBeenCalledWith(job, false);
        expect(onRunNow).toHaveBeenCalledWith(job);
        expect(onDelete).toHaveBeenCalledWith(job);
        expect(onEditModeChange).toHaveBeenCalledWith(true);

        rerender(
            <CronJobDetails
                job={job}
                lastTriggeredAt={undefined}
                togglePending={false}
                runPending={true}
                updatePending={false}
                deletePending={false}
                onToggle={onToggle}
                onRunNow={onRunNow}
                onDelete={onDelete}
                isEditMode={true}
                onEditModeChange={onEditModeChange}
                nameDraft="Heartbeat"
                onNameDraftChange={onNameDraftChange}
                scheduleDraft="{bad"
                onScheduleDraftChange={onScheduleDraftChange}
                payloadDraft="{}"
                onPayloadDraftChange={onPayloadDraftChange}
                deliveryDraft="{}"
                onDeliveryDraftChange={onDeliveryDraftChange}
                scheduleValidation={{ error: "bad", valid: false }}
                payloadValidation={{ error: undefined, valid: true }}
                deliveryValidation={{ error: undefined, valid: true }}
                hasInvalidJson={true}
                editError="Save failed"
                onSave={onSave}
                formatDate={(value) => `date:${value}`}
            />
        );

        fireEvent.change(screen.getByLabelText("Name"), {
            target: { value: "New heartbeat" },
        });
        fireEvent.change(screen.getByLabelText("Schedule (JSON)"), {
            target: { value: '{"kind":"daily"}' },
        });
        fireEvent.change(screen.getByLabelText("Payload (JSON)"), {
            target: { value: '{"ok":true}' },
        });
        fireEvent.change(screen.getByLabelText("Delivery (JSON)"), {
            target: { value: '{"mode":"webhook"}' },
        });
        await user.click(screen.getByRole("button", { name: /cancel/i }));
        await user.click(screen.getByRole("button", { name: /save edits/i }));
        expect(onNameDraftChange).toHaveBeenCalledWith("New heartbeat");
        expect(onScheduleDraftChange).toHaveBeenCalledWith('{"kind":"daily"}');
        expect(onPayloadDraftChange).toHaveBeenCalledWith('{"ok":true}');
        expect(onDeliveryDraftChange).toHaveBeenCalledWith('{"mode":"webhook"}');
        expect(onEditModeChange).toHaveBeenCalledWith(false);
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText("Invalid JSON: bad")).toBeInTheDocument();
        expect(screen.getByText("Save failed")).toBeInTheDocument();
        expect(screen.getByText("Running job...")).toBeInTheDocument();
    });

    it("drives database table shells, autovacuum cards, and top query modal copy", async () => {
        const user = userEvent.setup();
        const onRowClick = jest.fn();
        const writeText = jest.fn(async () => {});
        const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
            navigator,
            "clipboard"
        );
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });

        try {
            const { rerender } = render(
                <DatabaseTableShell
                    data={[]}
                    columns={[]}
                    emptyMessage="Nothing here"
                    onRowClick={onRowClick}
                />
            );
            expect(screen.getByText("Nothing here")).toBeInTheDocument();

            rerender(
                <AutovacuumHealthTable
                    data={[
                        {
                            dead_pct: "12.5",
                            last_autoanalyze: "",
                            last_autovacuum: "",
                            n_dead_tup: "42",
                            n_live_tup: "100",
                            relname: "tasks",
                            schemaname: "public",
                        },
                    ]}
                />
            );
            expect(screen.getAllByText("public.tasks").length).toBeGreaterThan(0);
            expect(screen.getAllByText("12.5%").length).toBeGreaterThan(0);

            rerender(<TopQueriesTable enabled={false} data={[]} />);
            expect(
                screen.getByText("pg_stat_statements is not enabled.")
            ).toBeInTheDocument();

            const query = "select * from task_history where agent_id = 'mira-2026'";
            rerender(
                <TopQueriesTable
                    enabled={true}
                    data={[
                        {
                            calls: "7",
                            mean_exec_time: "2.5",
                            query,
                            rows: "3",
                            shared_blks_hit: "10",
                            shared_blks_read: "1",
                            total_exec_time: "17.5",
                        },
                    ]}
                />
            );

            await user.click(screen.getAllByText(/select \*/i)[0]!);
            expect(screen.getByText("Query details")).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: /copy query/i }));
            expect(writeText).toHaveBeenCalledWith(query);
            expect(
                await screen.findByRole("button", { name: /copied/i })
            ).toBeInTheDocument();
        } finally {
            if (originalClipboardDescriptor) {
                Object.defineProperty(
                    navigator,
                    "clipboard",
                    originalClipboardDescriptor
                );
            } else {
                delete (navigator as { clipboard?: Clipboard }).clipboard;
            }
        }
    });

    it("drives backup overview attention, clear, and run actions", async () => {
        const user = userEvent.setup();
        let mode: "attention" | "idle" = "attention";
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (method === "POST") {
                    return Response.json({
                        cleared: { id: "cleared", status: "done" },
                        isOk: true,
                        job: { id: "started", status: "running" },
                    });
                }

                if (url === "/api/backups/kopia" || url === "/api/backups/walg") {
                    const type = url.endsWith("walg") ? "walg" : "kopia";
                    return Response.json({
                        job:
                            mode === "attention"
                                ? {
                                      code: 1,
                                      endedAt: 1_719_216_010_000,
                                      id: `${type}-attention`,
                                      startedAt: 1_719_216_000_000,
                                      status: "needs_attention",
                                      stderr: `${type} stderr`,
                                      stdout: "",
                                      type,
                                  }
                                : {
                                      code: 0,
                                      endedAt: 1_719_216_010_000,
                                      id: `${type}-done`,
                                      startedAt: 1_719_216_000_000,
                                      status: "done",
                                      stderr: "",
                                      stdout: "",
                                      type,
                                  },
                    });
                }

                if (url === "/api/cache/backup.kopia.status") {
                    return Response.json({
                        consecutiveFailures: 0,
                        data: {
                            isOk: mode === "idle",
                            snapshotsByPath: [
                                {
                                    latest: undefined,
                                    path: "/source/docker",
                                    snapshotCount: 2,
                                    snapshots: [
                                        {
                                            description: "Daily Docker backup",
                                            endTime: "2026-06-24T08:00:00.000Z",
                                            errorCount: 0,
                                            fileCount: 12,
                                            id: "snap-1",
                                            ignoredErrorCount: 0,
                                            path: "/source/docker",
                                            retentionReason: ["daily"],
                                            startTime: "2026-06-24T07:59:00.000Z",
                                            totalSize: 2048,
                                        },
                                        {
                                            description: undefined,
                                            endTime: undefined,
                                            errorCount: undefined,
                                            fileCount: undefined,
                                            id: undefined,
                                            ignoredErrorCount: undefined,
                                            path: "/source/projects",
                                            retentionReason: [],
                                            startTime: undefined,
                                            totalSize: undefined,
                                        },
                                    ],
                                },
                            ],
                            stale: [{ path: "/source/docker" }],
                        },
                        errorCode: undefined,
                        errorMessage: undefined,
                        expiresAt: undefined,
                        key: "backup.kopia.status",
                        lastAttemptAt: undefined,
                        meta: {},
                        source: "backup",
                        status: mode === "idle" ? "fresh" : "warning",
                        updatedAt: "2026-06-24T08:00:00.000Z",
                    });
                }

                if (url === "/api/cache/backup.walg.status") {
                    return Response.json({
                        consecutiveFailures: 0,
                        data: {
                            backupCount: 3,
                            isOk: mode === "idle",
                            latest: {
                                backupName: "base_0001",
                                modified: "2026-06-24T08:00:00.000Z",
                                walFileName: "000000010000000000000001",
                            },
                        },
                        errorCode: undefined,
                        errorMessage: undefined,
                        expiresAt: undefined,
                        key: "backup.walg.status",
                        lastAttemptAt: undefined,
                        meta: {},
                        source: "backup",
                        status: mode === "idle" ? "fresh" : "warning",
                        updatedAt: "2026-06-24T08:00:00.000Z",
                    });
                }

                throw new Error(`Unexpected backup test fetch: ${method} ${url}`);
            }
        );

        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const attentionView = renderWithQueryClient(<BackupOverviewCard />);
        expect(await screen.findByText("Backup needs attention")).toBeInTheDocument();
        expect(screen.getByText("Postgres backup needs attention")).toBeInTheDocument();
        expect(screen.getByText("Daily Docker backup")).toBeInTheDocument();
        expect(screen.getByText("Stale")).toBeInTheDocument();
        expect(screen.getByText("2.0 KB")).toBeInTheDocument();

        const clearButtons = screen.getAllByRole("button", {
            name: /clear attention/i,
        });
        await user.click(clearButtons[0]!);
        await user.click(clearButtons[1]!);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/backups/walg/clear-needs-attention",
            expect.objectContaining({ method: "POST" })
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/backups/kopia/clear-needs-attention",
            expect.objectContaining({ method: "POST" })
        );
        attentionView.unmount();
        attentionView.queryClient.clear();

        mode = "idle";
        const idleView = renderWithQueryClient(<BackupOverviewCard />);
        expect(await screen.findByText("base_0001")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /run postgres backup/i }));
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/backups/walg/run",
                expect.objectContaining({ method: "POST" })
            );
        });

        await user.click(screen.getByRole("button", { name: /run filesystem backup/i }));
        expect(screen.getByText("Run backup now")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /^run backup$/i }));
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/backups/kopia/run",
                expect.objectContaining({ method: "POST" })
            );
        });
        idleView.unmount();
        idleView.queryClient.clear();
    });

    it("drives service action confirmation, exec polling, and cache refresh", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/cache/system.host" && method === "GET") {
                    return Response.json({
                        consecutiveFailures: 0,
                        data: {
                            version: {
                                current: "2026.6.1",
                                latest: "2026.6.2",
                                updateAvailable: true,
                            },
                        },
                        errorCode: undefined,
                        errorMessage: undefined,
                        expiresAt: undefined,
                        key: "system.host",
                        lastAttemptAt: undefined,
                        meta: {},
                        source: "system",
                        status: "fresh",
                        updatedAt: "2026-06-24T08:00:00.000Z",
                    });
                }

                if (url === "/api/exec/start" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        command: "$HOME/.local/bin/openclaw update --yes",
                        shell: true,
                    });
                    return Response.json({ jobId: "ops-job-1" });
                }

                if (url === "/api/exec/ops-job-1" && method === "GET") {
                    return Response.json({
                        code: 0,
                        endedAt: 1_719_216_030_000,
                        jobId: "ops-job-1",
                        startedAt: 1_719_216_000_000,
                        status: "done",
                        stderr: "",
                        stdout: "updated openclaw",
                    });
                }

                if (url === "/api/cache/system.host/refresh" && method === "POST") {
                    return Response.json({
                        entry: {
                            data: {
                                version: {
                                    current: "2026.6.2",
                                    latest: "2026.6.2",
                                    updateAvailable: false,
                                },
                            },
                            key: "system.host",
                        },
                        isOk: true,
                    });
                }

                throw new Error(`Unexpected service action test fetch: ${method} ${url}`);
            }
        );

        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const view = renderWithQueryClient(<ServiceActionsCard />);
        expect(
            await screen.findByText(
                "New OpenClaw version available (2026.6.1 -> 2026.6.2)."
            )
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /update openclaw/i }));
        expect(
            screen.getByText("Update OpenClaw to latest version now?")
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /^update openclaw$/i }));

        expect(await screen.findByText("updated openclaw")).toBeInTheDocument();
        expect(screen.getByText(/Last run: Update OpenClaw/i)).toBeInTheDocument();
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/system.host/refresh",
                expect.objectContaining({ method: "POST" })
            );
        });
        view.unmount();
        view.queryClient.clear();
    });

    it("drives settings section forms, switches, and selectors", async () => {
        const onSaveModel = jest.fn(async () => {});
        const onSaveTools = jest.fn(async () => {});
        const onSaveHeartbeat = jest.fn(async () => {});
        const onSaveSession = jest.fn(async () => {});

        render(
            <>
                <ModelSection
                    defaultModel="codex"
                    fallbacks={["glm51", "kimi"]}
                    imageModel={undefined}
                    imageGenerationModel="gpt-image"
                    onSave={onSaveModel}
                    saving={false}
                />
                <ToolSection
                    profile="full"
                    webSearchEnabled={true}
                    webSearchProvider="brave"
                    webFetchEnabled={false}
                    execSecurity="allowlist"
                    execAsk="on-miss"
                    elevatedEnabled={false}
                    agentToAgentEnabled={true}
                    sessionsVisibility="all"
                    onSave={onSaveTools}
                    saving={false}
                />
                <HeartbeatSection
                    every={1800}
                    target="main"
                    onSave={onSaveHeartbeat}
                    saving={false}
                />
                <SessionSection idleMinutes={60} onSave={onSaveSession} saving={false} />
                <ModelSection
                    defaultModel=""
                    fallbacks={[]}
                    onSave={jest.fn(async () => {})}
                    saving={true}
                />
                <ToolSection
                    webSearchEnabled={false}
                    webSearchProvider=""
                    webFetchEnabled={false}
                    execSecurity="deny"
                    execAsk="off"
                    elevatedEnabled={false}
                    agentToAgentEnabled={false}
                    onSave={jest.fn(async () => {})}
                    saving={true}
                />
            </>
        );

        for (const name of ["Model Configuration", "Tools", "Heartbeat", "Session"]) {
            expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
        }
        expect(onSaveModel).not.toHaveBeenCalled();
        expect(onSaveTools).not.toHaveBeenCalled();
        expect(onSaveHeartbeat).not.toHaveBeenCalled();
        expect(onSaveSession).not.toHaveBeenCalled();
    });

    it("drives docker image and volume table actions", async () => {
        const user = userEvent.setup();
        const onDeleteImage = jest.fn();
        const onPruneImages = jest.fn();
        const onDeleteVolume = jest.fn();
        const onPruneVolumes = jest.fn();

        const { rerender } = render(
            <DockerImagesTable
                images={[]}
                onDelete={onDeleteImage}
                onPruneUnused={onPruneImages}
            />
        );
        expect(screen.getByText("No images found.")).toBeInTheDocument();

        rerender(
            <DockerImagesTable
                images={[
                    {
                        containerName: "",
                        createdAt: "2026-06-24T10:00:00.000Z",
                        id: "img-unused",
                        inUseBy: [],
                        lastTagTime: "2026-06-24T10:00:00.000Z",
                        platform: "linux/amd64",
                        repository: "local/app",
                        size: 1024,
                        tag: "",
                    },
                    {
                        containerName: "api",
                        createdAt: "2026-06-24T10:00:00.000Z",
                        id: "img-used",
                        inUseBy: ["api"],
                        lastTagTime: "2026-06-24T10:00:00.000Z",
                        platform: "linux/amd64",
                        repository: "local/api",
                        size: 2048,
                        tag: "latest",
                    },
                ]}
                onDelete={onDeleteImage}
                onPruneUnused={onPruneImages}
            />
        );
        await user.click(screen.getByRole("button", { name: /remove unused/i }));
        await user.click(
            screen.getAllByRole("button", { name: /delete local\/app/i })[0]!
        );
        expect(onPruneImages).toHaveBeenCalledTimes(1);
        expect(onDeleteImage).toHaveBeenCalledWith("img-unused", "local/app:<none>");

        rerender(
            <DockerVolumesTable
                volumes={[]}
                onDelete={onDeleteVolume}
                onPruneUnused={onPruneVolumes}
            />
        );
        expect(screen.getByText("No volumes found.")).toBeInTheDocument();

        const longVolume =
            "dashboard_data_volume_with_a_very_long_name_for_middle_truncation";
        rerender(
            <DockerVolumesTable
                volumes={[
                    {
                        driver: "local",
                        labels: {},
                        mountpoint:
                            "/var/lib/docker/volumes/dashboard_data_volume_with_a_very_long_name/_data",
                        name: longVolume,
                        scope: "local",
                        size: "1 KiB",
                        usedBy: [],
                    },
                    {
                        driver: "local",
                        labels: {},
                        mountpoint: "/var/lib/docker/volumes/api/_data",
                        name: "api-data",
                        scope: "local",
                        size: "2 KiB",
                        usedBy: ["api"],
                    },
                ]}
                onDelete={onDeleteVolume}
                onPruneUnused={onPruneVolumes}
            />
        );
        await user.click(screen.getByRole("button", { name: /remove unused/i }));
        await user.click(
            screen.getAllByRole("button", {
                name: new RegExp(`delete ${longVolume}`, "i"),
            })[0]!
        );
        expect(onPruneVolumes).toHaveBeenCalledTimes(1);
        expect(onDeleteVolume).toHaveBeenCalledWith(longVolume);
        expect(screen.getAllByText("Used").length).toBeGreaterThan(0);
    });

    it("drives docker container table sorting, mobile actions, and formatters", async () => {
        const user = userEvent.setup();
        const onDetails = jest.fn();
        const onLogs = jest.fn();
        const onConsole = jest.fn();
        const onRestart = jest.fn();
        const onRestartStack = jest.fn();

        expect(formatBytes(NaN)).toBe("0 B");
        expect(formatBytes(1536)).toBe("1.5 KB");
        expect(formatDockerMemory(undefined)).toBe("—");
        expect(formatDockerMemory("bad")).toBe("bad");
        expect(formatDockerMemory("512 MiB / 1 GiB")).toBe("512 MB / 1.0 GB");
        expect(formatTimestamp(undefined)).toBe("—");
        expect(formatTimestamp("not-a-date")).toBe("not-a-date");
        expect(formatVersionDisplay(undefined, "sha256:abcdef1234567890")).toBe(
            "sha256:abcde"
        );
        expect(formatVersionDisplay(undefined, undefined)).toBe("—");
        expect(formatFullVersionDisplay("v1", "digest")).toBe("v1 (digest)");
        expect(formatFullVersionDisplay(undefined, "digest")).toBe("digest");
        expect(
            formatUpdaterTransition({
                fromDigest: "from-digest",
                fromTag: undefined,
                toDigest: undefined,
                toTag: "latest",
            })
        ).toBe("from-digest → latest");

        const { rerender } = render(
            <DockerContainersTable
                containers={[]}
                onConsole={onConsole}
                onDetails={onDetails}
                onLogs={onLogs}
                onRestart={onRestart}
                onRestartStack={onRestartStack}
            />
        );
        expect(screen.getByText("No containers found.")).toBeInTheDocument();

        rerender(
            <DockerContainersTable
                containers={[
                    {
                        command: "node server.js",
                        createdAt: "2026-06-24T08:00:00.000Z",
                        finishedAt: undefined,
                        health: "healthy",
                        id: "running",
                        image: "local/running:latest",
                        imageId: "image-running",
                        ipAddresses: {},
                        mounts: [],
                        name: "running-api",
                        ports: ["3100/tcp"],
                        project: "mira",
                        restartCount: 1,
                        runningFor: "2 hours",
                        service: "api",
                        startedAt: "2026-06-24T08:00:00.000Z",
                        state: "running",
                        stats: {
                            blockIO: "0 B / 0 B",
                            cpu: "12.5%",
                            memory: "256 MiB / 1 GiB",
                            memoryPercent: "25%",
                            netIO: "1 KB / 2 KB",
                            pids: "12",
                        },
                        status: "Up",
                    },
                    {
                        command: "sleep 1",
                        createdAt: "2026-06-24T07:00:00.000Z",
                        finishedAt: "2026-06-24T07:01:00.000Z",
                        health: "unhealthy",
                        id: "exited",
                        image: "local/exited:latest",
                        imageId: "image-exited",
                        ipAddresses: {},
                        mounts: [],
                        name: "exited-worker",
                        ports: [],
                        project: undefined,
                        restartCount: 3,
                        runningFor: "",
                        service: undefined,
                        startedAt: undefined,
                        state: "exited",
                        stats: {
                            blockIO: "0 B / 0 B",
                            cpu: "bad cpu",
                            memory: "bad memory",
                            memoryPercent: "bad percent",
                            netIO: "0 B / 0 B",
                            pids: "0",
                        },
                        status: "Exited",
                    },
                    {
                        command: "worker",
                        createdAt: "2026-06-24T06:00:00.000Z",
                        finishedAt: undefined,
                        health: "unknown",
                        id: "created",
                        image: "local/created:latest",
                        imageId: "image-created",
                        ipAddresses: {},
                        mounts: [],
                        name: "created-worker",
                        ports: [],
                        project: undefined,
                        restartCount: 0,
                        runningFor: "",
                        service: undefined,
                        startedAt: undefined,
                        state: "created",
                        stats: undefined,
                        status: "Created",
                    },
                ]}
                onConsole={onConsole}
                onDetails={onDetails}
                onLogs={onLogs}
                onRestart={onRestart}
                onRestartStack={onRestartStack}
            />
        );

        await user.click(screen.getByRole("button", { name: /restart stack/i }));
        expect(onRestartStack).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "State" }));
        await user.click(screen.getByRole("button", { name: "Health" }));
        await user.click(screen.getByRole("button", { name: "CPU" }));
        await user.click(screen.getByRole("button", { name: "Memory" }));
        const sortedDesktopRows = screen.getAllByRole("row").slice(1);
        expect(sortedDesktopRows.map((row) => row.textContent || "")).toEqual([
            expect.stringContaining("running-api"),
            expect.stringContaining("exited-worker"),
            expect.stringContaining("created-worker"),
        ]);

        await user.click(screen.getAllByLabelText(/show logs for running-api/i)[0]!);
        await user.click(screen.getAllByLabelText(/open console for running-api/i)[0]!);
        await user.click(screen.getAllByLabelText(/restart running-api/i)[0]!);
        expect(onLogs).toHaveBeenCalledWith("running");
        expect(onConsole).toHaveBeenCalledWith("running");
        expect(onRestart).toHaveBeenCalledWith("running");

        await user.click(screen.getAllByText("running-api")[0]!);
        expect(onDetails).toHaveBeenCalledWith("running");

        fireEvent.keyDown(screen.getByLabelText(/open details for exited-worker/i), {
            key: "Escape",
        });
        fireEvent.keyDown(screen.getByLabelText(/open details for exited-worker/i), {
            key: "Enter",
        });
        fireEvent.keyDown(screen.getByLabelText(/open details for created-worker/i), {
            key: " ",
        });
        expect(onDetails).toHaveBeenCalledWith("exited");
        expect(onDetails).toHaveBeenCalledWith("created");
    });
});
