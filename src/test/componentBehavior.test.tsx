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

import { TaskHistorySidebar } from "../components/features/agents/TaskHistorySidebar";
import { AttachmentPreviewModal } from "../components/features/chat/AttachmentPreviewModal";
import { ChatComposer } from "../components/features/chat/ChatComposer";
import { ChatHeader } from "../components/features/chat/ChatHeader";
import {
    ChatMarkdown,
    childrenToText,
    getPreCodeBlock,
    markdownComponents,
} from "../components/features/chat/ChatMarkdown";
import { ChatMessageDetails } from "../components/features/chat/ChatMessageDetails";
import {
    AttachmentIcon,
    base64ToText as messageListBase64ToText,
    ChatMessagesList,
    previewFromAttachment,
} from "../components/features/chat/ChatMessagesList";
import {
    type ActiveChatStreams,
    createChatVisibility,
    mergeStreamMessage,
} from "../components/features/chat/chatRuntime";
import {
    type ChatHistoryMessage,
    normalizeVisibleChatHistoryMessages,
} from "../components/features/chat/chatTypes";
import { chatThinkingOptions } from "../components/features/chat/chatUtilities";
import {
    mergeWithRecentOptimisticMessages,
    messageIdentity,
} from "../components/features/chat/chatUtilities";
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
} from "../components/features/chat/useChatRuntimeEvents";
import { useChatSlashCommands } from "../components/features/chat/useChatSlashCommands";
import { CronJobDetails } from "../components/features/cron/CronJobDetails";
import { CronJobList } from "../components/features/cron/CronJobList";
import { BackupOverviewCard } from "../components/features/dashboard/BackupOverviewCard";
import { CacheStatusCard } from "../components/features/dashboard/CacheStatusCard";
import { DatabaseOverviewCard } from "../components/features/dashboard/DatabaseOverviewCard";
import { DockerOverviewCard } from "../components/features/dashboard/DockerOverviewCard";
import { JobsOverviewCard } from "../components/features/dashboard/JobsOverviewCard";
import { LogRotationCard } from "../components/features/dashboard/LogRotationCard";
import { QuotaOverviewCard } from "../components/features/dashboard/QuotaOverviewCard";
import { ReportsOverviewCard } from "../components/features/dashboard/ReportsOverviewCard";
import { ServiceActionsCard } from "../components/features/dashboard/ServiceActionsCard";
import { AutovacuumHealthTable } from "../components/features/database/AutovacuumHealthTable";
import { DatabasesTable } from "../components/features/database/DatabaseSizesTable";
import { DatabaseTableShell } from "../components/features/database/DatabaseTableShell";
import { PgBouncerPoolsTable } from "../components/features/database/PgBouncerPoolsTable";
import { PgBouncerStatsTable } from "../components/features/database/PgBouncerStatsTable";
import { TopQueriesTable } from "../components/features/database/TopQueriesTable";
import { DockerContainersTable } from "../components/features/docker/DockerContainersTable";
import {
    formatBytes,
    formatDockerMemory,
    formatFullVersionDisplay,
    formatTimestamp,
    formatUpdaterTransition,
    formatVersionDisplay,
} from "../components/features/docker/dockerFormatters";
import { DockerImagesTable } from "../components/features/docker/DockerImagesTable";
import { DockerVolumesTable } from "../components/features/docker/DockerVolumesTable";
import { ConfigSection } from "../components/features/files/ConfigSection";
import { FileContentViewer } from "../components/features/files/FileContentViewer";
import { FileEditorPanel } from "../components/features/files/FileEditorPanel";
import { FileTreeItem } from "../components/features/files/FileTreeItem";
import { PreviewToggle } from "../components/features/files/PreviewToggle";
import { CodePreview } from "../components/features/files/viewers/CodePreview";
import { JsonPreview } from "../components/features/files/viewers/JsonPreview";
import { MarkdownPreview } from "../components/features/files/viewers/MarkdownPreview";
import { LogLine } from "../components/features/logs/LogLine";
import { MyCommentCard } from "../components/features/moltbook/MyCommentCard";
import { MyPostCard } from "../components/features/moltbook/MyPostCard";
import { ProfileCard } from "../components/features/moltbook/ProfileCard";
import { SessionActionsDropdown } from "../components/features/sessions/SessionActionsDropdown";
import { SessionsTable } from "../components/features/sessions/SessionsTable";
import { AgentAccessSection } from "../components/features/settings/AgentAccessSection";
import { ChannelSection } from "../components/features/settings/ChannelSection";
import { HeartbeatSection } from "../components/features/settings/HeartbeatSection";
import { ModelSection } from "../components/features/settings/ModelSection";
import { SessionSection } from "../components/features/settings/SessionSection";
import { SkillsSection } from "../components/features/settings/SkillsSection";
import { ToolSection } from "../components/features/settings/ToolSection";
import { Alert } from "../components/ui/Alert";
import { AppErrorFallback } from "../components/ui/AppErrorFallback";
import { Badge, getSessionTypeVariant } from "../components/ui/Badge";
import { Checkbox } from "../components/ui/Checkbox";
import { ConnectionStatus } from "../components/ui/ConnectionStatus";
import { ExpandableCard, ReadOnlyField } from "../components/ui/ExpandableCard";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { getProgressColor, ProgressBar } from "../components/ui/ProgressBar";
import { useFileExplorerState } from "../hooks/useFileExplorerState";
import { reportKeys } from "../hooks/useReports";
import { useSessionActions } from "../hooks/useSessionActions";
import {
    activeStreamRenderableText,
    hasExactCurrentAssistantMessage,
    insertIndexedStreamRows,
    isActiveStreamRecoveredInMessages,
    nextRefreshedChatMessages,
    orderCurrentResponseRows,
    rollbackFailedOptimisticMessage,
    visibleActiveStreamContent,
} from "../pages/Chat";
import type { Session } from "../types/session";

const originalFetch = fetch;
const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};

const animationFrameState = {
    id: 0,
    frames: new Map<number, FrameRequestCallback>(),
};

function TestIcon({ size, className }: { className?: string; size?: number }) {
    return (
        <span className={className} data-size={size}>
            I
        </span>
    );
}

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

function thinkingTexts(stream?: ActiveChatStreams[string]) {
    return stream?.message?.thinking?.map((block) => block.text) || [];
}

