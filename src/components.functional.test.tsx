import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";
import type { RefObject } from "react";

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
import { useChatSlashCommands } from "./components/features/chat/useChatSlashCommands";
import { CronJobDetails } from "./components/features/cron/CronJobDetails";
import { CronJobList } from "./components/features/cron/CronJobList";
import { FileContentViewer } from "./components/features/files/FileContentViewer";
import { PreviewToggle } from "./components/features/files/PreviewToggle";
import { LogLine } from "./components/features/logs/LogLine";
import { MyCommentCard } from "./components/features/moltbook/MyCommentCard";
import { MyPostCard } from "./components/features/moltbook/MyPostCard";
import { ProfileCard } from "./components/features/moltbook/ProfileCard";
import { SessionActionsDropdown } from "./components/features/sessions/SessionActionsDropdown";
import { SessionsTable } from "./components/features/sessions/SessionsTable";
import { Alert } from "./components/ui/Alert";
import { getProgressColor, ProgressBar } from "./components/ui/ProgressBar";

function textToBase64(text: string): string {
    return new TextEncoder().encode(text).toBase64();
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
                hasInvalidJson={false}
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
        expect(onSave).toHaveBeenCalledWith(job);
        expect(screen.getByText("Invalid JSON: bad")).toBeInTheDocument();
        expect(screen.getByText("Save failed")).toBeInTheDocument();
        expect(screen.getByText("Running job...")).toBeInTheDocument();
    });
});