describe("shared component helpers", () => {
    it("names filter button groups and exposes their selected option", () => {
        render(
            <FilterButtonGroup
                ariaLabel="Example filter"
                options={[
                    { value: "all", label: "All" },
                    { value: "active", label: "Active" },
                ]}
                value="active"
                onChange={() => {}}
            />
        );

        const filterGroup = screen.getByRole("group", { name: "Example filter" });
        expect(filterGroup).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
            "aria-pressed",
            "false"
        );
        expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );
    });

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

    it("renders standalone UI primitives and fallback states", async () => {
        const user = userEvent.setup();
        const onCheck = jest.fn();
        const onReset = jest.fn();

        render(
            <>
                <Badge variant="main">Main session</Badge>
                <Badge variant={getSessionTypeVariant("subagent")}>Worker</Badge>
                <Checkbox
                    isChecked={false}
                    onChange={onCheck}
                    label="Enable option"
                    description="Toggle this option"
                />
                <ConnectionStatus isConnected={true} connectedText="Online" />
                <ConnectionStatus isConnected={false} disconnectedText="Offline" />
                <ExpandableCard
                    title="Expanded panel"
                    icon={TestIcon}
                    defaultExpanded={true}
                >
                    <ReadOnlyField label="Current value" value={undefined} />
                    <ReadOnlyField label="Boolean value" value={true} />
                </ExpandableCard>
                <AppErrorFallback
                    error={new Error("Rendered failure")}
                    resetErrorBoundary={onReset}
                />
            </>
        );

        expect(screen.getByText("Main session")).toBeInTheDocument();
        expect(screen.getByText("Worker")).toBeInTheDocument();
        expect(screen.getByText("Online")).toBeInTheDocument();
        expect(screen.getByText("Offline")).toBeInTheDocument();
        expect(screen.getByText("Expanded panel")).toBeInTheDocument();
        expect(screen.getByText("Current value")).toBeInTheDocument();
        expect(screen.getByText("Boolean value")).toBeInTheDocument();
        expect(screen.getByText("Rendered failure")).toBeInTheDocument();

        await user.click(screen.getByText("Enable option"));
        expect(onCheck).toHaveBeenCalledWith(true);
        await user.click(screen.getByRole("button", { name: /try again/i }));
        expect(onReset).toHaveBeenCalled();
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

        const previewButton = screen.getByRole("button", { name: /preview file/i });
        const rawButton = screen.getByRole("button", { name: /raw file/i });
        expect(previewButton).toHaveAttribute("aria-pressed", "false");
        expect(rawButton).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(previewButton);
        fireEvent.click(rawButton);
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

    it("renders chat attachment previews, header status, and diagnostic details", () => {
        const onClose = jest.fn();
        const onToggleThinking = jest.fn();
        const onToggleTools = jest.fn();
        const onSelectAgent = jest.fn();
        const onSelectSession = jest.fn();
        const onSelectThinkingLevel = jest.fn();
        const onSelectSpeed = jest.fn();
        const onCompact = jest.fn();

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
                        effectiveFastMode: "auto",
                        hookName: "",
                        id: "session-1",
                        key: "agent:main:main",
                        kind: "agent",
                        label: "Main",
                        maxTokens: 1000,
                        model: "codex",
                        thinkingLevel: "high",
                        thinkingDefault: "low",
                        thinkingLevels: [
                            { id: "low", label: "" },
                            { id: "high", label: "high" },
                        ],
                        tokenCount: 525,
                        totalTokensFresh: false,
                        type: "agent",
                        updatedAt: Date.now(),
                    }}
                    selectedAgentId="main"
                    selectedSessionKey="agent:main:main"
                    agentOptions={[{ label: "Main agent", value: "main" }]}
                    sessionOptions={[{ label: "Main session", value: "agent:main:main" }]}
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
                            {
                                arguments: { ok: true },
                                id: "tool-1",
                                name: "run",
                                toolResult: {
                                    content: "tool output",
                                    id: "tool-1",
                                    name: "run",
                                },
                            },
                            { id: "tool-2", name: "empty" },
                        ],
                        toolResult: {
                            content: "standalone output",
                            isError: true,
                            name: "run",
                        },
                    }}
                />
                <ChatMessageDetails
                    visibility={{ shouldShowThinking: true, shouldShowTools: true }}
                    message={{
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [
                            {
                                arguments: { command: "older call" },
                                name: "functions.exec_command",
                            },
                        ],
                        toolResult: {
                            content: "late id output",
                            id: "late-result-id",
                            name: "functions.exec_command",
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

        expect(onToggleThinking).not.toHaveBeenCalled();
        expect(onToggleTools).not.toHaveBeenCalled();
        expect(onCompact).not.toHaveBeenCalled();
        expect(onSelectThinkingLevel).not.toHaveBeenCalled();
        expect(onSelectSpeed).not.toHaveBeenCalled();
        expect(screen.getByText(/Context: ~0.5k \/ 1k \(stale\)/)).toBeInTheDocument();
        expect(screen.getByText("Thinking / working")).toBeInTheDocument();
        expect(screen.getByText("Run")).toBeInTheDocument();
        expect(screen.getAllByText("Tool input")).toHaveLength(3);
        expect(screen.getByText("Tool output")).toBeInTheDocument();
        expect(screen.getByText("Tool result · Bash")).toBeInTheDocument();
        expect(screen.getByText("late id output")).toBeInTheDocument();
        expect(screen.getByText("No arguments")).toBeInTheDocument();
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

        await expect(
            runSlashCommand("/compact", [
                {
                    contentBase64: "b",
                    file: new File(["b"], "late.txt", { type: "text/plain" }),
                    fileName: "late.txt",
                    id: "late",
                    kind: "text",
                    mimeType: "text/plain",
                    sizeBytes: 1,
                },
            ])
        ).resolves.toBe(true);
        expect(setSendError).toHaveBeenCalledWith("/compact cannot include attachments.");

        expect(
            chatThinkingOptions({
                thinkingLevel: "low",
                thinkingOptions: [
                    "off",
                    "on",
                    "Think Hard",
                    "Think Harder",
                    "Extra High",
                ],
            } as Session)
        ).toEqual([
            { label: "Default", value: "" },
            { label: "off", value: "off" },
            { label: "on", value: "low" },
            { label: "Think Harder", value: "medium" },
            { label: "Extra High", value: "xhigh" },
        ]);
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
            runtimeProgressText("session.event", "item", "start", {
                kind: "preamble",
                progressText: "Codex preamble text",
                source: "codex-app-server",
                title: "Preamble",
            })
        ).toBeUndefined();
        expect(
            runtimeProgressText("session.event", "item", "start", {
                itemId: "reasoning",
                itemKind: "analysis",
                progressText: "reasoning snapshot",
                title: "Reasoning",
            })
        ).toBeUndefined();
        expect(
            runtimeProgressText("session.event", "item", "start", {
                itemId: "rs_123",
                kind: "analysis",
                status: "running",
                title: "Reasoning",
            })
        ).toBeUndefined();
        expect(
            runtimeProgressText("session.event", "item", "start", {
                kind: "command",
                meta: "git status (repo)",
                name: "bash",
                suppressChannelProgress: true,
                title: "Command",
            })
        ).toBeUndefined();
        expect(
            runtimeProgressText("session.event", "item", "start", {
                item: {
                    kind: "reasoning",
                    summary: "full nested reasoning snapshot",
                    type: "analysis",
                },
            })
        ).toBeUndefined();
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
            runtimeProgressText("session.event", "thinking", "delta", {
                delta: "x".repeat(200),
            })
        ).toBe("Thinking");
        expect(
            runtimeProgressText("session.event", "unknown", "start", {})
        ).toBeUndefined();

        expect(isNewRunForStream({ aliases: [], runId: "old" }, "new")).toBe(true);
        expect(isNewRunForStream({ aliases: ["new"], runId: "old" }, "new")).toBe(false);
        expect(isRuntimeWorkEvent("session.tool", "tool", "start", "Tool")).toBe(true);
        expect(isRuntimeWorkEvent("session.tool", "tool", "start")).toBe(false);
        expect(isRuntimeWorkEvent("session.event", "lifecycle", "start")).toBe(true);
        expect(
            mergeStreamMessage(
                {
                    attachments: [],
                    content: [],
                    images: [],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "first" }, { text: "second" }],
                },
                {
                    attachments: [],
                    content: [],
                    images: [],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: " update" }],
                },
                "",
                "run-1"
            ).thinking?.map((block) => block.text)
        ).toEqual(["first update", "second"]);
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
        let activeStreams: ActiveChatStreams = {};
        const activeStreamsReference = { current: activeStreams };
        const liveHistoryRefreshTimerReference = { current: undefined };
        const stickToBottomReference = { current: true };
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
                shouldStickToBottomReference: stickToBottomReference,
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
                event: "chat",
                payload: {
                    deltaText: " ",
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "world",
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
                "Hello world"
            );
        });
        for (const delta of ["hel", "l", "o"]) {
            act(() => {
                listener?.({
                    event: "agent",
                    payload: {
                        data: { delta },
                        runId: "assistant-deltas",
                        sessionKey: "agent:main:main",
                        stream: "assistant",
                    },
                    type: "event",
                });
            });
        }
        await waitFor(() => {
            expect(
                activeStreamsReference.current[
                    "agent:main:main::assistant-deltas::assistant"
                ]?.text
            ).toBe("hello");
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "assistant-deltas",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "bun test" },
                        name: "functions.exec_command",
                        phase: "end",
                        result: { output: "ok" },
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
                    message.role === "assistant" &&
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) => toolCall.name === "functions.exec_command"
                    ) &&
                    "toolResult" in message &&
                    typeof message.toolResult === "object" &&
                    message.toolResult !== null &&
                    "content" in message.toolResult &&
                    typeof message.toolResult.content === "string" &&
                    message.toolResult.content.includes("ok")
            )
        ).toBe(true);
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "tool" &&
                    "toolResult" in message &&
                    typeof message.toolResult === "object" &&
                    message.toolResult !== null &&
                    "content" in message.toolResult &&
                    typeof message.toolResult.content === "string" &&
                    message.toolResult.content.includes("ok")
            )
        ).toBe(false);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "checking files",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const stream =
                activeStreamsReference.current["agent:main:main::run-1::thinking"];
            expect(stream?.message?.thinking?.[0]?.text).toContain("checking files");
            expect(stream?.statusText).toBeUndefined();
        });
        for (const delta of ["hel", "l", "o"]) {
            act(() => {
                listener?.({
                    event: "agent",
                    payload: {
                        data: { delta },
                        runId: "diagnostic-deltas",
                        sessionKey: "agent:main:main",
                        stream: "thinking",
                    },
                    type: "event",
                });
            });
        }
        await waitFor(() => {
            expect(
                activeStreamsReference.current[
                    "agent:main:main::diagnostic-deltas::thinking"
                ]?.message?.thinking?.[0]?.text
            ).toBe("hello");
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "diagnostic-deltas",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: { text: "snapshot checking" },
                    runId: "thinking-snapshot",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: { text: "snapshot checking files" },
                    runId: "thinking-snapshot",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                activeStreamsReference.current[
                    "agent:main:main::thinking-snapshot::thinking"
                ]?.message?.thinking?.[0]?.text
            ).toBe("snapshot checking files");
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "thinking-snapshot",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        args: { path: "src/pages/Chat.tsx" },
                        name: "functions.read_file",
                        phase: "start",
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
                    message.role === "assistant" &&
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            toolCall.name === "functions.read_file" &&
                            toolCall.arguments?.path === "src/pages/Chat.tsx"
                    )
            )
        ).toBe(true);
        expect(
            activeStreamsReference.current["agent:main:main::run-1::thinking"]?.message
                ?.thinking?.[0]?.text
        ).toContain("checking files");

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "merge-args-tool",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "p" },
                        id: "merge-args-tool",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "pwd" },
                        id: "merge-args-tool",
                        name: "functions.exec_command",
                        phase: "result",
                        result: "workspace",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "merge-args-tool",
                        name: "functions.exec_command",
                        phase: "end",
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
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            toolCall.id === "merge-args-tool" &&
                            toolCall.arguments?.command === "pwd" &&
                            toolCall.toolResult?.content === "workspace"
                    )
            )
        ).toBe(true);
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "merge-args-tool",
                        isError: true,
                        name: "functions.exec_command",
                        phase: "error",
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
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            toolCall.id === "merge-args-tool" &&
                            toolCall.toolResult?.content === "workspace" &&
                            toolCall.toolResult.isError === true
                    )
            )
        ).toBe(true);
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "run-a" },
                        id: "shared-result",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "result-run-a",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "run-b" },
                        id: "shared-result",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "result-run-b",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "shared-result",
                        name: "functions.exec_command",
                        phase: "result",
                        result: "run a output",
                    },
                    runId: "result-run-a",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const sharedResultRows = messages.flatMap((message) => {
                if (
                    typeof message === "object" &&
                    message !== null &&
                    "runId" in message &&
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some((toolCall) => toolCall.id === "shared-result")
                ) {
                    return [
                        {
                            runId: message.runId,
                            result: message.toolCalls.find(
                                (toolCall) => toolCall.id === "shared-result"
                            )?.toolResult?.content,
                        },
                    ];
                }

                return [];
            });
            expect(
                sharedResultRows.find((row) => row.runId === "result-run-a")?.result
            ).toBe("run a output");
            expect(
                sharedResultRows.find((row) => row.runId === "result-run-b")?.result
            ).toBeUndefined();
        });
        for (const runId of ["result-run-a", "result-run-b"]) {
            act(() => {
                listener?.({
                    event: "model.completed",
                    payload: {
                        runId,
                        sessionKey: "agent:main:main",
                    },
                    type: "event",
                });
            });
        }
        expect(
            messages
                .flatMap((message) => {
                    if (
                        typeof message === "object" &&
                        message !== null &&
                        "toolCalls" in message &&
                        Array.isArray(message.toolCalls)
                    ) {
                        return message.toolCalls;
                    }

                    return [];
                })
                .filter((toolCall) => toolCall.id === "merge-args-tool")
        ).toHaveLength(1);

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "shared-call",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-a",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "run-b" },
                        id: "shared-call",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-b",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        const sharedCallRows = messages.flatMap((message) => {
            if (
                typeof message === "object" &&
                message !== null &&
                "toolCalls" in message &&
                Array.isArray(message.toolCalls) &&
                message.toolCalls.some((toolCall) => toolCall.id === "shared-call")
            ) {
                return [
                    {
                        runId:
                            "runId" in message && typeof message.runId === "string"
                                ? message.runId
                                : undefined,
                        toolCalls: message.toolCalls,
                    },
                ];
            }

            return [];
        });
        expect(sharedCallRows).toHaveLength(2);
        expect(
            sharedCallRows.find((row) => row.runId === "run-a")?.toolCalls[0]?.arguments
        ).toBeUndefined();
        expect(
            sharedCallRows.find((row) => row.runId === "run-b")?.toolCalls[0]?.arguments
        ).toEqual({ command: "run-b" });
        for (const runId of ["run-a", "run-b"]) {
            act(() => {
                listener?.({
                    event: "model.completed",
                    payload: {
                        runId,
                        sessionKey: "agent:main:main",
                    },
                    type: "event",
                });
            });
        }

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "sparse-update" },
                        id: "sparse-update-tool",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "sparse-update-tool",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "sparse-update-tool",
                        name: "functions.exec_command",
                        phase: "result",
                        result: "sparse output",
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
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            toolCall.id === "sparse-update-tool" &&
                            toolCall.arguments?.command === "sparse-update" &&
                            toolCall.toolResult?.content === "sparse output"
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "repeat-same" },
                        name: "functions.exec_command",
                        phase: "result",
                        result: "old repeat output",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "repeat-same" },
                        id: "repeat-same-new",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        const repeatedSameCalls = messages.flatMap((message) => {
            if (
                typeof message === "object" &&
                message !== null &&
                "toolCalls" in message &&
                Array.isArray(message.toolCalls)
            ) {
                return message.toolCalls.filter(
                    (toolCall) => toolCall.arguments?.command === "repeat-same"
                );
            }

            return [];
        });
        expect(repeatedSameCalls).toHaveLength(2);
        expect(
            repeatedSameCalls.find((toolCall) => toolCall.id === "repeat-same-new")
                ?.toolResult
        ).toBeUndefined();

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "late-id" },
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "late-id" },
                        id: "late-id-tool",
                        name: "functions.exec_command",
                        phase: "result",
                        result: "late id output",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        const lateIdToolCalls = messages.flatMap((message) => {
            if (
                typeof message === "object" &&
                message !== null &&
                "toolCalls" in message &&
                Array.isArray(message.toolCalls)
            ) {
                return message.toolCalls.filter(
                    (toolCall) => toolCall.arguments?.command === "late-id"
                );
            }

            return [];
        });
        expect(lateIdToolCalls).toHaveLength(1);
        expect(lateIdToolCalls[0]).toMatchObject({
            id: "late-id-tool",
            toolResult: { content: "late id output" },
        });

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "late-update-id" },
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "late-update-id" },
                        id: "late-update-id-tool",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "late-update-id-tool",
                        name: "functions.exec_command",
                        phase: "result",
                        result: "late update id output",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        const lateUpdateToolCalls = messages.flatMap((message) => {
            if (
                typeof message === "object" &&
                message !== null &&
                "toolCalls" in message &&
                Array.isArray(message.toolCalls)
            ) {
                return message.toolCalls.filter(
                    (toolCall) => toolCall.arguments?.command === "late-update-id"
                );
            }

            return [];
        });
        expect(lateUpdateToolCalls).toHaveLength(1);
        expect(lateUpdateToolCalls[0]).toMatchObject({
            id: "late-update-id-tool",
            toolResult: { content: "late update id output" },
        });

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "arg-first" },
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "arg-second" },
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "arg-second" },
                        name: "functions.exec_command",
                        phase: "result",
                        result: "second arg output",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        const argumentMatchedCalls = messages.flatMap((message) => {
            if (
                typeof message === "object" &&
                message !== null &&
                "toolCalls" in message &&
                Array.isArray(message.toolCalls)
            ) {
                return message.toolCalls.filter((toolCall) =>
                    ["arg-first", "arg-second"].includes(toolCall.arguments?.command)
                );
            }

            return [];
        });
        expect(
            argumentMatchedCalls.find(
                (toolCall) => toolCall.arguments?.command === "arg-first"
            )?.toolResult
        ).toBeUndefined();
        expect(
            argumentMatchedCalls.find(
                (toolCall) => toolCall.arguments?.command === "arg-second"
            )?.toolResult?.content
        ).toBe("second arg output");

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "id-backed" },
                        id: "id-backed-call",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "id-backed" },
                        name: "functions.exec_command",
                        phase: "result",
                        result: "no id output",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        const idBackedToolCalls = messages.flatMap((message) => {
            if (
                typeof message === "object" &&
                message !== null &&
                "toolCalls" in message &&
                Array.isArray(message.toolCalls)
            ) {
                return message.toolCalls.filter(
                    (toolCall) => toolCall.id === "id-backed-call"
                );
            }

            return [];
        });
        expect(idBackedToolCalls[0]?.toolResult).toBeUndefined();
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            !toolCall.id &&
                            toolCall.arguments?.command === "id-backed" &&
                            toolCall.toolResult?.content.includes("no id output")
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning",
                        itemKind: "analysis",
                        progressText: "reasoning snapshot",
                        title: "Reasoning",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const stream =
                activeStreamsReference.current["agent:main:main::run-1::reasoning"];
            expect(
                thinkingTexts(stream).some((text) => text.includes("reasoning snapshot"))
            ).toBe(true);
            expect(stream?.statusText).toBeUndefined();
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning",
                        itemKind: "analysis",
                        progressText: "reading files",
                        title: "Reasoning",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const stream =
                activeStreamsReference.current["agent:main:main::run-1::reasoning"];
            expect(thinkingTexts(stream)).toContain("reading files");
            expect(thinkingTexts(stream)).not.toContain("reasoning snapshot");
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        item: {
                            kind: "reasoning",
                            summary: "nested reasoning snapshot",
                            type: "analysis",
                        },
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const stream =
                activeStreamsReference.current["agent:main:main::run-1::reasoning"];
            expect(
                thinkingTexts(stream).some((text) =>
                    text.includes("nested reasoning snapshot")
                )
            ).toBe(true);
            expect(stream?.statusText).toBeUndefined();
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning-summary",
                        itemKind: "analysis",
                        summary: "checking",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning-summary",
                        itemKind: "analysis",
                        summary: "checking files",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const stream =
                activeStreamsReference.current["agent:main:main::run-1::reasoning"];
            const matches = thinkingTexts(stream).filter((text) =>
                text.includes("checking")
            );
            expect(matches).toContain("checking files");
            expect(matches).not.toContain("checkingchecking files");
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: " files",
                        itemId: "reasoning-progress-delta",
                        itemKind: "analysis",
                        progressText: "checking files",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const block = activeStreamsReference.current[
                "agent:main:main::run-1::reasoning"
            ]?.message?.thinking?.find(
                (thinkingBlock) => thinkingBlock.id === "reasoning-progress-delta"
            );
            expect(block?.text).toBe(" files");
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning-blank-snapshot",
                        itemKind: "analysis",
                        progressText: "visible reasoning",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning-blank-snapshot",
                        itemKind: "analysis",
                        progressText: " ",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const block = activeStreamsReference.current[
                "agent:main:main::run-1::reasoning"
            ]?.message?.thinking?.find(
                (thinkingBlock) => thinkingBlock.id === "reasoning-blank-snapshot"
            );
            expect(block?.text).toBe("visible reasoning");
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        item: {
                            kind: "preamble",
                            summary: [{ text: "array reasoning block", type: "text" }],
                            type: "analysis",
                        },
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const stream =
                activeStreamsReference.current["agent:main:main::run-1::reasoning"];
            expect(
                thinkingTexts(stream).some((text) =>
                    text.includes("array reasoning block")
                )
            ).toBe(true);
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning-space",
                        kind: "preamble",
                        progressText: "checking",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning-space",
                        kind: "preamble",
                        progressText: " ",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        itemId: "reasoning-space",
                        kind: "preamble",
                        progressText: "files",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const stream =
                activeStreamsReference.current["agent:main:main::run-1::reasoning"];
            expect(
                thinkingTexts(stream).some((text) => text.includes("checking files"))
            ).toBe(true);
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        kind: "preamble",
                        itemId: "preamble-1",
                        phase: "update",
                        progressText: "Codex preamble should",
                        source: "codex-app-server",
                        title: "Preamble",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        kind: "preamble",
                        itemId: "preamble-1",
                        phase: "update",
                        progressText: "Codex preamble should be thinking",
                        source: "codex-app-server",
                        title: "Preamble",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            const stream =
                activeStreamsReference.current["agent:main:main::run-1::reasoning"];
            const matches = thinkingTexts(stream).filter((text) =>
                text.includes("Codex preamble")
            );
            expect(matches).toEqual(["Codex preamble should be thinking"]);
            expect(stream?.statusText).toBeUndefined();
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Hello",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: " ",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "world",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
                "Hello world"
            );
            expect(
                activeStreamsReference.current["agent:main:main::run-1::assistant"]
            ).toBeUndefined();
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        phase: "end",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
            "Hello world"
        );
        expect(
            activeStreamsReference.current["agent:main:main::run-1::thinking"]
        ).toBeUndefined();

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Hello ",
                    },
                    runId: "assistant-end-text",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        phase: "end",
                        text: "world",
                    },
                    runId: "assistant-end-text",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "text" in message &&
                    message.text === "Hello world"
            )
        ).toBe(true);
        expect(
            activeStreamsReference.current[
                "agent:main:main::assistant-end-text::assistant"
            ]
        ).toBeUndefined();

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        content: "Content stream",
                    },
                    runId: "content-run",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                activeStreamsReference.current["agent:main:main::content-run::assistant"]
                    ?.text
            ).toBe("Content stream");
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        phase: "end",
                    },
                    runId: "empty-assistant-end",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        expect(
            activeStreamsReference.current[
                "agent:main:main::empty-assistant-end::assistant"
            ]
        ).toBeUndefined();

        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "content-run",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "terminal reasoning",
                    },
                    runId: "diagnostic-terminal",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "diagnostic-terminal",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    "local" in message &&
                    message.local === true &&
                    message.thinking.some((block) =>
                        block.text.includes("terminal reasoning")
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "channel ",
                    },
                    runId: "thinking-channel-end",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "end chunk",
                        phase: "end",
                    },
                    runId: "thinking-channel-end",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    message.thinking.some((block) =>
                        block.text.includes("channel end chunk")
                    )
            )
        ).toBe(true);
        expect(
            activeStreamsReference.current[
                "agent:main:main::thinking-channel-end::thinking"
            ]
        ).toBeUndefined();
        expect(
            messages.filter(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    message.thinking.some((block) => block.text.includes("channel"))
            )
        ).toHaveLength(1);

        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: [
                            { text: "Mixed visible text", type: "text" },
                            { text: "mixed terminal reasoning", type: "thinking" },
                        ],
                        role: "assistant",
                    },
                    runId: "mixed-terminal-diagnostic",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "mixed-terminal-diagnostic",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    "text" in message &&
                    typeof message.text === "string" &&
                    "local" in message &&
                    message.local === true &&
                    message.text.includes("Mixed visible text") &&
                    message.thinking.some((block) =>
                        block.text.includes("mixed terminal reasoning")
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    data: {
                        delta: "whole-run final answer",
                    },
                    runId: "whole-run-terminal-assistant-payload",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "text" in message &&
                    message.text === "whole-run final answer"
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    data: {
                        delta: "whole-run final reasoning",
                    },
                    runId: "whole-run-terminal-thinking-payload",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    message.thinking.some((block) =>
                        block.text.includes("whole-run final reasoning")
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: [
                            { text: "Final payload with media", type: "text" },
                            { text: "final rich reasoning", type: "thinking" },
                        ],
                        role: "assistant",
                    },
                    runId: "final-rich-diagnostic",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: {
                        content: [
                            { text: "Final payload with media", type: "text" },
                            {
                                source: {
                                    data: "ZmFrZQ==",
                                    media_type: "image/png",
                                    type: "base64",
                                },
                                type: "image",
                            },
                        ],
                        role: "assistant",
                    },
                    runId: "final-rich-diagnostic",
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
                    "text" in message &&
                    message.text === "Final payload with media" &&
                    "images" in message &&
                    Array.isArray(message.images) &&
                    message.images.length === 1 &&
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    message.thinking.some((block) =>
                        block.text.includes("final rich reasoning")
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "chat final reasoning",
                    },
                    runId: "chat-final-diagnostic",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: { role: "assistant", text: "" },
                    runId: "chat-final-diagnostic",
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
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    message.thinking.some((block) =>
                        block.text.includes("chat final reasoning")
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "aborted reasoning",
                    },
                    runId: "chat-aborted-diagnostic",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    runId: "chat-aborted-diagnostic",
                    sessionKey: "agent:main:main",
                    state: "aborted",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    message.thinking.some((block) =>
                        block.text.includes("aborted reasoning")
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        item: {
                            id: "codex-tool-1",
                            input: "await tools.exec_command({cmd:'git status'})",
                            name: "exec",
                            type: "custom_tool_call",
                        },
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
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
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            toolCall.id === "codex-tool-1" &&
                            toolCall.name === "exec" &&
                            toolCall.arguments ===
                                "await tools.exec_command({cmd:'git status'})"
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        item: {
                            call_id: "codex-tool-1",
                            output: "git clean",
                            type: "custom_tool_call_output",
                        },
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
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
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            toolCall.id === "codex-tool-1" &&
                            toolCall.toolResult?.content.includes("git clean")
                    )
            )
        ).toBe(true);
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "tool" &&
                    "toolResult" in message &&
                    typeof message.toolResult === "object" &&
                    message.toolResult !== null &&
                    "content" in message.toolResult &&
                    typeof message.toolResult.content === "string" &&
                    message.toolResult.content.includes("git clean")
            )
        ).toBe(false);

        act(() => {
            listener?.({
                event: "session.tool",
                payload: {
                    data: {
                        id: "other-call-id",
                        name: "exec",
                        phase: "result",
                        result: "wrong call output",
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
                    "toolResult" in message &&
                    typeof message.toolResult === "object" &&
                    message.toolResult !== null &&
                    "id" in message.toolResult &&
                    message.toolResult.id === "other-call-id"
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        item: {
                            call_id: "responses-call-1",
                            id: "responses-item-1",
                            input: { command: "pwd" },
                            name: "functions.exec_command",
                            type: "function_call",
                        },
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        item: {
                            call_id: "responses-call-1",
                            output: "/home/ubuntu/projects/mira-dashboard",
                            type: "function_call_output",
                        },
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "item",
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
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            toolCall.id === "responses-call-1" &&
                            toolCall.toolResult?.content.includes("mira-dashboard")
                    )
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "assistant" &&
                    "text" in message &&
                    message.text === "Hello world"
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Buffered terminal answer",
                    },
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                activeStreamsReference.current["agent:main:main::assistant"]?.runId
            ).toBe("agent:main:main");
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: " continued",
                    },
                    runId: "real-run-after-provisional",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                activeStreamsReference.current[
                    "agent:main:main::real-run-after-provisional::assistant"
                ]?.text
            ).toBe("Buffered terminal answer continued");
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    runId: "real-run-after-provisional",
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
                    message.text === "Buffered terminal answer continued"
            )
        ).toBe(true);
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        activeStreamsReference.current["agent:main:main"] = {
            aliases: [],
            runId: "dashboard-chat-optimistic",
            sessionKey: "agent:main:main",
            statusText: "Thinking",
            text: "Optimistic buffered answer",
            updatedAt: new Date().toISOString(),
        };
        activeStreamsReference.current[
            "agent:main:main::dashboard-chat-optimistic::assistant"
        ] = {
            aliases: ["dashboard-chat-optimistic"],
            runId: "dashboard-chat-optimistic",
            sessionKey: "agent:main:main",
            text: "Optimistic buffered answer",
            updatedAt: new Date().toISOString(),
        };
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    runId: "real-chat-terminal",
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
                    message.text === "Optimistic buffered answer"
            )
        ).toBe(true);
        expect(activeStreamsReference.current["agent:main:main"]).toBeUndefined();
        expect(
            activeStreamsReference.current[
                "agent:main:main::dashboard-chat-optimistic::assistant"
            ]
        ).toBeUndefined();
        activeStreamsReference.current = {};

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "Hello",
                    runId: "overlap-run",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Thinking remains separate",
                    },
                    runId: "overlap-run",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe("Hello");
            expect(
                activeStreamsReference.current["agent:main:main::overlap-run::thinking"]
                    ?.message?.thinking?.[0]?.text
            ).toBe("Thinking remains separate");
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Hello world",
                    },
                    runId: "overlap-run",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe("Hello");
            expect(
                activeStreamsReference.current["agent:main:main::overlap-run::assistant"]
            ).toBeUndefined();
            expect(
                activeStreamsReference.current["agent:main:main::overlap-run::thinking"]
                    ?.message?.thinking?.[0]?.text
            ).toBe("Thinking remains separate");
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "overlap-run",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);
        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: "Hello world",
                        role: "assistant",
                    },
                    runId: "overlap-run",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Hello world",
                    runId: "overlap-run",
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
                    message.text === "Hello world"
            )
        ).toBe(true);
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        activeStreamsReference.current["agent:main:main"] = {
            aliases: ["dashboard-chat-runtime-first"],
            runId: "dashboard-chat-runtime-first",
            sessionKey: "agent:main:main",
            statusText: "Thinking",
            text: "",
            updatedAt: new Date().toISOString(),
        };
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Runtime-first answer",
                    },
                    runId: "runtime-first-run",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                activeStreamsReference.current[
                    "agent:main:main::runtime-first-run::assistant"
                ]?.text
            ).toBe("Runtime-first answer");
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: {
                        content: [
                            { text: " with chat continuation", type: "text" },
                            { text: "Chat-only thinking", type: "thinking" },
                            {
                                data: "generated-image",
                                mimeType: "image/png",
                                type: "image",
                            },
                            {
                                arguments: { command: "status" },
                                id: "chat-only-tool",
                                name: "functions.exec_command",
                                type: "toolCall",
                            },
                        ],
                        MediaPath: "/tmp/generated.txt",
                        MediaType: "text/plain",
                        role: "assistant",
                    },
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        expect(
            activeStreamsReference.current[
                "agent:main:main::runtime-first-run::assistant"
            ]?.text
        ).toBe("Runtime-first answer");
        await waitFor(() => {
            expect(
                activeStreamsReference.current["agent:main:main"]?.message?.thinking?.[0]
                    ?.text
            ).toBe("Chat-only thinking");
            expect(
                activeStreamsReference.current["agent:main:main"]?.message?.toolCalls?.[0]
                    ?.id
            ).toBe("chat-only-tool");
            expect(
                activeStreamsReference.current["agent:main:main"]?.message?.images?.[0]
                    ?.data
            ).toBe("generated-image");
            expect(
                activeStreamsReference.current["agent:main:main"]?.message
                    ?.attachments?.[0]?.fileName
            ).toBe("generated.txt");
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe("");
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Runtime-first answer with chat continuation",
                    runId: "runtime-first-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);
        expect(
            messages.some((message) => {
                const mediaMessage = message as {
                    attachments?: Array<{ fileName?: string }>;
                    images?: Array<{ data?: string }>;
                };
                return (
                    mediaMessage.images?.[0]?.data === "generated-image" &&
                    mediaMessage.attachments?.[0]?.fileName === "generated.txt"
                );
            })
        ).toBe(true);
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "assistant" &&
                    "text" in message &&
                    message.text === "Runtime-first answer with chat continuation"
            )
        ).toBe(true);

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: {
                        content: [
                            { text: "Chat media answer", type: "text" },
                            {
                                data: "chat-final-image",
                                mimeType: "image/png",
                                type: "image",
                            },
                        ],
                        MediaPath: "/tmp/chat-final.txt",
                        MediaType: "text/plain",
                        role: "assistant",
                    },
                    runId: "chat-media-fold-run",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.runId).toBe(
                "chat-media-fold-run"
            );
            expect(
                activeStreamsReference.current["agent:main:main"]?.message?.images?.[0]
                    ?.data
            ).toBe("chat-final-image");
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Chat media answer",
                    runId: "chat-media-fold-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        const foldedMediaFinal = messages.find(
            (message) =>
                typeof message === "object" &&
                message !== null &&
                "text" in message &&
                message.text === "Chat media answer"
        );
        expect(foldedMediaFinal).toMatchObject({
            attachments: [{ fileName: "chat-final.txt" }],
            images: [{ data: "chat-final-image" }],
            local: true,
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: {
                        content: [
                            { text: "Distinct media caption", type: "text" },
                            {
                                data: "distinct-caption-image",
                                mimeType: "image/png",
                                type: "image",
                            },
                        ],
                        role: "assistant",
                    },
                    runId: "distinct-media-text-run",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Different final answer",
                    runId: "distinct-media-text-run",
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
                    "text" in message &&
                    message.text === "Distinct media caption" &&
                    "images" in message &&
                    Array.isArray(message.images) &&
                    message.images.some(
                        (image) =>
                            typeof image === "object" &&
                            image !== null &&
                            "data" in image &&
                            image.data === "distinct-caption-image"
                    )
            )
        ).toBe(true);
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "text" in message &&
                    message.text === "Different final answer"
            )
        ).toBe(true);

        messages = [
            ...messages,
            {
                attachments: [
                    {
                        fileName: "preexisting-rich.txt",
                        id: "preexisting-rich-media",
                        kind: "text",
                    },
                ],
                content: "Preexisting rich final",
                images: [{ data: "preexisting-rich-image", type: "image" }],
                local: true,
                role: "assistant",
                runId: "preexisting-rich-final-run",
                text: "Preexisting rich final",
                timestamp: new Date().toISOString(),
            },
        ];
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Preexisting rich final",
                    runId: "preexisting-rich-final-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        const mergedPreexistingRichFinal = messages.find(
            (message) =>
                typeof message === "object" &&
                message !== null &&
                "runId" in message &&
                message.runId === "preexisting-rich-final-run"
        );
        expect(mergedPreexistingRichFinal).toMatchObject({
            attachments: [{ id: "preexisting-rich-media" }],
            images: [{ data: "preexisting-rich-image" }],
            local: true,
        });
        const refreshedPreexistingRichFinal = mergeWithRecentOptimisticMessages(
            [mergedPreexistingRichFinal as ChatHistoryMessage],
            [
                {
                    content: "Preexisting rich final",
                    role: "assistant",
                    runId: "preexisting-rich-final-run",
                    text: "Preexisting rich final",
                },
            ]
        )[0];
        expect(refreshedPreexistingRichFinal).toMatchObject({
            attachments: [{ id: "preexisting-rich-media" }],
            images: [{ data: "preexisting-rich-image" }],
        });
        expect(refreshedPreexistingRichFinal?.local).toBeUndefined();

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Final-only chat answer",
                    runId: "final-only-chat-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        activeStreams = {
            "agent:main:main": {
                aliases: ["dashboard-chat-after-no-run-final"],
                runId: "dashboard-chat-after-no-run-final",
                sessionKey: "agent:main:main",
                statusText: "Thinking",
                text: "",
                updatedAt: new Date().toISOString(),
            },
        };
        activeStreamsReference.current = activeStreams;
        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: "Final-only chat answer",
                        role: "assistant",
                    },
                    runId: "final-only-chat-run",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(activeStreamsReference.current["agent:main:main"]?.text).toBe("");
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "Answer after final-only runtime echo",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
                "Answer after final-only runtime echo"
            );
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Answer after final-only runtime echo",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        activeStreams = {
            "agent:main:main": {
                aliases: ["dashboard-chat-buffered-final"],
                runId: "dashboard-chat-buffered-final",
                sessionKey: "agent:main:main",
                statusText: "Thinking",
                text: "",
                updatedAt: new Date().toISOString(),
            },
        };
        activeStreamsReference.current = activeStreams;
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "Buffered no-run final answer",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);
        activeStreamsReference.current["agent:main:main"] = {
            aliases: ["dashboard-chat-after-buffered-final"],
            runId: "dashboard-chat-after-buffered-final",
            sessionKey: "agent:main:main",
            statusText: "Thinking",
            text: "",
            updatedAt: new Date().toISOString(),
        };
        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: "Buffered no-run final answer",
                        role: "assistant",
                    },
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(activeStreamsReference.current["agent:main:main"]?.text).toBe("");
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "Answer after buffered final echo",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
                "Answer after buffered final echo"
            );
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Answer after buffered final echo",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        activeStreamsReference.current["agent:main:main"] = {
            aliases: ["dashboard-chat-pending-runtime-only"],
            runId: "dashboard-chat-pending-runtime-only",
            sessionKey: "agent:main:main",
            statusText: "Thinking",
            text: "",
            updatedAt: "2026-07-10T15:00:00.000Z",
        };
        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: "Concrete runtime answer",
                        role: "assistant",
                    },
                    runId: "concrete-runtime-run",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                Object.values(activeStreamsReference.current).some(
                    (stream) =>
                        stream.runId === "concrete-runtime-run" &&
                        stream.text === "Concrete runtime answer"
                )
            ).toBe(true);
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Concrete runtime answer",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: "Runtime-only terminal answer",
                        role: "assistant",
                    },
                    runId: "runtime-only-terminal-run",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                Object.values(activeStreamsReference.current).some(
                    (stream) => stream.runId === "runtime-only-terminal-run"
                )
            ).toBe(true);
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: { sessionKey: "agent:main:main" },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "text" in message &&
                    message.text === "Runtime-only terminal answer"
            )
        ).toBe(true);

        activeStreamsReference.current["agent:main:main"] = {
            aliases: ["dashboard-chat-no-run-runtime-only"],
            runId: "dashboard-chat-no-run-runtime-only",
            sessionKey: "agent:main:main",
            statusText: "Thinking",
            text: "",
            updatedAt: new Date().toISOString(),
        };
        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: "No-run runtime-only answer",
                        role: "assistant",
                    },
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
                "No-run runtime-only answer"
            );
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: { sessionKey: "agent:main:main" },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "OK",
                    runId: "completed-repeat-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: { content: "OK", role: "assistant" },
                    runId: "next-repeat-run",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe("OK");
            expect(activeStreamsReference.current["agent:main:main"]?.runId).toBe(
                "next-repeat-run"
            );
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "next-repeat-run",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "No-run final-only chat answer",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        activeStreams = {
            "agent:main:main": {
                aliases: ["dashboard-chat-after-runless-final"],
                runId: "dashboard-chat-after-runless-final",
                sessionKey: "agent:main:main",
                statusText: "Thinking",
                text: "",
                updatedAt: new Date().toISOString(),
            },
        };
        activeStreamsReference.current = activeStreams;
        act(() => {
            listener?.({
                event: "session.message",
                payload: {
                    message: {
                        content: "No-run final-only chat answer",
                        role: "assistant",
                    },
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(activeStreamsReference.current["agent:main:main"]?.text).toBe("");
        act(() => {
            listener?.({
                event: "model.completed",
                payload: { sessionKey: "agent:main:main" },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "Answer after no-run final-only echo",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
                "Answer after no-run final-only echo"
            );
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Answer after no-run final-only echo",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        activeStreams = {
            "agent:main:main": {
                aliases: ["dashboard-chat-no-run-a"],
                runId: "dashboard-chat-no-run-a",
                sessionKey: "agent:main:main",
                statusText: "Thinking",
                text: "",
                updatedAt: new Date().toISOString(),
            },
        };
        activeStreamsReference.current = activeStreams;
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "First no-run answer",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
                "First no-run answer"
            );
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "First no-run answer",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: { delta: "Second no-run answer" },
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                activeStreamsReference.current["agent:main:main::assistant"]?.text
            ).toBe("Second no-run answer");
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: { sessionKey: "agent:main:main" },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    deltaText: "Third no-run answer",
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(activeStreamsReference.current["agent:main:main"]?.text).toBe(
                "Third no-run answer"
            );
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: "Third no-run answer",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(Object.keys(activeStreamsReference.current)).toHaveLength(0);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Run A",
                    },
                    runId: "overlap-a",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Run B",
                    },
                    runId: "overlap-b",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                activeStreamsReference.current["agent:main:main::overlap-a::assistant"]
                    ?.text
            ).toBe("Run A");
            expect(
                activeStreamsReference.current["agent:main:main::overlap-b::assistant"]
                    ?.text
            ).toBe("Run B");
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    runId: "overlap-a",
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
                    message.text === "Run A"
            )
        ).toBe(true);
        expect(
            activeStreamsReference.current["agent:main:main::overlap-b::assistant"]?.text
        ).toBe("Run B");
        activeStreamsReference.current = {};

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Unscoped A",
                    },
                    runId: "unscoped-a",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "Unscoped B",
                    },
                    runId: "unscoped-b",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "text" in message &&
                    (message.text === "Unscoped A" || message.text === "Unscoped B")
            )
        ).toBe(false);
        expect(
            activeStreamsReference.current["agent:main:main::unscoped-a::assistant"]?.text
        ).toBe("Unscoped A");
        expect(
            activeStreamsReference.current["agent:main:main::unscoped-b::assistant"]?.text
        ).toBe("Unscoped B");
        activeStreamsReference.current = {};

        activeStreamsReference.current["agent:main:main"] = {
            aliases: [],
            runId: "dashboard-chat-legacy",
            sessionKey: "agent:main:main",
            statusText: "Thinking",
            text: "",
            updatedAt: new Date().toISOString(),
        };
        activeStreamsReference.current["agent:main:main::assistant"] = {
            aliases: [],
            runId: "agent:main:main",
            sessionKey: "agent:main:main",
            text: "Legacy buffered answer",
            updatedAt: new Date().toISOString(),
        };
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    sessionKey: "agent:main:main",
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
                    message.text === "Legacy buffered answer"
            )
        ).toBe(true);
        expect(activeStreamsReference.current["agent:main:main"]).toBeUndefined();
        expect(
            activeStreamsReference.current["agent:main:main::assistant"]
        ).toBeUndefined();
        activeStreamsReference.current = {};

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "provisional thinking",
                    },
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
        await waitFor(() => {
            expect(
                activeStreamsReference.current["agent:main:main::thinking"]?.runId
            ).toBe("agent:main:main");
        });
        activeStreamsReference.current["agent:main:main"] = {
            aliases: [],
            runId: "dashboard-chat-test",
            sessionKey: "agent:main:main",
            statusText: "Thinking",
            text: "",
            updatedAt: new Date().toISOString(),
        };
        act(() => {
            listener?.({
                event: "model.completed",
                payload: {
                    runId: "real-runtime-terminal",
                    sessionKey: "agent:main:main",
                },
                type: "event",
            });
        });
        expect(
            activeStreamsReference.current["agent:main:main::thinking"]
        ).toBeUndefined();
        expect(activeStreamsReference.current["agent:main:main"]?.runId).toBe(
            "dashboard-chat-test"
        );
        activeStreamsReference.current = {};

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

        messages = [
            {
                content:
                    "duplicate final answer that is still streaming from a local row",
                local: true,
                role: "assistant",
                runId: "local-duplicate-final-run",
                text: "duplicate final answer that is still streaming from a local row",
                timestamp: new Date().toISOString(),
            },
        ];
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: {
                        role: "assistant",
                        text: "duplicate final answer that is still streaming from a local row and has now finished",
                    },
                    runId: "final-duplicate-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(
            messages.filter(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "assistant" &&
                    "text" in message &&
                    typeof message.text === "string" &&
                    message.text.includes("duplicate final answer")
            )
        ).toHaveLength(1);
        expect((messages[0] as { local?: boolean } | undefined)?.local).toBeUndefined();

        messages = [
            {
                content: "",
                role: "assistant",
                runId: "diagnostic-final-run",
                text: "",
                thinking: [{ text: "diagnostic details" }],
                timestamp: new Date().toISOString(),
            },
        ];
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: {
                        role: "assistant",
                        text: "final text must not overwrite a diagnostic-only row",
                    },
                    runId: "diagnostic-final-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(
            messages.filter(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "assistant"
            )
        ).toHaveLength(2);
        expect(messages[0]).toMatchObject({
            text: "",
            thinking: [{ text: "diagnostic details" }],
        });

        const stableFinalText =
            "Fikset reviewen og pushet til PR #246: 8590a3f.\n\nVerifisert mot kode:\n\nGyldig: recovered-text merge kunne treffe eldre ikke-lokale history-rader.";
        messages = [
            {
                content: stableFinalText,
                role: "assistant",
                text: stableFinalText,
                timestamp: new Date().toISOString(),
            },
        ];
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: {
                        role: "assistant",
                        text: `${stableFinalText}\n\nFikset: isRecoveredAssistantText(...) brukes nå bare når message.local === true treffe eldre ikke-lokale history-rader.`,
                    },
                    runId: "late-corrupt-final-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        const stableFinalRows = messages.filter(
            (message) =>
                typeof message === "object" &&
                message !== null &&
                "role" in message &&
                message.role === "assistant" &&
                "text" in message &&
                typeof message.text === "string" &&
                message.text.includes("Fikset reviewen og pushet")
        );
        expect(stableFinalRows).toHaveLength(1);
        expect(stableFinalRows[0]).toMatchObject({
            text: stableFinalText,
        });

        messages = [
            {
                content: stableFinalText,
                role: "assistant",
                text: stableFinalText,
                timestamp: new Date().toISOString(),
            },
            {
                content: "Repeat that with edits",
                local: true,
                role: "user",
                text: "Repeat that with edits",
                timestamp: new Date().toISOString(),
            },
        ];
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    message: {
                        role: "assistant",
                        text: `${stableFinalText}\n\nAdditional edited follow-up content.`,
                    },
                    runId: "legitimate-follow-up-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                },
                type: "event",
            });
        });
        expect(
            messages.filter(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "role" in message &&
                    message.role === "assistant" &&
                    "text" in message &&
                    typeof message.text === "string" &&
                    message.text.includes("Fikset reviewen og pushet")
            )
        ).toHaveLength(2);

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "partial before error",
                    },
                    runId: "run-2",
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "reasoning before error",
                    },
                    runId: "run-2",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });
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
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "text" in message &&
                    message.text === "partial before error"
            )
        ).toBe(true);
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "thinking" in message &&
                    Array.isArray(message.thinking) &&
                    message.thinking.some((block) =>
                        block.text.includes("reasoning before error")
                    )
            )
        ).toBe(true);

        sendError = undefined;
        setSendError.mockClear();
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        args: { cmd: "sqlite3 backend/data/mira-dashboard.db" },
                        error: "database is locked",
                        isError: true,
                        name: "functions.exec_command",
                        phase: "error",
                    },
                    runId: "run-3",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    errorMessage: "tool call failed",
                    runId: "run-3",
                    sessionKey: "agent:main:main",
                    state: "error",
                },
                type: "event",
            });
        });
        expect(setSendError).not.toHaveBeenCalled();
        expect(sendError).toBeUndefined();
        expect(
            messages.some(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "toolCalls" in message &&
                    Array.isArray(message.toolCalls) &&
                    message.toolCalls.some(
                        (toolCall) =>
                            toolCall.name === "functions.exec_command" &&
                            toolCall.toolResult?.isError === true &&
                            toolCall.toolResult.content.includes("database is locked")
                    )
            )
        ).toBe(true);

        sendError = undefined;
        setSendError.mockClear();
        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        args: { cmd: "still running" },
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    runId: "run-4",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });
        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    errorMessage: "model failed after pending tool",
                    runId: "run-4",
                    sessionKey: "agent:main:main",
                    state: "error",
                },
                type: "event",
            });
        });
        expect(setSendError).toHaveBeenLastCalledWith("model failed after pending tool");
        expect(sendError ?? "").toBe("model failed after pending tool");

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

    it("keeps tool execution errors out of the global chat error", async () => {
        let listener: ((data: unknown) => void) | undefined;
        const unsubscribe = jest.fn();
        const subscribe = jest.fn((nextListener: (data: unknown) => void) => {
            listener = nextListener;
            return unsubscribe;
        });
        let sendError: string | undefined;
        const setSendError = jest.fn((updater) => {
            sendError = typeof updater === "function" ? updater(sendError) : updater;
        });
        const activeStreamsReference: { current: ActiveChatStreams } = { current: {} };
        const updateActiveStreams = jest.fn((updater) => {
            activeStreamsReference.current = updater(activeStreamsReference.current);
        });

        const { rerender, unmount } = renderHook(
            ({ showToolOutput }) =>
                useChatRuntimeEvents({
                    activeStreamsReference,
                    connectionId: 1,
                    isConnected: true,
                    liveHistoryRefreshTimerReference: { current: undefined },
                    request: jest.fn(),
                    selectedSessionKey: "agent:main:main",
                    setHistoryLoadVersion: jest.fn(),
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError,
                    shouldStickToBottomReference: { current: true },
                    showThinkingOutput: true,
                    showToolOutput,
                    subscribe,
                    updateActiveStreams,
                }),
            { initialProps: { showToolOutput: true } }
        );

        await waitFor(() => {
            expect(subscribe).toHaveBeenCalledTimes(1);
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        error: "database is locked",
                        isError: true,
                        name: "functions.exec_command",
                        phase: "error",
                    },
                    runId: "run-hidden-tool-error",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                type: "event",
            });
        });

        rerender({ showToolOutput: false });

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    errorMessage: "tool call failed",
                    runId: "run-hidden-tool-error",
                    sessionKey: "agent:main:main",
                    state: "error",
                },
                type: "event",
            });
        });

        expect(sendError).toBeUndefined();

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    errorMessage:
                        "⚠️ 🛠️ `run lint → run format:check` failed: lint exited with code 1",
                    sessionKey: "agent:main:main",
                    state: "error",
                },
                type: "event",
            });
        });

        expect(sendError).toBeUndefined();
        unmount();
    });

    it("scopes cached tool errors to the selected chat session", async () => {
        let listener: ((data: unknown) => void) | undefined;
        const unsubscribe = jest.fn();
        const subscribe = jest.fn((nextListener: (data: unknown) => void) => {
            listener = nextListener;
            return unsubscribe;
        });
        let sendError: string | undefined;
        const setSendError = jest.fn((updater) => {
            sendError = typeof updater === "function" ? updater(sendError) : updater;
        });
        const activeStreamsReference: { current: ActiveChatStreams } = { current: {} };
        const updateActiveStreams = jest.fn((updater) => {
            activeStreamsReference.current = updater(activeStreamsReference.current);
        });

        const { rerender, unmount } = renderHook(
            ({ selectedSessionKey }) =>
                useChatRuntimeEvents({
                    activeStreamsReference,
                    connectionId: 1,
                    isConnected: true,
                    liveHistoryRefreshTimerReference: { current: undefined },
                    request: jest.fn(),
                    selectedSessionKey,
                    setHistoryLoadVersion: jest.fn(),
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError,
                    shouldStickToBottomReference: { current: true },
                    showThinkingOutput: true,
                    showToolOutput: true,
                    subscribe,
                    updateActiveStreams,
                }),
            { initialProps: { selectedSessionKey: "agent:main:first" } }
        );

        await waitFor(() => {
            expect(subscribe).toHaveBeenCalledTimes(1);
        });

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        error: "first session tool failed",
                        isError: true,
                        name: "functions.exec_command",
                        phase: "error",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:first",
                    stream: "tool",
                },
                type: "event",
            });
        });

        rerender({ selectedSessionKey: "agent:main:second" });

        act(() => {
            listener?.({
                event: "chat",
                payload: {
                    errorMessage: "second session model failed",
                    runId: "run-1",
                    sessionKey: "agent:main:second",
                    state: "error",
                },
                type: "event",
            });
        });

        expect(sendError).toBe("second session model failed");
        unmount();
    });

    it("keeps thinking status visible when thinking output is hidden", async () => {
        let listener: ((message: unknown) => void) | undefined;
        const unsubscribe = jest.fn();
        const activeStreamsReference: { current: ActiveChatStreams } = { current: {} };
        let activeStreams: ActiveChatStreams = {};
        const updateActiveStreams = jest.fn((updater) => {
            activeStreams = updater(activeStreams);
            activeStreamsReference.current = activeStreams;
        });
        const subscribe = jest.fn((nextListener: (data: unknown) => void) => {
            listener = nextListener;
            return unsubscribe;
        });

        const { unmount } = renderHook(() =>
            useChatRuntimeEvents({
                activeStreamsReference,
                connectionId: 1,
                isConnected: true,
                liveHistoryRefreshTimerReference: { current: undefined },
                request: jest.fn(),
                selectedSessionKey: "agent:main:main",
                setHistoryLoadVersion: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError: jest.fn(),
                shouldStickToBottomReference: { current: true },
                showThinkingOutput: false,
                showToolOutput: true,
                subscribe,
                updateActiveStreams,
            })
        );

        act(() => {
            listener?.({
                event: "agent",
                payload: {
                    data: {
                        delta: "hidden reasoning",
                    },
                    runId: "hidden-thinking-run",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                },
                type: "event",
            });
        });

        await waitFor(() => {
            expect(
                activeStreamsReference.current[
                    "agent:main:main::hidden-thinking-run::thinking"
                ]?.statusText
            ).toBe("Thinking");
        });

        unmount();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("folds repeated tool results into matching calls without clobbering", () => {
        const visible = normalizeVisibleChatHistoryMessages(
            [
                {
                    content: [
                        {
                            arguments: { command: "first" },
                            name: "functions.exec_command",
                            type: "toolCall",
                        },
                        {
                            arguments: { command: "second" },
                            name: "functions.exec_command",
                            type: "toolCall",
                        },
                    ],
                    role: "assistant",
                },
                {
                    content: "first output",
                    role: "tool",
                    toolName: "functions.exec_command",
                },
                {
                    content: [
                        {
                            data: "a",
                            mimeType: "image/png",
                            type: "image",
                        },
                    ],
                    role: "tool",
                    toolName: "functions.exec_command",
                },
            ],
            createChatVisibility(true, true)
        );

        expect(visible).toHaveLength(1);
        expect(visible[0]?.toolCalls?.[0]?.toolResult?.content).toBe("first output");
        expect(visible[0]?.toolCalls?.[1]?.toolResult?.images).toHaveLength(1);
        expect(visible.some((message) => message.role === "tool")).toBe(false);

        const mediaVisible = normalizeVisibleChatHistoryMessages(
            [
                {
                    content: [
                        {
                            arguments: { path: "/tmp/chart.png" },
                            name: "functions.image",
                            type: "toolCall",
                        },
                    ],
                    role: "assistant",
                },
                {
                    content: "MEDIA:/tmp/chart.png",
                    role: "tool",
                    toolName: "functions.image",
                },
            ],
            createChatVisibility(true, true)
        );

        expect(mediaVisible).toHaveLength(1);
        expect(mediaVisible[0]?.toolCalls?.[0]?.toolResult?.content).toContain(
            "MEDIA:/tmp/chart.png"
        );
        expect(mediaVisible[0]?.attachments?.[0]?.fileName).toBe("chart.png");

        const idBearingVisible = normalizeVisibleChatHistoryMessages(
            [
                {
                    content: [
                        {
                            arguments: { command: "first" },
                            id: "call-with-id",
                            name: "functions.exec_command",
                            type: "toolCall",
                        },
                    ],
                    role: "assistant",
                    timestamp: "2026-06-28T10:00:00.000Z",
                },
                {
                    content: "unscoped output",
                    role: "tool",
                    timestamp: "2026-06-28T10:01:00.000Z",
                    toolName: "functions.exec_command",
                },
            ],
            createChatVisibility(true, true)
        );
        expect(idBearingVisible).toHaveLength(2);
        expect(idBearingVisible[0]?.toolCalls?.[0]?.toolResult).toBeUndefined();
        expect(idBearingVisible[1]?.role).toBe("tool");

        const completedLaterCallVisible = normalizeVisibleChatHistoryMessages(
            [
                {
                    content: [
                        {
                            arguments: { command: "later" },
                            id: "call-1",
                            name: "functions.exec_command",
                            type: "toolCall",
                        },
                    ],
                    role: "assistant",
                    timestamp: "2026-06-28T10:02:00.000Z",
                },
                {
                    content: "later output",
                    role: "tool",
                    timestamp: "2026-06-28T10:03:00.000Z",
                    toolCallId: "call-1",
                    toolName: "functions.exec_command",
                },
                {
                    content: "older delayed output",
                    role: "tool",
                    timestamp: "2026-06-28T10:04:00.000Z",
                    toolCallId: "call-1",
                    toolName: "functions.exec_command",
                },
            ],
            createChatVisibility(true, true)
        );
        expect(completedLaterCallVisible).toHaveLength(2);
        expect(completedLaterCallVisible[0]?.toolCalls?.[0]?.toolResult?.content).toBe(
            "later output"
        );
        expect(completedLaterCallVisible[1]?.toolResult?.content).toBe(
            "older delayed output"
        );

        const foldedTimestampVisible = normalizeVisibleChatHistoryMessages(
            [
                {
                    content: [
                        {
                            arguments: { command: "fresh" },
                            name: "functions.exec_command",
                            type: "toolCall",
                        },
                    ],
                    role: "assistant",
                    timestamp: "2026-06-28T10:00:00.000Z",
                },
                {
                    content: "fresh output",
                    role: "tool",
                    timestamp: "2026-06-28T10:02:00.000Z",
                    toolName: "functions.exec_command",
                },
            ],
            createChatVisibility(true, true)
        );
        expect(foldedTimestampVisible).toHaveLength(1);
        expect(foldedTimestampVisible[0]?.timestamp).toBe("2026-06-28T10:02:00.000Z");
        expect(foldedTimestampVisible[0]?.toolCalls?.[0]?.toolResult?.content).toBe(
            "fresh output"
        );
    });

    it("keeps live tool results when history briefly lags", () => {
        const optimisticUserMessage = {
            content: "One submitted prompt\n\n\nWith review details",
            role: "user",
            text: "One submitted prompt\n\n\nWith review details",
            timestamp: "2026-07-10T14:59:59.000Z",
        };
        expect(
            mergeWithRecentOptimisticMessages(
                [optimisticUserMessage],
                [
                    {
                        content: "One submitted prompt\n\nWith review details",
                        role: "user",
                        text: "One submitted prompt\n\nWith review details",
                        timestamp: "2026-07-10T15:00:00.000Z",
                    },
                ]
            )
        ).toHaveLength(1);
        expect(
            messageIdentity({
                content: "```text\nfirst\n\n\nsecond\n```",
                role: "user",
                text: "```text\nfirst\n\n\nsecond\n```",
            })
        ).not.toBe(
            messageIdentity({
                content: "```text\nfirst\n\nsecond\n```",
                role: "user",
                text: "```text\nfirst\n\nsecond\n```",
            })
        );

        const repeatedAttachmentOnlyTurns = [
            {
                attachments: [
                    {
                        fileName: "same.txt",
                        id: "persisted-media-path",
                        kind: "text" as const,
                    },
                ],
                content: "",
                role: "user",
                text: "",
                timestamp: "2026-07-10T15:00:00.000Z",
            },
            {
                attachments: [
                    {
                        fileName: "same.txt",
                        id: "persisted-media-path",
                        kind: "text" as const,
                    },
                ],
                content: "",
                role: "user",
                text: "",
                timestamp: "2026-07-10T15:01:00.000Z",
            },
        ];
        expect(
            mergeWithRecentOptimisticMessages([], repeatedAttachmentOnlyTurns)
        ).toHaveLength(2);
        const optimisticAttachmentWithTransientId = {
            attachments: [
                {
                    contentBase64: "c2FtZSBjb250ZW50",
                    fileName: "same.txt",
                    id: "local-random-id",
                    kind: "text" as const,
                    mimeType: "text/plain",
                    sizeBytes: 12,
                },
            ],
            content: "",
            local: true,
            role: "user",
            text: "",
            timestamp: "2026-07-10T15:03:00.000Z",
        };
        const persistedAttachmentWithCanonicalId = {
            ...optimisticAttachmentWithTransientId,
            attachments: [
                {
                    ...optimisticAttachmentWithTransientId.attachments[0]!,
                    id: "inline-same.txt-0",
                },
            ],
            local: undefined,
            timestamp: "2026-07-10T15:03:01.000Z",
        };
        const reconciledTransientAttachmentId = mergeWithRecentOptimisticMessages(
            [optimisticAttachmentWithTransientId],
            [persistedAttachmentWithCanonicalId]
        );
        expect(reconciledTransientAttachmentId).toHaveLength(1);
        expect(reconciledTransientAttachmentId[0]?.attachments).toHaveLength(1);
        expect(reconciledTransientAttachmentId[0]?.local).toBeUndefined();
        expect(messageIdentity(repeatedAttachmentOnlyTurns[0]!)).not.toBe(
            messageIdentity(repeatedAttachmentOnlyTurns[1]!)
        );
        expect(
            mergeWithRecentOptimisticMessages(
                [],
                repeatedAttachmentOnlyTurns.map((turn) => ({
                    ...turn,
                    timestamp: undefined,
                }))
            )
        ).toHaveLength(2);
        const repeatedAssistantMediaTurns = repeatedAttachmentOnlyTurns.map((turn) => ({
            ...turn,
            role: "assistant",
        }));
        expect(
            mergeWithRecentOptimisticMessages([], repeatedAssistantMediaTurns)
        ).toHaveLength(2);
        expect(
            mergeWithRecentOptimisticMessages(
                [],
                repeatedAssistantMediaTurns.map((turn) => ({
                    ...turn,
                    timestamp: undefined,
                }))
            )
        ).toHaveLength(2);
        expect(
            mergeWithRecentOptimisticMessages(
                [],
                repeatedAssistantMediaTurns.map((turn) => ({
                    ...turn,
                    runId: "same-media-run",
                    timestamp: undefined,
                }))
            )
        ).toHaveLength(1);
        expect(
            mergeWithRecentOptimisticMessages(
                [],
                repeatedAssistantMediaTurns.map((turn, index) => ({
                    ...turn,
                    runId: `media-run-${index}`,
                    timestamp: undefined,
                }))
            )
        ).toHaveLength(2);
        const optimisticRepeatedAttachmentTurn = {
            ...repeatedAttachmentOnlyTurns[1]!,
            local: true,
            timestamp: "2026-07-10T15:02:00.000Z",
        };
        expect(
            mergeWithRecentOptimisticMessages(
                [repeatedAttachmentOnlyTurns[0]!, optimisticRepeatedAttachmentTurn],
                [repeatedAttachmentOnlyTurns[0]!]
            )
        ).toHaveLength(2);
        const reconciledRepeatedAttachmentTurns = mergeWithRecentOptimisticMessages(
            [repeatedAttachmentOnlyTurns[0]!, optimisticRepeatedAttachmentTurn],
            [
                repeatedAttachmentOnlyTurns[0]!,
                {
                    ...repeatedAttachmentOnlyTurns[1]!,
                    timestamp: "2026-07-10T15:02:01.000Z",
                },
            ]
        );
        expect(reconciledRepeatedAttachmentTurns).toHaveLength(2);
        expect(
            reconciledRepeatedAttachmentTurns.some((message) => message.local === true)
        ).toBe(false);

        const localMediaMessage = {
            attachments: [
                {
                    fileName: "generated.txt",
                    id: "generated-media",
                    kind: "text" as const,
                },
            ],
            content: "",
            images: [{ data: "generated-image", type: "image" as const }],
            local: true,
            role: "assistant",
            text: "",
            timestamp: "2026-07-10T15:00:00.000Z",
        };
        expect(
            mergeWithRecentOptimisticMessages(
                [localMediaMessage],
                [
                    {
                        content: "Final answer",
                        role: "assistant",
                        text: "Final answer",
                        timestamp: "2026-07-10T15:00:01.000Z",
                    },
                ]
            ).some((message) => message.images?.[0]?.data === "generated-image")
        ).toBe(true);
        expect(
            mergeWithRecentOptimisticMessages(
                [localMediaMessage],
                [{ ...localMediaMessage, local: undefined }]
            )
        ).toHaveLength(1);
        const reconciledAssistantMediaHistory = mergeWithRecentOptimisticMessages(
            [{ ...localMediaMessage, runId: "local-media-run" }],
            [
                {
                    ...localMediaMessage,
                    local: undefined,
                    runId: undefined,
                    timestamp: "2026-07-10T15:00:01.000Z",
                },
            ]
        );
        expect(reconciledAssistantMediaHistory).toHaveLength(1);
        expect(reconciledAssistantMediaHistory[0]?.local).toBeUndefined();
        const mediaRecoveredOnTextFinal = mergeWithRecentOptimisticMessages(
            [localMediaMessage],
            [
                {
                    ...localMediaMessage,
                    content: "Generated file",
                    local: undefined,
                    text: "Generated file",
                    timestamp: "2026-07-10T15:00:01.000Z",
                },
            ]
        );
        expect(mediaRecoveredOnTextFinal).toHaveLength(1);
        expect(mediaRecoveredOnTextFinal[0]?.text).toBe("Generated file");
        const localUserMediaMessage = {
            ...localMediaMessage,
            role: "user",
        };
        const crossRoleMediaHistory = mergeWithRecentOptimisticMessages(
            [localUserMediaMessage],
            [{ ...localMediaMessage, local: undefined }]
        );
        expect(crossRoleMediaHistory).toHaveLength(2);
        expect(
            crossRoleMediaHistory.some(
                (message) => message.role === "user" && message.local === true
            )
        ).toBe(true);

        const localToolRow = {
            content: "",
            local: true,
            role: "assistant",
            text: "",
            timestamp: new Date().toISOString(),
            runId: "tool-row-run",
            toolCalls: [
                {
                    arguments: { command: "git status" },
                    id: "call-1",
                    name: "functions.exec_command",
                    toolResult: {
                        content: "clean",
                        id: "call-1",
                        name: "functions.exec_command",
                    },
                },
            ],
        };
        const staleHistoryRow = {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    arguments: { command: "git status" },
                    id: "call-1",
                    name: "functions.exec_command",
                },
            ],
        };

        const merged = mergeWithRecentOptimisticMessages(
            [localToolRow],
            [staleHistoryRow]
        );

        expect(merged).toHaveLength(1);
        expect(merged[0]?.toolCalls?.[0]?.id).toBe("call-1");
        expect(merged[0]?.toolCalls?.[0]?.toolResult?.content).toBe("clean");
        expect(merged[0]?.timestamp).toBe(localToolRow.timestamp);

        const localThinkingRow = {
            content: [{ text: "Thinking after tool", type: "thinking" }],
            local: true,
            role: "assistant",
            text: "",
            thinking: [{ text: "Thinking after tool" }],
            timestamp: "2026-07-10T15:00:01.000Z",
        };
        const chronologicalMessages = mergeWithRecentOptimisticMessages(
            [
                {
                    ...localToolRow,
                    timestamp: "2026-07-10T15:00:00.000Z",
                },
                localThinkingRow,
            ],
            [
                staleHistoryRow,
                {
                    content: "Final answer",
                    role: "assistant",
                    text: "Final answer",
                    timestamp: "2026-07-10T15:00:02.000Z",
                },
            ]
        );
        expect(chronologicalMessages.map((message) => message.timestamp)).toEqual([
            "2026-07-10T15:00:00.000Z",
            "2026-07-10T15:00:01.000Z",
            "2026-07-10T15:00:02.000Z",
        ]);

        const namedLocalRow = {
            content: "",
            local: true,
            role: "assistant",
            text: "",
            timestamp: new Date().toISOString(),
            runId: "named-tool-row-run",
            toolCalls: [
                {
                    arguments: { command: "git diff" },
                    name: "functions.exec_command",
                    toolResult: {
                        content: "diff output",
                        name: "functions.exec_command",
                    },
                },
            ],
        };
        const namedHistoryRow = {
            content: "",
            role: "assistant",
            text: "",
            timestamp: new Date().toISOString(),
            runId: "named-tool-row-run",
            toolCalls: [
                {
                    arguments: { command: "git diff" },
                    name: "functions.exec_command",
                },
            ],
        };
        const alreadyEnrichedHistoryRow = {
            ...namedHistoryRow,
            toolCalls: [
                {
                    arguments: { command: "git diff" },
                    name: "functions.exec_command",
                    toolResult: {
                        content: "history output",
                        name: "functions.exec_command",
                    },
                },
            ],
        };

        expect(
            mergeWithRecentOptimisticMessages([namedLocalRow], [namedHistoryRow])[0]
                ?.toolCalls?.[0]?.toolResult?.content
        ).toBe("diff output");
        expect(
            mergeWithRecentOptimisticMessages(
                [namedLocalRow],
                [alreadyEnrichedHistoryRow]
            )[0]?.toolCalls?.[0]?.toolResult?.content
        ).toBe("history output");

        const duplicateNameLocalRow = {
            content: "same assistant text",
            local: true,
            role: "assistant",
            text: "same assistant text",
            timestamp: new Date().toISOString(),
            runId: "duplicate-tool-row-run",
            toolCalls: [
                {
                    arguments: { command: "first" },
                    name: "functions.exec_command",
                    toolResult: {
                        content: "first output",
                        name: "functions.exec_command",
                    },
                },
                {
                    arguments: { command: "second" },
                    name: "functions.exec_command",
                    toolResult: {
                        content: "second output",
                        name: "functions.exec_command",
                    },
                },
            ],
        };
        const duplicateNameHistoryRow = {
            content: "same assistant text",
            role: "assistant",
            text: "same assistant text",
            timestamp: new Date().toISOString(),
            runId: "duplicate-tool-row-run",
            toolCalls: [
                {
                    arguments: { command: "first" },
                    name: "functions.exec_command",
                },
                {
                    arguments: { command: "second" },
                    name: "functions.exec_command",
                },
            ],
        };

        expect(
            mergeWithRecentOptimisticMessages(
                [duplicateNameLocalRow],
                [duplicateNameHistoryRow]
            )[0]?.toolCalls?.map((toolCall) => toolCall.toolResult?.content)
        ).toEqual(["first output", "second output"]);
        expect(
            mergeWithRecentOptimisticMessages(
                [duplicateNameLocalRow],
                [{ ...duplicateNameHistoryRow, runId: "new-duplicate-tool-row-run" }]
            )[0]?.toolCalls?.some((toolCall) => toolCall.toolResult)
        ).toBe(false);

        const idlessTextLocalRow = {
            content: "same assistant text with tools",
            local: true,
            role: "assistant",
            text: "same assistant text with tools",
            timestamp: new Date().toISOString(),
            toolCalls: [
                {
                    arguments: { command: "first" },
                    name: "functions.exec_command",
                    toolResult: {
                        content: "first live output",
                        name: "functions.exec_command",
                    },
                },
                {
                    arguments: { command: "second" },
                    name: "functions.exec_command",
                    toolResult: {
                        content: "second live output",
                        name: "functions.exec_command",
                    },
                },
            ],
        };
        const idlessTextHistoryRow = {
            content: "same assistant text with tools",
            role: "assistant",
            text: "same assistant text with tools",
            toolCalls: [
                {
                    arguments: { command: "first" },
                    name: "functions.exec_command",
                },
                {
                    arguments: { command: "second" },
                    name: "functions.exec_command",
                },
            ],
        };
        expect(
            mergeWithRecentOptimisticMessages(
                [idlessTextLocalRow],
                [idlessTextHistoryRow]
            )[0]?.toolCalls?.map((toolCall) => toolCall.toolResult?.content)
        ).toEqual(["first live output", "second live output"]);

        const partialTextLocalToolRow = {
            content: "visible partial answer",
            local: true,
            role: "assistant",
            text: "visible partial answer",
            timestamp: new Date().toISOString(),
            runId: "partial-tool-row-run",
            toolCalls: [
                {
                    arguments: { command: "status" },
                    id: "call-partial",
                    name: "functions.exec_command",
                    toolResult: {
                        content: "status output",
                        id: "call-partial",
                        name: "functions.exec_command",
                    },
                },
            ],
        };
        const partialHistoryToolRow = {
            content: "",
            role: "assistant",
            text: "",
            timestamp: new Date().toISOString(),
            runId: "partial-tool-row-run",
            toolCalls: [
                {
                    arguments: { command: "status" },
                    id: "call-partial",
                    name: "functions.exec_command",
                },
            ],
        };
        expect(
            mergeWithRecentOptimisticMessages(
                [partialTextLocalToolRow],
                [partialHistoryToolRow]
            ).some((message) => message.text === "visible partial answer")
        ).toBe(true);

        const mixedDiagnosticLocalRow = {
            attachments: [
                {
                    fileName: "local-generated.txt",
                    id: "local-generated-media",
                    kind: "text" as const,
                },
            ],
            content: [
                { text: "same visible text", type: "text" },
                { text: "local reasoning", type: "thinking" },
            ],
            images: [{ data: "local-generated-image", type: "image" as const }],
            local: true,
            role: "assistant",
            text: "same visible text",
            thinking: [{ text: "local reasoning" }],
            timestamp: new Date().toISOString(),
        };
        const mixedDiagnosticHistoryRow = {
            attachments: [
                {
                    fileName: "history-generated.txt",
                    id: "history-generated-media",
                    kind: "text" as const,
                },
            ],
            content: "same visible text",
            images: [{ data: "history-generated-image", type: "image" as const }],
            role: "assistant",
            text: "same visible text",
        };
        expect(
            mergeWithRecentOptimisticMessages(
                [mixedDiagnosticLocalRow],
                [mixedDiagnosticHistoryRow]
            )[0]?.thinking?.[0]?.text
        ).toBe("local reasoning");
        expect(
            mergeWithRecentOptimisticMessages(
                [mixedDiagnosticLocalRow],
                [mixedDiagnosticHistoryRow]
            )[0]
        ).toMatchObject({
            attachments: [
                { id: "history-generated-media" },
                { id: "local-generated-media" },
            ],
            images: [
                { data: "history-generated-image" },
                { data: "local-generated-image" },
            ],
        });
        expect(
            mergeStreamMessage(
                {
                    attachments: mixedDiagnosticHistoryRow.attachments,
                    content: "",
                    images: mixedDiagnosticHistoryRow.images,
                    role: "assistant",
                    text: "",
                },
                {
                    attachments: mixedDiagnosticLocalRow.attachments,
                    content: "",
                    images: mixedDiagnosticLocalRow.images,
                    role: "assistant",
                    text: "",
                },
                "",
                "merged-media-stream"
            )
        ).toMatchObject({
            attachments: [
                { id: "history-generated-media" },
                { id: "local-generated-media" },
            ],
            images: [
                { data: "history-generated-image" },
                { data: "local-generated-image" },
            ],
        });
        expect(
            mergeWithRecentOptimisticMessages(
                [mixedDiagnosticLocalRow],
                [
                    {
                        ...mixedDiagnosticHistoryRow,
                        thinking: [{ text: "history reasoning" }],
                    },
                ]
            )[0]?.thinking?.[0]?.text
        ).toBe("history reasoning");

        const firstDoneDiagnostic = {
            ...mixedDiagnosticLocalRow,
            runId: "done-1",
            text: "Done",
            thinking: [{ text: "first done reasoning" }],
        };
        expect(
            mergeWithRecentOptimisticMessages(
                [firstDoneDiagnostic],
                [{ content: "Done", role: "assistant", runId: "done-2", text: "Done" }]
            )[0]?.thinking
        ).toBeUndefined();
        expect(
            mergeWithRecentOptimisticMessages(
                [firstDoneDiagnostic],
                [{ content: "Done", role: "assistant", runId: "done-1", text: "Done" }]
            )[0]?.thinking?.[0]?.text
        ).toBe("first done reasoning");
    });

    it("forces refreshed chat diagnostics to merge before clearing streams", () => {
        const previousMessages = [
            {
                content: "Done",
                role: "assistant",
                text: "Done",
                timestamp: "2026-06-29T03:00:00.000Z",
            },
        ];
        const diagnosticMessages = [
            {
                ...previousMessages[0]!,
                content: [
                    { text: "Done", type: "text" },
                    { text: "recovered reasoning", type: "thinking" },
                ],
                thinking: [{ text: "recovered reasoning" }],
            },
        ];

        expect(nextRefreshedChatMessages(previousMessages, diagnosticMessages)).toBe(
            previousMessages
        );
        expect(
            nextRefreshedChatMessages(previousMessages, diagnosticMessages, true)[0]
                ?.thinking?.[0]?.text
        ).toBe("recovered reasoning");
    });

    it("detects recovered thinking-only active streams", () => {
        const now = Date.now();
        const recentUpdatedAt = new Date(now - 1000).toISOString();
        const quietUpdatedAt = new Date(now - 130_000).toISOString();
        const stream = {
            aliases: [],
            message: {
                attachments: [],
                content: [{ text: "thinking recovered prefix", type: "thinking" }],
                images: [],
                role: "assistant",
                text: "",
                thinking: [{ text: "thinking recovered prefix" }],
            },
            runId: "run-1",
            sessionKey: "agent:main:main",
            text: "",
            updatedAt: recentUpdatedAt,
        };
        const visibleMessages = [
            {
                attachments: [],
                content: [
                    { text: "thinking recovered prefix and suffix", type: "thinking" },
                ],
                images: [],
                role: "assistant",
                text: "",
                thinking: [{ text: "thinking recovered prefix and suffix" }],
            },
        ];

        expect(
            activeStreamRenderableText({
                ...stream,
                message: {
                    content: "Done",
                    role: "assistant",
                    text: "Done",
                },
                text: "Done",
            })
        ).toBe("Done");
        expect(isActiveStreamRecoveredInMessages(stream, visibleMessages, now)).toBe(
            false
        );
        expect(
            isActiveStreamRecoveredInMessages(
                stream,
                [
                    {
                        attachments: [],
                        content: "Previous answer",
                        images: [],
                        role: "assistant",
                        text: "Previous answer",
                    },
                ],
                now,
                false
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "assistant still streaming",
                    },
                    text: "assistant still streaming",
                },
                visibleMessages,
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "assistant still streaming",
                    },
                    text: "assistant still streaming",
                },
                [
                    {
                        ...visibleMessages[0]!,
                        content: [
                            { text: "assistant still streaming", type: "text" },
                            {
                                text: "thinking recovered prefix",
                                type: "thinking",
                            },
                        ],
                        thinking: [{ text: "thinking recovered prefix" }],
                        text: "assistant still streaming",
                    },
                ],
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                { ...stream, updatedAt: quietUpdatedAt },
                visibleMessages,
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "assistant recovered text",
                        thinking: undefined,
                    },
                    text: "assistant recovered text",
                },
                [
                    {
                        attachments: [],
                        content: "assistant recovered text",
                        images: [],
                        role: "assistant",
                        text: "assistant recovered text",
                    },
                ],
                now
            )
        ).toBe(true);
        const mixedTextDiagnosticStream = {
            ...stream,
            message: {
                ...stream.message,
                text: "assistant recovered text",
                thinking: [{ text: "still live reasoning" }],
            },
            text: "assistant recovered text",
        };
        expect(
            isActiveStreamRecoveredInMessages(
                mixedTextDiagnosticStream,
                [
                    {
                        attachments: [],
                        content: "assistant recovered text",
                        images: [],
                        role: "assistant",
                        text: "assistant recovered text",
                    },
                ],
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                mixedTextDiagnosticStream,
                [
                    {
                        attachments: [],
                        content: [
                            { text: "assistant recovered text", type: "text" },
                            { text: "still live reasoning", type: "thinking" },
                        ],
                        images: [],
                        role: "assistant",
                        text: "assistant recovered text",
                        thinking: [{ text: "still live reasoning" }],
                    },
                ],
                now
            )
        ).toBe(true);
        const parallelToolStream = {
            ...stream,
            message: {
                ...stream.message,
                text: "",
                thinking: undefined,
                toolCalls: [
                    { arguments: { command: "git status" }, name: "exec" },
                    { arguments: { command: "git diff" }, name: "exec" },
                ],
            },
            text: "",
        };
        expect(
            isActiveStreamRecoveredInMessages(
                parallelToolStream,
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [
                            { arguments: { command: "git status" }, name: "exec" },
                        ],
                    },
                ],
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                parallelToolStream,
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [
                            { arguments: { command: "git status" }, name: "exec" },
                            { arguments: { command: "git diff" }, name: "exec" },
                        ],
                    },
                ],
                now
            )
        ).toBe(true);
        const duplicateToolStream = {
            ...stream,
            message: {
                ...stream.message,
                text: "",
                thinking: undefined,
                toolCalls: [
                    { arguments: { command: "same" }, name: "exec" },
                    { arguments: { command: "same" }, name: "exec" },
                ],
            },
            text: "",
        };
        expect(
            isActiveStreamRecoveredInMessages(
                duplicateToolStream,
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [{ arguments: { command: "same" }, name: "exec" }],
                    },
                ],
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                duplicateToolStream,
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [
                            { arguments: { command: "same" }, name: "exec" },
                            { arguments: { command: "same" }, name: "exec" },
                        ],
                    },
                ],
                now
            )
        ).toBe(true);
        const toolCallWithResultStream = {
            ...stream,
            message: {
                ...stream.message,
                text: "",
                thinking: undefined,
                toolCalls: [
                    {
                        id: "call-1",
                        name: "exec",
                        toolResult: {
                            content: "ok",
                            id: "call-1",
                            name: "exec",
                        },
                    },
                ],
            },
            text: "",
        };
        expect(
            isActiveStreamRecoveredInMessages(
                toolCallWithResultStream,
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [{ id: "call-1", name: "exec" }],
                    },
                ],
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                toolCallWithResultStream,
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [
                            {
                                id: "call-1",
                                name: "exec",
                                toolResult: {
                                    content: "ok",
                                    id: "call-1",
                                    name: "exec",
                                },
                            },
                        ],
                    },
                ],
                now
            )
        ).toBe(true);
        const mixedTextToolStream = {
            ...stream,
            message: {
                ...stream.message,
                text: "assistant text with tool",
                thinking: undefined,
                toolCalls: [{ id: "call-2", name: "exec" }],
            },
            text: "assistant text with tool",
        };
        expect(
            isActiveStreamRecoveredInMessages(
                mixedTextToolStream,
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [{ id: "call-2", name: "exec" }],
                    },
                ],
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                mixedTextToolStream,
                [
                    {
                        attachments: [],
                        content: "assistant text with tool",
                        images: [],
                        role: "assistant",
                        text: "assistant text with tool",
                        toolCalls: [{ id: "call-2", name: "exec" }],
                    },
                ],
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "",
                        thinking: undefined,
                        toolCalls: [
                            {
                                arguments: { command: "git status" },
                                name: "exec",
                            },
                        ],
                    },
                    text: "",
                },
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [
                            {
                                arguments: { command: "git diff" },
                                name: "exec",
                            },
                        ],
                    },
                ],
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "",
                        thinking: undefined,
                        toolCalls: [{ name: "exec" }],
                    },
                    text: "",
                },
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [{ name: "exec" }],
                    },
                ],
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        thinking: [{ text: "exact thinking recovered" }],
                    },
                },
                [
                    {
                        attachments: [],
                        content: [{ text: "exact thinking recovered", type: "thinking" }],
                        images: [],
                        role: "assistant",
                        text: "",
                        thinking: [{ text: "exact thinking recovered" }],
                    },
                ],
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "",
                        thinking: undefined,
                        toolCalls: [{ id: "call-1", name: "exec" }],
                    },
                    text: "",
                },
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [{ id: "call-1", name: "exec" }],
                    },
                ],
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "",
                        thinking: undefined,
                        toolResult: {
                            content: "ok",
                            id: "call-1",
                            name: "exec",
                        },
                    },
                    text: "",
                },
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolResult: {
                            content: "ok",
                            id: "call-1",
                            name: "exec",
                        },
                    },
                ],
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "",
                        thinking: undefined,
                        toolResult: {
                            content: "ok",
                            name: "exec",
                        },
                    },
                    text: "",
                },
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolResult: {
                            content: "ok",
                            name: "exec",
                        },
                    },
                ],
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "",
                        thinking: undefined,
                        toolResult: {
                            content: "new output",
                            name: "exec",
                        },
                    },
                    text: "",
                },
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolResult: {
                            content: "old output",
                            name: "exec",
                        },
                    },
                ],
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "",
                        thinking: undefined,
                        toolResult: {
                            content: "",
                            images: [
                                {
                                    data: "new-image",
                                    mimeType: "image/png",
                                    type: "image",
                                },
                            ],
                            name: "image_tool",
                        },
                    },
                    text: "",
                },
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolResult: {
                            content: "",
                            images: [
                                {
                                    data: "old-image",
                                    mimeType: "image/png",
                                    type: "image",
                                },
                            ],
                            name: "image_tool",
                        },
                    },
                ],
                now
            )
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                {
                    ...stream,
                    message: {
                        ...stream.message,
                        text: "",
                        thinking: undefined,
                        toolResult: {
                            content: "",
                            images: [
                                {
                                    data: "new-image",
                                    mimeType: "image/png",
                                    type: "image",
                                },
                            ],
                            name: "image_tool",
                        },
                    },
                    text: "",
                },
                [
                    {
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolResult: {
                            content: "",
                            images: [
                                {
                                    data: "new-image",
                                    mimeType: "image/png",
                                    type: "image",
                                },
                            ],
                            name: "image_tool",
                        },
                    },
                ],
                now
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(
                { ...stream, updatedAt: quietUpdatedAt },
                [
                    {
                        attachments: [],
                        content: "thinking recovered prefix and suffix",
                        images: [],
                        role: "user",
                        text: "thinking recovered prefix and suffix",
                    },
                ],
                now
            )
        ).toBe(false);
    });

    it("renders an exact current final instead of its still-settling stream", () => {
        const finalText = "Canonical final response";
        const previousAssistant = {
            content: finalText,
            role: "assistant",
            text: finalText,
        };
        const userMessage = {
            content: "Please answer again",
            role: "user",
            text: "Please answer again",
        };
        const currentFinal = {
            ...previousAssistant,
            runId: "current-run",
            timestamp: "2026-07-10T14:55:00.000Z",
        };
        const activeStream = {
            aliases: [],
            message: currentFinal,
            runId: "current-run",
            sessionKey: "agent:main:main",
            text: finalText,
            updatedAt: "2026-07-10T14:55:00.000Z",
        };
        expect(
            hasExactCurrentAssistantMessage(
                [previousAssistant, userMessage, currentFinal],
                activeStream
            )
        ).toBe(true);
        expect(
            hasExactCurrentAssistantMessage(
                [previousAssistant, userMessage],
                activeStream
            )
        ).toBe(false);
        expect(
            hasExactCurrentAssistantMessage(
                [
                    previousAssistant,
                    {
                        attachments: [
                            {
                                fileName: "prompt.txt",
                                id: "prompt-attachment",
                                kind: "text",
                            },
                        ],
                        content: "",
                        role: "user",
                        text: "",
                    },
                ],
                activeStream
            )
        ).toBe(false);
        expect(hasExactCurrentAssistantMessage([currentFinal], activeStream)).toBe(false);
        expect(
            hasExactCurrentAssistantMessage(
                [
                    previousAssistant,
                    userMessage,
                    { ...currentFinal, runId: "different-run" },
                ],
                activeStream
            )
        ).toBe(false);

        const diagnosticStream = {
            ...activeStream,
            message: {
                ...currentFinal,
                thinking: [{ text: "Unrecovered thinking" }],
                toolCalls: [
                    {
                        arguments: { command: "status" },
                        id: "unrecovered-tool",
                        name: "functions.exec_command",
                    },
                ],
            },
        };
        expect(
            hasExactCurrentAssistantMessage(
                [previousAssistant, userMessage, currentFinal],
                diagnosticStream
            )
        ).toBe(true);
        expect(isActiveStreamRecoveredInMessages(diagnosticStream, [currentFinal])).toBe(
            false
        );
        expect(
            isActiveStreamRecoveredInMessages(diagnosticStream, [
                {
                    ...currentFinal,
                    thinking: diagnosticStream.message.thinking,
                },
            ])
        ).toBe(false);
        expect(
            isActiveStreamRecoveredInMessages(
                diagnosticStream,
                [
                    {
                        ...currentFinal,
                        toolCalls: diagnosticStream.message.toolCalls,
                    },
                ],
                Date.now(),
                false
            )
        ).toBe(true);
        expect(
            isActiveStreamRecoveredInMessages(diagnosticStream, [
                {
                    ...currentFinal,
                    toolCalls: diagnosticStream.message.toolCalls,
                },
            ])
        ).toBe(false);
        expect(
            visibleActiveStreamContent(
                [previousAssistant, userMessage, currentFinal],
                diagnosticStream
            )
        ).toEqual({
            beforeMessageIndex: 2,
            message: {
                ...diagnosticStream.message,
                content: [],
                text: "",
            },
            text: "",
        });
        expect(
            isActiveStreamRecoveredInMessages(diagnosticStream, [
                {
                    ...currentFinal,
                    thinking: diagnosticStream.message.thinking,
                    toolCalls: diagnosticStream.message.toolCalls,
                },
            ])
        ).toBe(true);
    });

    it("keeps current thinking after tools and before final text", () => {
        const userRow = {
            key: "user",
            kind: "message" as const,
            message: {
                content: "Run a check",
                role: "user",
                text: "Run a check",
                timestamp: "2026-07-10T15:00:00.000Z",
            },
        };
        const preambleRow = {
            key: "preamble",
            kind: "message" as const,
            message: {
                content: "Checking now",
                role: "assistant",
                text: "Checking now",
                timestamp: "2026-07-10T15:00:01.000Z",
            },
        };
        const toolRow = {
            key: "tool",
            kind: "message" as const,
            message: {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-10T15:00:02.000Z",
                toolCalls: [{ id: "tool-1", name: "bash" }],
            },
        };
        const thinkingRow = {
            key: "thinking",
            kind: "stream" as const,
            message: {
                content: [{ text: "Reviewing output", type: "thinking" }],
                role: "assistant",
                text: "",
                thinking: [{ text: "Reviewing output" }],
                timestamp: "2026-07-10T15:00:03.000Z",
            },
        };
        const finalStreamRow = {
            key: "final-stream",
            kind: "stream" as const,
            message: {
                content: "Everything passed",
                role: "assistant",
                text: "Everything passed",
                timestamp: "2026-07-10T15:00:04.000Z",
            },
        };
        const activityRow = {
            key: "activity",
            kind: "typing" as const,
            message: {
                content: "Thinking",
                role: "assistant",
                text: "Thinking",
            },
        };

        expect(
            orderCurrentResponseRows([
                userRow,
                preambleRow,
                toolRow,
                finalStreamRow,
                thinkingRow,
                activityRow,
            ]).map((row) => row.key)
        ).toEqual(["user", "preamble", "tool", "thinking", "final-stream", "activity"]);

        const finalHistoryRow = {
            ...finalStreamRow,
            key: "final-history",
            kind: "message" as const,
        };
        expect(
            orderCurrentResponseRows([
                userRow,
                preambleRow,
                thinkingRow,
                toolRow,
                finalHistoryRow,
            ]).map((row) => row.key)
        ).toEqual(["user", "preamble", "tool", "thinking", "final-history"]);
        expect(
            orderCurrentResponseRows([userRow, preambleRow, toolRow, thinkingRow]).map(
                (row) => row.key
            )
        ).toEqual(["user", "tool", "thinking", "preamble"]);
        expect(
            orderCurrentResponseRows([
                userRow,
                preambleRow,
                finalStreamRow,
                thinkingRow,
            ]).map((row) => row.key)
        ).toEqual(["user", "preamble", "thinking", "final-stream"]);
        const previousThinkingRow = {
            ...thinkingRow,
            key: "previous-thinking",
            message: {
                ...thinkingRow.message,
                thinking: [{ text: "Previous reasoning" }],
                timestamp: "2026-07-10T14:59:58.000Z",
            },
        };
        const previousFinalRow = {
            ...finalHistoryRow,
            key: "previous-final",
            message: {
                ...finalHistoryRow.message,
                text: "Previous answer",
                timestamp: "2026-07-10T14:59:59.000Z",
            },
        };
        expect(
            orderCurrentResponseRows([
                userRow,
                previousThinkingRow,
                previousFinalRow,
                thinkingRow,
                finalHistoryRow,
            ]).map((row) => row.key)
        ).toEqual([
            "user",
            "previous-thinking",
            "previous-final",
            "thinking",
            "final-history",
        ]);
        expect(
            orderCurrentResponseRows([userRow, finalHistoryRow, toolRow]).map(
                (row) => row.key
            )
        ).toEqual(["user", "tool", "final-history"]);
        const lateThinkingRow = {
            ...thinkingRow,
            key: "late-thinking",
            message: {
                ...thinkingRow.message,
                runId: "late-thinking-run",
                timestamp: "2026-07-10T15:00:05.000Z",
            },
        };
        const earlierHistoryFinalRow = {
            ...finalHistoryRow,
            key: "earlier-history-final",
            message: {
                ...finalHistoryRow.message,
                runId: "late-thinking-run",
                timestamp: "2026-07-10T15:00:04.000Z",
            },
        };
        expect(
            orderCurrentResponseRows([
                userRow,
                earlierHistoryFinalRow,
                lateThinkingRow,
            ]).map((row) => row.key)
        ).toEqual(["user", "late-thinking", "earlier-history-final"]);

        expect(
            insertIndexedStreamRows(
                [userRow, toolRow, finalHistoryRow],
                [
                    { beforeMessageIndex: 2, row: activityRow },
                    { beforeMessageIndex: 1, row: thinkingRow },
                ]
            ).map((row) => row.key)
        ).toEqual(["user", "thinking", "tool", "activity", "final-history"]);
    });

    it("restores a prior same-identity prompt when an optimistic retry fails", () => {
        const previousMessage = {
            content: "Retry this",
            role: "user",
            text: "Retry this",
            timestamp: "2026-07-10T15:00:00.000Z",
        };
        const failedMessage = {
            ...previousMessage,
            timestamp: "2026-07-10T15:01:00.000Z",
        };
        expect(
            rollbackFailedOptimisticMessage([failedMessage], failedMessage, [
                { index: 0, message: previousMessage },
            ])
        ).toEqual([previousMessage]);
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
                                toolCalls: [{ id: "tool-1", name: "exec" }],
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

        expect(
            screen.getByText("Exec").closest("[class*='border-amber']")
        ).not.toContainElement(screen.getByText("answer"));

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

    it("renders file content variants and editable text changes", async () => {
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

        rerender(
            <FileContentViewer
                fileContent={{ ...baseFile, path: "/tmp/notes.md" }}
                editedContent="# Previewed notes"
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={true}
                markdownPreview={true}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        await waitFor(() => {
            expect(
                screen.getByRole("heading", { name: "Previewed notes" })
            ).toBeInTheDocument();
        });

        rerender(
            <FileContentViewer
                fileContent={{ ...baseFile, path: "/tmp/config.json" }}
                editedContent={JSON.stringify({ foo: "viewer" }, undefined, 2)}
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={true}
                markdownPreview={false}
                jsonPreview={true}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        await waitFor(() => {
            expect(screen.getByText("foo")).toBeInTheDocument();
            expect(
                screen.getByText((_content, element) =>
                    Boolean(
                        element?.classList.contains("string-value") &&
                        element.textContent?.includes("viewer")
                    )
                )
            ).toBeInTheDocument();
        });

        rerender(
            <FileContentViewer
                fileContent={{ ...baseFile, path: "/tmp/script.ts" }}
                editedContent="const previewed = true;"
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={true}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        await waitFor(() => {
            expect(screen.getByText(/previewed/)).toBeInTheDocument();
        });

        rerender(<MarkdownPreview content={"# Notes\n\n- one"} />);
        expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();

        rerender(<JsonPreview content="{foo: 'bar'}" />);
        expect(screen.getByText("foo")).toBeInTheDocument();

        rerender(<JsonPreview content={"{not json"} />);
        expect(
            screen.getAllByText((_content, element) =>
                Boolean(element?.textContent?.includes("Failed to parse JSON"))
            ).length
        ).toBeGreaterThan(0);

        rerender(<CodePreview language="ts" content="const covered = true;" />);
        expect(screen.getByText(/covered/)).toBeInTheDocument();
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

    it("keeps cached report metrics visible when a refresh fails", async () => {
        const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === "/api/reports") {
                throw new Error("Reports refresh failed");
            }

            throw new Error(`Unexpected reports overview fetch: ${url}`);
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const queryClient = createQueryClient();
        queryClient.setQueryData(reportKeys.list(), {
            items: [
                {
                    bodyMd: "Heartbeat looks good.",
                    createdAt: "2026-06-24T10:05:00.000Z",
                    dedupeKey: "heartbeat:ok",
                    id: 1,
                    metadata: {},
                    occurredAt: "2026-06-24T10:05:00.000Z",
                    source: "openclaw",
                    sourceJobId: "heartbeat",
                    status: "ok",
                    summary: "Heartbeat looks good.",
                    title: "Cached heartbeat report",
                    type: "heartbeat",
                    updatedAt: "2026-06-24T10:05:00.000Z",
                },
            ],
        });

        render(
            <QueryClientProvider client={queryClient}>
                <ReportsOverviewCard />
            </QueryClientProvider>
        );

        await act(async () => {
            await queryClient.invalidateQueries({ queryKey: reportKeys.list() });
        });
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/reports",
                expect.objectContaining({ credentials: "include" })
            );
            expect(queryClient.getQueryState(reportKeys.list())?.status).toBe("error");
        });

        expect(screen.queryByText("Reports unavailable.")).not.toBeInTheDocument();
        expect(screen.getByText(/Cached heartbeat report/)).toBeInTheDocument();

        queryClient.clear();
    });

    it("drives dashboard cards, file tree/config branches, and session action hook", async () => {
        const user = userEvent.setup();
        let realRunRequests = 0;
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
                                lastRun: {
                                    id: 1,
                                    jobId: "ops.log-rotation",
                                    status: "success",
                                    triggerType: "schedule",
                                    startedAt: "2026-06-24T09:59:00.000Z",
                                    finishedAt: "2026-06-24T10:00:00.000Z",
                                    output: {},
                                },
                                name: "Log rotation",
                                nextRunAt: "2026-06-24T22:30:00.000Z",
                                scheduleType: "cron",
                                cronExpression: "30 22 * * *",
                                updatedAt: "2026-06-24T08:00:00.000Z",
                            },
                        ],
                    });
                }

                if (url === "/api/reports") {
                    return Response.json({
                        items: [
                            {
                                bodyMd: "Heartbeat looks good.",
                                createdAt: "2026-06-24T10:05:00.000Z",
                                dedupeKey: "heartbeat:ok",
                                id: 1,
                                metadata: {},
                                occurredAt: "2026-06-24T10:05:00.000Z",
                                source: "openclaw",
                                sourceJobId: "heartbeat",
                                status: "ok",
                                summary: "Heartbeat looks good.",
                                title: "Heartbeat report",
                                type: "heartbeat",
                                updatedAt: "2026-06-24T10:05:00.000Z",
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

                if (url === "/api/ops/log-rotation/dry-run") {
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
                            isDryRun: true,
                            isOk: true,
                            rotatedFiles: 0,
                            skippedFiles: 0,
                            startedAt: "2026-06-24T10:00:00.000Z",
                            warnings: [],
                        },
                        stderr: "",
                    });
                }

                if (url === "/api/jobs/ops.log-rotation/run") {
                    realRunRequests += 1;
                    if (realRunRequests === 1) {
                        return Response.json(
                            { error: "Scheduled job is already running" },
                            { status: 409 }
                        );
                    }
                    return Response.json({
                        isOk: false,
                        run: {
                            id: 2,
                            jobId: "ops.log-rotation",
                            status: "failed",
                            triggerType: "manual",
                            startedAt: "2026-06-24T10:00:00.000Z",
                            finishedAt: "2026-06-24T10:01:00.000Z",
                            message: "Log file changed during rotation",
                            output: {
                                logRotation: {
                                    result: {
                                        errors: ["Jackett log changed"],
                                        isOk: false,
                                    },
                                    stderr: "rotation stderr",
                                },
                            },
                        },
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
                <JobsOverviewCard />
                <ReportsOverviewCard />
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
                            fiveHourLeftPercent: undefined,
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
                            limit: 10,
                            limitRemaining: 6,
                            limitReset: "monthly",
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
            expect(screen.getByText("Jobs")).toBeInTheDocument();
            expect(screen.getByText("OpenClaw cron")).toBeInTheDocument();
            expect(screen.getByText("Reports")).toBeInTheDocument();
            expect(
                screen.getByText(/5h unlimited · weekly 30% left/i)
            ).toBeInTheDocument();
            expect(screen.getByText(/Resets weekly/i)).toBeInTheDocument();
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
            expect(
                screen.getByText("Scheduled job is already running", { exact: false })
            ).toBeInTheDocument();
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
                "/api/jobs/ops.log-rotation/run",
                expect.objectContaining({ method: "POST" })
            );
            expect(
                screen.getByText("Log file changed during rotation", { exact: false })
            ).toBeInTheDocument();
            expect(
                screen.getByText("Jackett log changed", { exact: false })
            ).toBeInTheDocument();
            expect(
                screen.getByText("rotation stderr", { exact: false })
            ).toBeInTheDocument();
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
        await user.type(screen.getByPlaceholderText("Search skills..."), " browser ");
        await user.click(screen.getByRole("button", { name: "disabled" }));
        await user.click(screen.getByRole("button", { name: "Built-in 1 skills" }));
        await user.click(screen.getAllByRole("switch").at(-1)!);
        expect(onToggleSkill).toHaveBeenCalledWith("browser", true);

        await user.click(screen.getByRole("button", { name: "Agent access control" }));
        await user.type(screen.getByPlaceholderText("Filter tools..."), " web search ");
        await user.click(screen.getByText("Researcher"));
        await user.click(screen.getAllByRole("switch").at(-1)!);
        await user.click(screen.getByRole("button", { name: "Save access control" }));
        const latestSaveCall = onSaveAgents.mock.calls.at(-1) as
            [Array<{ id: string; tools?: { allow?: string[] } }>] | undefined;
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

    it("drives settings form sections through expanded save controls", async () => {
        const user = userEvent.setup();
        const onSaveHeartbeat = jest.fn(async () => {});
        const onSaveModel = jest.fn(async () => {});
        const onSaveSession = jest.fn(async () => {});
        const onSaveTools = jest.fn(async () => {});

        const heartbeatView = render(
            <HeartbeatSection
                every={300}
                target="webchat"
                onSave={onSaveHeartbeat}
                saving={false}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: /heartbeat/i }));
        fireEvent.change(screen.getByLabelText("Interval (seconds)"), {
            target: { value: "600" },
        });
        fireEvent.change(screen.getByLabelText("Target Channel"), {
            target: { value: "discord" },
        });
        await user.click(screen.getByRole("button", { name: /^save$/i }));
        expect(onSaveHeartbeat).toHaveBeenCalledWith(600, "discord");
        heartbeatView.unmount();

        const modelView = render(
            <ModelSection
                defaultModel="codex"
                fallbacks={["glm51"]}
                imageModel={undefined}
                imageGenerationModel="gpt-image"
                onSave={onSaveModel}
                saving={false}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: /model configuration/i }));
        fireEvent.change(screen.getByLabelText("Default model"), {
            target: { value: "openai/gpt-5.5" },
        });
        fireEvent.change(screen.getByLabelText("Fallback models"), {
            target: { value: "glm51, kimi, codex-mini" },
        });
        await user.click(screen.getByRole("button", { name: /save model settings/i }));
        expect(onSaveModel).toHaveBeenCalledWith({
            primary: "openai/gpt-5.5",
            fallbacks: ["glm51", "kimi", "codex-mini"],
        });
        modelView.unmount();

        const sessionView = render(
            <SessionSection idleMinutes={60} onSave={onSaveSession} saving={false} />
        );
        fireEvent.click(screen.getByRole("button", { name: /^session$/i }));
        fireEvent.change(screen.getByLabelText(/idle timeout/i), {
            target: { value: "90" },
        });
        await user.click(screen.getByRole("button", { name: /^save$/i }));
        expect(onSaveSession).toHaveBeenCalledWith(90);
        sessionView.unmount();

        render(
            <ToolSection
                profile="safe"
                webSearchEnabled={false}
                webSearchProvider="brave"
                webFetchEnabled={true}
                execSecurity="allowlist"
                execAsk="on-miss"
                elevatedEnabled={false}
                agentToAgentEnabled={true}
                sessionsVisibility="owned"
                onSave={onSaveTools}
                saving={false}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: /^tools$/i }));
        fireEvent.change(screen.getByLabelText("Tool profile"), {
            target: { value: "full" },
        });
        fireEvent.change(screen.getByLabelText("Web search provider"), {
            target: { value: "brave-search" },
        });
        fireEvent.change(screen.getByLabelText("Sessions visibility"), {
            target: { value: "all" },
        });
        await user.click(screen.getByRole("switch", { name: "Web search" }));
        await user.click(screen.getByRole("switch", { name: "Elevated tools" }));
        await user.click(screen.getByRole("button", { name: /save tool settings/i }));
        expect(onSaveTools).toHaveBeenCalledWith(
            expect.objectContaining({
                elevatedEnabled: true,
                profile: "full",
                sessionsVisibility: "all",
                webSearchEnabled: true,
                webSearchProvider: "brave-search",
            })
        );
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
                emptyMessage="No cron sessions found"
                onCompact={onCompact}
                onReset={onReset}
                onDelete={onDelete}
            />
        );
        expect(screen.getByText("No cron sessions found")).toBeInTheDocument();

        await act(async () => {
            rerender(
                <SessionsTable
                    sessions={[session]}
                    onCompact={onCompact}
                    onReset={onReset}
                    onDelete={onDelete}
                />
            );
        });
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

        await act(async () => {
            rerender(
                <SessionsTable
                    sessions={[{ ...session, maxTokens: 0, tokenCount: 0 }]}
                    onCompact={onCompact}
                    onReset={onReset}
                    onDelete={onDelete}
                />
            );
        });
        expect(screen.getAllByText("Unknown")).toHaveLength(2);
        expect(screen.queryByText("0.0k / 200k")).not.toBeInTheDocument();

        await act(async () => {
            rerender(
                <SessionsTable
                    sessions={[{ ...session, totalTokensFresh: false }]}
                    onCompact={onCompact}
                    onReset={onReset}
                    onDelete={onDelete}
                />
            );
        });
        expect(screen.getAllByText("~0.1k / 1k (stale)")).toHaveLength(2);
        expect(screen.queryByText("13%")).not.toBeInTheDocument();
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
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

            rerender(
                <PgBouncerPoolsTable
                    data={[
                        {
                            cl_active: "2",
                            cl_waiting: "1",
                            database: "mira",
                            maxwait: "0",
                            pool_mode: "transaction",
                            sv_active: "1",
                            sv_idle: "2",
                            sv_used: "3",
                            user: "dashboard",
                        },
                    ]}
                />
            );
            expect(screen.getAllByText("dashboard").length).toBeGreaterThan(0);
            expect(screen.getAllByText("6").length).toBeGreaterThan(0);

            rerender(
                <PgBouncerStatsTable
                    data={[
                        {
                            avg_query_time: "1.2",
                            avg_xact_time: "3.4",
                            database: "mira",
                            total_query_time: "50",
                            total_query_count: "42",
                            total_received: "100",
                            total_sent: "200",
                            total_xact_count: "21",
                            total_xact_time: "30",
                        },
                    ]}
                />
            );
            expect(screen.getAllByText("Avg query").length).toBeGreaterThan(0);
            expect(screen.getAllByText("42").length).toBeGreaterThan(0);

            rerender(
                <DatabasesTable
                    databases={[
                        {
                            blks_hit: "999",
                            blks_read: "1",
                            cache_hit_ratio: "99.9",
                            datname: "dashboard",
                            numbackends: "1",
                            size_bytes: "1048576",
                            size_pretty: "1024 kB",
                            xact_commit: "100",
                            xact_rollback: "0",
                        },
                    ]}
                    pools={[]}
                    stats={[
                        {
                            avg_query_time: "1.2",
                            avg_xact_time: "3.4",
                            database: "dashboard",
                            total_query_count: "1234567",
                            total_query_time: "50",
                            total_received: "100",
                            total_sent: "200",
                            total_xact_count: "21",
                            total_xact_time: "30",
                        },
                    ]}
                />
            );
            expect(screen.getAllByText("1,234,567").length).toBeGreaterThan(0);

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

    it("labels cache refresh controls by entry and refreshes grouped keys", async () => {
        const user = userEvent.setup();
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/cache/status" && method === "GET") {
                    return Response.json({
                        count: 2,
                        entries: [
                            {
                                consecutiveFailures: 0,
                                data: {},
                                errorCode: undefined,
                                errorMessage: undefined,
                                expiresAt: undefined,
                                key: "weather.spydeberg",
                                lastAttemptAt: undefined,
                                meta: {},
                                source: "weather",
                                status: "fresh",
                                updatedAt: "2026-06-24T08:00:00.000Z",
                            },
                            {
                                consecutiveFailures: 0,
                                data: {},
                                errorCode: undefined,
                                errorMessage: undefined,
                                expiresAt: undefined,
                                key: "moltbook.home",
                                lastAttemptAt: undefined,
                                meta: {},
                                source: "moltbook",
                                status: "stale",
                                updatedAt: "2026-06-24T07:00:00.000Z",
                            },
                        ],
                        generatedAt: "2026-06-24T08:01:00.000Z",
                    });
                }

                if (url.startsWith("/api/cache/") && url.endsWith("/refresh")) {
                    return Response.json({
                        entry: {
                            key: decodeURIComponent(
                                url.replace("/api/cache/", "").replace("/refresh", "")
                            ),
                        },
                        isOk: true,
                    });
                }

                throw new Error(`Unexpected cache card fetch: ${method} ${url}`);
            }
        );

        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const view = renderWithQueryClient(
            <CacheStatusCard
                title="Cache controls"
                items={[
                    {
                        key: "weather.spydeberg",
                        label: "Weather",
                    },
                    {
                        key: "moltbook.home",
                        label: "Moltbook",
                        refreshKeys: ["moltbook.home", "moltbook.feed.hot"],
                    },
                ]}
            />
        );

        const weatherRefresh = await screen.findByRole("button", {
            name: /force update weather/i,
        });
        expect(
            screen.getByRole("button", { name: /force update moltbook/i })
        ).toHaveAttribute("title", "Force update Moltbook");

        await user.click(weatherRefresh);
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/weather.spydeberg/refresh",
                expect.objectContaining({ method: "POST" })
            );
        });

        await user.click(screen.getByRole("button", { name: /force update moltbook/i }));
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/moltbook.home/refresh",
                expect.objectContaining({ method: "POST" })
            );
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/moltbook.feed.hot/refresh",
                expect.objectContaining({ method: "POST" })
            );
        });
        view.unmount();
        view.queryClient.clear();
    });

    it("shows Docker cache unavailable when the cached payload is invalid", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async () =>
                Response.json({
                    consecutiveFailures: 1,
                    data: "",
                    key: "docker.summary",
                    meta: {},
                    source: "backend",
                    status: "error",
                })
            ),
            writable: true,
        });

        const view = renderWithQueryClient(<DockerOverviewCard />);

        expect(await screen.findByText("Docker cache unavailable.")).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });

    it("shows database cache unavailable when the cached payload is invalid", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async () =>
                Response.json({
                    consecutiveFailures: 1,
                    data: "",
                    key: "database.summary",
                    meta: {},
                    source: "backend",
                    status: "error",
                })
            ),
            writable: true,
        });

        const view = renderWithQueryClient(<DatabaseOverviewCard />);

        expect(
            await screen.findByText("Database cache unavailable.")
        ).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
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
