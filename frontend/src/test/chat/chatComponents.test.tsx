import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type RefObject, type SetStateAction, useState } from "react";

import type { Session } from "../../../../contracts/sessions";
import { AttachmentPreviewModal } from "../../components/features/chat/AttachmentPreviewModal";
import { ChatAttachmentPickerModal } from "../../components/features/chat/ChatAttachmentPickerModal";
import {
    base64ToText as messageListBase64ToText,
    CHAT_ATTACHMENT_ACCEPT,
    previewFromAttachment,
} from "../../components/features/chat/chatAttachmentUtilities";
import { ChatComposer } from "../../components/features/chat/ChatComposer";
import { ChatHeader } from "../../components/features/chat/ChatHeader";
import { AttachmentIcon } from "../../components/features/chat/ChatMessageAttachments";
import { ChatMessageDetails } from "../../components/features/chat/ChatMessageDetails";
import { messageIdentity } from "../../components/features/chat/chatMessageIdentity";
import {
    mergeWithRecentOptimisticMessages,
    rollbackFailedOptimisticMessage,
} from "../../components/features/chat/chatMessageReconciliation";
import { ChatMessagesList } from "../../components/features/chat/ChatMessagesList";
import { chatThinkingOptions } from "../../components/features/chat/chatSettings";
import { executeChatSlashCommand } from "../../components/features/chat/chatSlashCommandHandler";
import type {
    ChatHistoryMessage,
    ChatSendAttachment,
} from "../../components/features/chat/chatTypes";
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
describe("Dashboard chat components", () => {
    it("renders chat attachment previews, header status, and diagnostic details", async () => {
        const onClose = jest.fn();
        const onToggleThinking = jest.fn();
        const onToggleTools = jest.fn();
        const onSelectAgent = jest.fn();
        const onSelectSession = jest.fn();
        const onSelectThinkingLevel = jest.fn();
        const onSelectSpeed = jest.fn();
        const onCompact = jest.fn();
        const onDynamicContentLoad = jest.fn();
        const { rerender } = render(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "image",
                    mimeType: "image/png",
                    sizeBytes: 0,
                    title: "Preview image",
                    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl4sAAAAASUVORK5CYII=",
                }}
                onClose={onClose}
            />
        );
        expect(screen.getByAltText("Preview image")).toBeInTheDocument();
        expect(screen.getByText("File type")).toBeInTheDocument();
        expect(screen.getByText("image/png")).toBeInTheDocument();
        expect(screen.getByText("0 B")).toBeInTheDocument();
        expect(
            screen.getByRole("link", {
                name: "Download file",
            })
        ).toHaveAttribute("download", "Preview image");
        const attachmentPreviewDialog = screen.getByRole("dialog", {
            name: "Preview image",
        });
        expect(
            attachmentPreviewDialog.querySelector('[data-modal-scroll-owner="content"]')
        ).toBeInTheDocument();
        expect(
            attachmentPreviewDialog.querySelector("[data-attachment-preview-scroll]")
        ).toHaveClass("overflow-auto");
        expect(
            attachmentPreviewDialog.querySelectorAll(".overflow-auto, .overflow-y-auto")
        ).toHaveLength(1);
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
        const previewFetch = jest.fn(() =>
            Promise.try(
                () =>
                    new Response('{"name":"Mira","items":[1,2]}', {
                        headers: {
                            "Content-Type": "text/plain; charset=utf-8",
                        },
                    })
            )
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: previewFetch,
            writable: true,
        });
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "text",
                    mimeType: "application/json",
                    title: "data.json",
                    url: "/api/media?path=data.json",
                }}
                onClose={onClose}
            />
        );
        await waitFor(() => {
            expect(
                screen.getByRole("dialog", {
                    name: "data.json",
                })
            ).toHaveTextContent("Mira");
        });
        expect(previewFetch).toHaveBeenCalledWith(
            "/api/media?path=data.json&preview=text",
            expect.objectContaining({
                headers: {
                    Accept: "text/plain",
                },
            })
        );
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "text",
                    mimeType: "text/csv",
                    title: "managed.csv",
                    url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
                }}
                onClose={onClose}
            />
        );
        await waitFor(() => {
            expect(previewFetch).toHaveBeenLastCalledWith(
                "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full?preview=text",
                expect.objectContaining({
                    headers: {
                        Accept: "text/plain",
                    },
                })
            );
        });
        const previewFetchCallCount = previewFetch.mock.calls.length;
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "text",
                    mimeType: "text/csv",
                    title: "external.csv",
                    url: "https://files.example.test/external.csv",
                }}
                onClose={onClose}
            />
        );
        await waitFor(() => {
            expect(previewFetch).toHaveBeenCalledTimes(previewFetchCallCount);
            expect(
                screen.getByText(
                    "Preview is not available for this file type yet. Use the download link above to open it locally."
                )
            ).toBeInTheDocument();
        });
        expect(
            screen.getByRole("link", {
                name: "Download file",
            })
        ).toHaveAttribute("href", "https://files.example.test/external.csv");
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "text",
                    mimeType: "text/markdown",
                    text: "# Attachment heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![tracking pixel](https://files.example.test/pixel.png)",
                    title: "readme.md",
                    url: "data:text/markdown;base64,IyBBdHRhY2htZW50IGhlYWRpbmc=",
                }}
                onClose={onClose}
            />
        );
        expect(
            screen.getByRole("heading", {
                name: "Attachment heading",
            })
        ).toBeInTheDocument();
        expect(screen.getByRole("table")).toBeInTheDocument();
        expect(
            screen.queryByRole("img", {
                name: "tracking pixel",
            })
        ).not.toBeInTheDocument();
        expect(screen.getByText("[Image: tracking pixel]")).toBeInTheDocument();
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "image",
                    mimeType: "image/png",
                    title: "local-photo.png",
                    url: "/api/media?path=local-photo.png",
                }}
                onClose={onClose}
            />
        );
        expect(screen.getByAltText("local-photo.png")).toHaveAttribute(
            "src",
            "/api/media?path=local-photo.png"
        );
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "image",
                    mimeType: "image/svg+xml; charset=utf-8",
                    title: "logo.svg",
                    url: "/api/media?path=logo.svg",
                }}
                onClose={onClose}
            />
        );
        expect(screen.getByAltText("logo.svg")).toHaveAttribute(
            "src",
            "/api/media?path=logo.svg&preview=image"
        );
        expect(
            screen.getByRole("link", {
                name: "Download file",
            })
        ).toHaveAttribute("href", "/api/media?path=logo.svg");
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "image",
                    mimeType: "image/svg+xml; charset=utf-8",
                    title: "managed-logo.svg",
                    url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
                }}
                onClose={onClose}
            />
        );
        expect(screen.getByAltText("managed-logo.svg")).toHaveAttribute(
            "src",
            "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full?preview=image"
        );
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "image",
                    mimeType: "image/png",
                    title: "managed-photo.png",
                    url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174003/full",
                }}
                onClose={onClose}
            />
        );
        expect(screen.getByAltText("managed-photo.png")).toHaveAttribute(
            "src",
            "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174003/full?preview=image"
        );
        expect(
            screen.getByRole("link", {
                name: "Download file",
            })
        ).toHaveAttribute(
            "href",
            "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174003/full"
        );
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
                previewItem={{
                    kind: "file",
                    title: "historic.bin",
                }}
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
                            {
                                id: "low",
                                label: "",
                            },
                            {
                                id: "high",
                                label: "high",
                            },
                        ],
                        tokenCount: 525,
                        totalTokensFresh: false,
                        type: "agent",
                        updatedAt: Date.now(),
                    }}
                    selectedAgentId="main"
                    selectedSessionKey="agent:main:main"
                    agentOptions={[
                        {
                            label: "Main agent",
                            value: "main",
                        },
                    ]}
                    sessionOptions={[
                        {
                            label: "Main session",
                            value: "agent:main:main",
                        },
                    ]}
                    onSelectAgent={onSelectAgent}
                    onSelectSession={onSelectSession}
                />
                <ChatMessageDetails
                    onDynamicContentLoad={onDynamicContentLoad}
                    shouldExpandToolDetails={true}
                    visibility={{
                        shouldShowThinking: true,
                        shouldShowTools: true,
                    }}
                    message={{
                        attachments: [],
                        content: "answer",
                        images: [],
                        role: "assistant",
                        text: "answer",
                        thinking: [
                            {
                                text: "working",
                            },
                        ],
                        toolCalls: [
                            {
                                arguments: {
                                    ok: true,
                                },
                                id: "tool-1",
                                name: "run",
                                toolResult: {
                                    content: "tool output",
                                    id: "tool-1",
                                    images: [
                                        {
                                            image_url: {
                                                url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174010/full",
                                            },
                                            mimeType: "image/png",
                                            type: "image_url",
                                        },
                                        {
                                            image_url: {
                                                url: "https://files.example.test/tool-output.png",
                                            },
                                            mimeType: "image/png",
                                            type: "image_url",
                                        },
                                    ],
                                    name: "run",
                                },
                            },
                            {
                                id: "tool-2",
                                name: "empty",
                            },
                        ],
                        toolResult: {
                            content: "standalone output",
                            isError: true,
                            name: "run",
                        },
                    }}
                />
                <ChatMessageDetails
                    shouldExpandToolDetails={true}
                    visibility={{
                        shouldShowThinking: true,
                        shouldShowTools: true,
                    }}
                    message={{
                        attachments: [],
                        content: "",
                        images: [],
                        role: "assistant",
                        text: "",
                        toolCalls: [
                            {
                                arguments: {
                                    command: "older call",
                                },
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
                    visibility={{
                        shouldShowThinking: false,
                        shouldShowTools: false,
                    }}
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
        const toolOutputImage = screen.getByAltText("Tool output 1");
        expect(
            screen.getByRole("link", {
                name: "Open tool image 2",
            })
        ).toHaveAttribute("href", "https://files.example.test/tool-output.png");
        expect(
            document.querySelector(
                'img[src="https://files.example.test/tool-output.png"]'
            )
        ).toBeNull();
        const dynamicContentLoadCount = onDynamicContentLoad.mock.calls.length;
        fireEvent.load(toolOutputImage);
        fireEvent.error(toolOutputImage);
        expect(onDynamicContentLoad).toHaveBeenCalledTimes(dynamicContentLoadCount + 2);
    });
    it("collapses individual tool bubbles and applies the global default to new tools", async () => {
        const user = userEvent.setup();
        const onToggleToolDetails = jest.fn();
        const firstMessage = {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    arguments: {
                        command: "echo one",
                    },
                    id: "call-1",
                    name: "bash",
                    toolResult: {
                        content: "first output",
                        id: "call-1",
                        name: "bash",
                    },
                },
            ],
        };
        const properties = {
            messageKey: "message-1",
            onToggleToolDetails,
            visibility: {
                shouldShowThinking: true,
                shouldShowTools: true,
            },
        };
        const { rerender } = render(
            <ChatMessageDetails
                {...properties}
                message={firstMessage}
                shouldExpandToolDetails={true}
            />
        );
        expect(screen.getByText("first output")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Collapse Bash tool details",
            })
        );
        expect(onToggleToolDetails).toHaveBeenCalledWith("message-1:call:call-1");
        rerender(
            <ChatMessageDetails
                {...properties}
                message={firstMessage}
                shouldExpandToolDetails={true}
                toolDetailExpansionOverrides={new Map([["message-1:call:call-1", false]])}
            />
        );
        expect(
            screen.getByRole("button", {
                name: "Expand Bash tool details",
            })
        ).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("first output")).not.toBeInTheDocument();
        expect(screen.queryByText("Tool input")).not.toBeInTheDocument();
        const messageWithNewTool = {
            ...firstMessage,
            toolCalls: [
                ...firstMessage.toolCalls,
                {
                    arguments: {
                        command: "echo two",
                    },
                    id: "call-2",
                    name: "exec",
                },
            ],
        };
        rerender(
            <ChatMessageDetails
                {...properties}
                message={messageWithNewTool}
                shouldExpandToolDetails={false}
            />
        );
        expect(
            screen.getAllByRole("button", {
                name: /expand .* tool details/i,
            })
        ).toHaveLength(2);
        expect(screen.queryByText("Tool input")).not.toBeInTheDocument();
        rerender(
            <ChatMessageDetails
                {...properties}
                message={messageWithNewTool}
                shouldExpandToolDetails={true}
            />
        );
        expect(screen.getAllByText("Tool input")).toHaveLength(2);
        expect(
            screen.getAllByRole("button", {
                name: "Collapse Bash tool details",
            })
        ).toHaveLength(2);
    });
    it("offers scroll-to-bottom controls for long thinking and tool output", () => {
        render(
            <ChatMessageDetails
                shouldExpandToolDetails
                visibility={{
                    shouldShowThinking: true,
                    shouldShowTools: true,
                }}
                message={{
                    content: "",
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            text: "Long thinking output",
                        },
                    ],
                    toolCalls: [
                        {
                            arguments: {
                                command: "echo hello",
                            },
                            id: "tool-scroll",
                            name: "exec",
                            toolResult: {
                                content: "Long tool output",
                                id: "tool-scroll",
                                name: "exec",
                            },
                        },
                    ],
                }}
            />
        );
        const thinkingScrollArea = screen.getByLabelText(
            "Thinking / working scroll area"
        );
        const toolOutputScrollArea = screen.getByLabelText(
            "Bash tool output scroll area"
        );
        expect(thinkingScrollArea).toHaveAttribute("tabindex", "0");
        expect(toolOutputScrollArea).toHaveAttribute("tabindex", "0");
        let thinkingScrollTop = 0;
        let toolOutputScrollTop = 0;
        Object.defineProperties(thinkingScrollArea, {
            clientHeight: {
                configurable: true,
                value: 100,
            },
            scrollHeight: {
                configurable: true,
                value: 400,
            },
            scrollTop: {
                configurable: true,
                get: () => thinkingScrollTop,
                set: (value: number) => {
                    thinkingScrollTop = value;
                },
            },
        });
        Object.defineProperties(toolOutputScrollArea, {
            clientHeight: {
                configurable: true,
                value: 100,
            },
            scrollHeight: {
                configurable: true,
                value: 500,
            },
            scrollTop: {
                configurable: true,
                get: () => toolOutputScrollTop,
                set: (value: number) => {
                    toolOutputScrollTop = value;
                },
            },
        });
        fireEvent.scroll(thinkingScrollArea);
        fireEvent.scroll(toolOutputScrollArea);
        const thinkingBottomButton = screen.getByRole("button", {
            name: "Scroll thinking / working to bottom",
        });
        expect(thinkingBottomButton).toHaveClass(
            "bottom-3",
            "left-1/2",
            "-translate-x-1/2"
        );
        expect(thinkingBottomButton).not.toHaveClass("right-2");
        expect(thinkingBottomButton.querySelector("svg")).toHaveClass("size-4");
        fireEvent.click(thinkingBottomButton);
        fireEvent.click(
            screen.getByRole("button", {
                name: "Scroll bash tool output to bottom",
            })
        );
        expect(thinkingScrollTop).toBe(400);
        expect(toolOutputScrollTop).toBe(500);
        expect(
            screen.queryByRole("button", {
                name: "Scroll thinking / working to bottom",
            })
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: "Scroll bash tool output to bottom",
            })
        ).not.toBeInTheDocument();
    });
    it("shows a write path in a collapsed tool bubble", () => {
        render(
            <ChatMessageDetails
                message={{
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            arguments: {
                                path: "/tmp/report.md",
                            },
                            id: "write-1",
                            name: "write",
                        },
                    ],
                }}
                shouldExpandToolDetails={false}
                visibility={{
                    shouldShowThinking: true,
                    shouldShowTools: true,
                }}
            />
        );
        expect(screen.getByText("/tmp/report.md")).toBeInTheDocument();
    });
    it("drives chat composer attachments, slash suggestions, emoji, and submit controls", async () => {
        const user = userEvent.setup();
        const fileInputRef = {
            current: undefined,
        } as RefObject<HTMLInputElement | undefined>;
        const onApplySlashSuggestion = jest.fn();
        const onAttachFiles = jest.fn();
        const onChangeDraft = jest.fn();
        const onDismissAttachmentPickerError = jest.fn();
        const onPreview = jest.fn();
        const onRemoveAttachment = jest.fn();
        const onSend = jest.fn();
        const onStop = jest.fn();
        const onToggleRecording = jest.fn();
        render(
            <ChatComposer
                attachmentPickerError="Unsupported file from attachment picker"
                attachments={[
                    {
                        contentBase64: textToBase64("hello"),
                        file: new File(["hello"], "note.txt", {
                            type: "text/plain",
                        }),
                        fileName: "note.txt",
                        id: "a1",
                        kind: "text",
                        mimeType: "text/plain",
                        sizeBytes: 5,
                    },
                    {
                        contentBase64: "a",
                        dataUrl: "data:image/png;base64,a",
                        file: new File(["a"], "image.png", {
                            type: "image/png",
                        }),
                        fileName: "image.png",
                        id: "a2",
                        kind: "image",
                        mimeType: "image/png",
                        sizeBytes: 1,
                    },
                ]}
                canSend={true}
                canStop={true}
                draft="/he"
                fileInputRef={fileInputRef}
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
                    {
                        description: "Show health",
                        title: "/health",
                        value: "/health",
                    },
                ]}
                onApplySlashSuggestion={onApplySlashSuggestion}
                onAttachFiles={onAttachFiles}
                onChangeDraft={onChangeDraft}
                onDismissAttachmentPickerError={onDismissAttachmentPickerError}
                onPreview={onPreview}
                onRemoveAttachment={onRemoveAttachment}
                onSend={onSend}
                onStop={onStop}
                onToggleRecording={onToggleRecording}
            />
        );
        await user.click(
            screen.getByRole("button", {
                name: "Stop",
            })
        );
        expect(onStop).toHaveBeenCalledTimes(1);
        await user.click(
            screen.getAllByRole("button", {
                name: /note.txt/i,
            })[0]!
        );
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "text",
                text: "hello",
                title: "note.txt",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /remove note.txt/i,
            })
        );
        expect(onRemoveAttachment).toHaveBeenCalledWith("a1");
        const textarea = screen.getByRole("textbox", {
            name: "Message",
        });
        const directlyDroppedFiles = [
            new File(["direct"], "direct-drop.txt", {
                type: "text/plain",
            }),
        ] as unknown as FileList;
        const directDropData = {
            dropEffect: "none",
            files: directlyDroppedFiles,
            types: ["Files"],
        };
        expect(
            fireEvent.dragOver(document.body, {
                dataTransfer: directDropData,
            })
        ).toBe(false);
        expect(
            fireEvent.drop(document.body, {
                dataTransfer: directDropData,
            })
        ).toBe(false);
        expect(onAttachFiles).not.toHaveBeenCalled();
        fireEvent.dragEnter(textarea, {
            dataTransfer: directDropData,
        });
        expect(screen.getByText("Drop files to attach")).toBeInTheDocument();
        fireEvent.dragOver(textarea, {
            dataTransfer: directDropData,
        });
        fireEvent.drop(textarea, {
            dataTransfer: directDropData,
        });
        expect(onAttachFiles).toHaveBeenCalledWith(directlyDroppedFiles, "composer");
        expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
        fireEvent.change(textarea, {
            target: {
                value: "/hel",
            },
        });
        await user.click(
            await screen.findByRole("option", {
                name: /help/i,
            })
        );
        expect(onApplySlashSuggestion).toHaveBeenCalledWith("/help");
        fireEvent.change(textarea, {
            target: {
                value: "/hea",
            },
        });
        expect(textarea).toHaveAttribute("aria-controls", "chat-slash-command-options");
        expect(
            fireEvent.keyDown(textarea, {
                key: "ArrowDown",
            })
        ).toBe(false);
        expect(
            fireEvent.keyDown(textarea, {
                key: "Tab",
                shiftKey: true,
            })
        ).toBe(true);
        expect(onApplySlashSuggestion).toHaveBeenCalledTimes(1);
        expect(
            fireEvent.keyDown(textarea, {
                key: "Enter",
            })
        ).toBe(false);
        expect(onApplySlashSuggestion).toHaveBeenLastCalledWith("/health");
        expect(onSend).not.toHaveBeenCalled();
        const bubbledEnter = jest.fn();
        fireEvent.change(textarea, {
            target: {
                value: "/he-shift",
            },
        });
        document.addEventListener("keydown", bubbledEnter);
        try {
            expect(
                fireEvent.keyDown(textarea, {
                    key: "Enter",
                    shiftKey: true,
                })
            ).toBe(true);
            expect(bubbledEnter).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener("keydown", bubbledEnter);
        }
        expect(onApplySlashSuggestion).toHaveBeenCalledTimes(2);
        fireEvent.pointerDown(document.body);
        expect(textarea).not.toHaveAttribute("aria-controls");
        fireEvent.change(textarea, {
            target: {
                value: "/he-blur",
            },
        });
        fireEvent.blur(textarea, {
            relatedTarget: document.body,
        });
        expect(textarea).not.toHaveAttribute("aria-controls");
        fireEvent.change(textarea, {
            target: {
                value: "/he-close",
            },
        });
        await user.click(
            screen.getByRole("button", {
                name: /close slash commands/i,
            })
        );
        const pendingAnimationFrames = animationFrameState.frames.values().toArray();
        animationFrameState.frames.clear();
        act(() => {
            for (const callback of pendingAnimationFrames) {
                callback(performance.now());
            }
        });
        expect(textarea).toHaveFocus();
        expect(
            fireEvent.keyDown(textarea, {
                key: "Enter",
            })
        ).toBe(false);
        expect(onSend).toHaveBeenCalledTimes(1);
        const originalMatchMedia = Object.getOwnPropertyDescriptor(
            globalThis,
            "matchMedia"
        );
        Object.defineProperty(globalThis, "matchMedia", {
            configurable: true,
            value: jest.fn(() => ({
                matches: true,
            })),
        });
        fireEvent.change(textarea, {
            target: {
                value: "/he-mobile",
            },
        });
        document.addEventListener("keydown", bubbledEnter);
        try {
            expect(
                fireEvent.keyDown(textarea, {
                    key: "Enter",
                })
            ).toBe(true);
            expect(bubbledEnter).not.toHaveBeenCalled();
            expect(onSend).toHaveBeenCalledTimes(1);
        } finally {
            document.removeEventListener("keydown", bubbledEnter);
            if (originalMatchMedia) {
                Object.defineProperty(globalThis, "matchMedia", originalMatchMedia);
            } else {
                Reflect.deleteProperty(globalThis, "matchMedia");
            }
        }
        const responseSettingsButton = screen.getByRole("button", {
            name: /response settings/i,
        });
        const chatDisplayButton = screen.getByRole("button", {
            name: "Chat display settings",
        });
        expect(responseSettingsButton).toHaveAttribute("title", "Response settings");
        expect(chatDisplayButton).toHaveAttribute("title", "Chat display settings");
        await user.click(responseSettingsButton);
        await user.click(
            screen.getByRole("button", {
                name: /close response settings/i,
            })
        );
        expect(
            screen.queryByRole("button", {
                name: /close response settings/i,
            })
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /insert emoji/i,
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /close emoji picker/i,
            })
        );
        expect(
            screen.queryByRole("button", {
                name: /close emoji picker/i,
            })
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /insert emoji/i,
            })
        );
        const emojiButton = screen.getByRole("button", {
            name: "Insert 😀",
        });
        (textarea as HTMLTextAreaElement).setSelectionRange(0, 0);
        await user.click(emojiButton);
        expect(onChangeDraft).toHaveBeenCalledWith("😀/he");
        await user.click(
            screen.getByRole("button", {
                name: /voice/i,
            })
        );
        expect(
            screen.queryByText("Unsupported file from attachment picker")
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /attach/i,
            })
        );
        expect(
            screen.getByRole("dialog", {
                name: "Attach files",
            })
        ).toBeInTheDocument();
        const modalDroppedFiles = [
            new File(["modal"], "modal-drop.txt", {
                type: "text/plain",
            }),
        ] as unknown as FileList;
        const modalDropData = {
            dropEffect: "none",
            files: modalDroppedFiles,
            types: ["Files"],
        };
        const attachmentDialog = screen.getByRole("dialog", {
            name: "Attach files",
        });
        expect(within(attachmentDialog).getByRole("alert")).toHaveTextContent(
            "Unsupported file from attachment picker"
        );
        fireEvent.dragEnter(attachmentDialog, {
            dataTransfer: modalDropData,
        });
        expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
        expect(
            fireEvent.drop(attachmentDialog, {
                dataTransfer: modalDropData,
            })
        ).toBe(false);
        expect(onAttachFiles).toHaveBeenCalledTimes(1);
        const dropZone = screen.getByTestId("chat-attachment-drop-zone");
        fireEvent.dragEnter(dropZone, {
            dataTransfer: modalDropData,
        });
        expect(dropZone).toHaveClass("border-accent-400");
        fireEvent.drop(dropZone, {
            dataTransfer: modalDropData,
        });
        expect(onAttachFiles).toHaveBeenLastCalledWith(modalDroppedFiles, "picker");
        expect(within(attachmentDialog).getByText("Selected files")).toBeInTheDocument();
        expect(within(attachmentDialog).getByText("note.txt")).toBeInTheDocument();
        expect(within(attachmentDialog).getByText("image.png")).toBeInTheDocument();
        await user.click(
            within(attachmentDialog).getByRole("button", {
                name: "Remove image.png",
            })
        );
        expect(onRemoveAttachment).toHaveBeenLastCalledWith("a2");
        await user.click(
            within(attachmentDialog).getByRole("button", {
                name: "Preview note.txt",
            })
        );
        const previewDialog = screen.getByRole("dialog", {
            name: "note.txt",
        });
        expect(within(previewDialog).getByText("hello")).toBeInTheDocument();
        expect(
            previewDialog.querySelector('[data-modal-scroll-owner="content"]')
        ).toBeInTheDocument();
        expect(
            previewDialog.querySelectorAll(".overflow-auto, .overflow-y-auto")
        ).toHaveLength(1);
        await user.click(
            within(previewDialog).getByRole("button", {
                name: "Back to attachments",
            })
        );
        expect(
            within(
                screen.getByRole("dialog", {
                    name: "Attach files",
                })
            ).getByText("Selected files")
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Close Attach files",
            })
        );
        expect(onDismissAttachmentPickerError).toHaveBeenCalledTimes(2);
        await user.click(
            screen.getByRole("button", {
                name: /send/i,
            })
        );
        expect(onToggleRecording).toHaveBeenCalledTimes(1);
        expect(onAttachFiles).toHaveBeenCalledTimes(2);
        expect(onSend).toHaveBeenCalledTimes(2);
    });
    it("does not present a disabled attachment drop zone as accepting files", async () => {
        const user = userEvent.setup();
        const onFilesSelected = jest.fn();
        function DisabledAttachmentPickerHarness() {
            const [isOpen, setIsOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setIsOpen(true)}>
                        Open disabled picker
                    </button>
                    <ChatAttachmentPickerModal
                        attachments={[]}
                        isDisabled={true}
                        isOpen={isOpen}
                        onChooseFiles={jest.fn()}
                        onClose={() => setIsOpen(false)}
                        onFilesSelected={onFilesSelected}
                        onRemoveAttachment={jest.fn()}
                    />
                </>
            );
        }
        render(<DisabledAttachmentPickerHarness />);
        await user.click(
            screen.getByRole("button", {
                name: "Open disabled picker",
            })
        );
        const files = [
            new File(["disabled"], "disabled.txt", {
                type: "text/plain",
            }),
        ] as unknown as FileList;
        const dataTransfer = {
            dropEffect: "copy",
            files,
            types: ["Files"],
        };
        const dropZone = screen.getByTestId("chat-attachment-drop-zone");
        fireEvent.dragEnter(dropZone, {
            dataTransfer,
        });
        expect(dropZone).not.toHaveClass("border-accent-400");
        fireEvent.drop(dropZone, {
            dataTransfer,
        });
        expect(onFilesSelected).not.toHaveBeenCalled();
        await user.click(
            screen.getByRole("button", {
                name: "Close Attach files",
            })
        );
    });
    it("exposes final-thinking retention only while thinking is visible", async () => {
        const user = userEvent.setup();
        const onToggleKeepThinkingAfterFinal = jest.fn();
        const properties = {
            attachments: [],
            canSend: false,
            draft: "",
            fileInputRef: {
                current: undefined,
            },
            isConnected: true,
            isRecording: false,
            isSending: false,
            isTranscribing: false,
            selectedSessionKey: "agent:main:main",
            slashCommandSuggestions: [],
            onApplySlashSuggestion: jest.fn(),
            onAttachFiles: jest.fn(),
            onChangeDraft: jest.fn(),
            onPreview: jest.fn(),
            onRemoveAttachment: jest.fn(),
            onSend: jest.fn(),
            onToggleRecording: jest.fn(),
            onToggleKeepThinkingAfterFinal,
        };
        const { rerender } = render(
            <ChatComposer {...properties} shouldShowThinking={false} />
        );
        await user.click(
            screen.getByRole("button", {
                name: "Chat display settings",
            })
        );
        const toggle = screen.getByRole("button", {
            name: "Keep thinking after final answer",
        });
        expect(toggle).toBeDisabled();
        rerender(
            <ChatComposer
                {...properties}
                shouldShowThinking={true}
                shouldKeepThinkingAfterFinal={true}
            />
        );
        expect(toggle).toBeEnabled();
        expect(toggle).toHaveAttribute("aria-pressed", "true");
        await user.click(toggle);
        expect(onToggleKeepThinkingAfterFinal).toHaveBeenCalledTimes(1);
    });
    it("keeps attachment support and stop controls visually distinct", () => {
        const view = render(
            <ChatComposer
                attachments={[]}
                canSend={false}
                canStop={true}
                draft=""
                fileInputRef={{
                    current: undefined,
                }}
                isConnected={true}
                isRecording={true}
                isSending={false}
                isTranscribing={false}
                selectedSessionKey="agent:main:main"
                slashCommandSuggestions={[]}
                onApplySlashSuggestion={jest.fn()}
                onAttachFiles={jest.fn()}
                onChangeDraft={jest.fn()}
                onPreview={jest.fn()}
                onRemoveAttachment={jest.fn()}
                onSend={jest.fn()}
                onStop={jest.fn()}
                onToggleRecording={jest.fn()}
            />
        );
        const recordingButton = screen.getByRole("button", {
            name: "Stop recording",
        });
        const responseStopButton = screen.getByRole("button", {
            name: "Stop",
        });
        expect(recordingButton).toHaveTextContent("Recording");
        expect(recordingButton).toHaveClass("bg-red-500");
        expect(responseStopButton).toHaveClass(
            "border-red-500/60",
            "bg-transparent",
            "text-red-500/80"
        );
        expect(
            view.container.querySelector('input[type="file"][multiple]')
        ).toHaveAttribute("accept", CHAT_ATTACHMENT_ACCEPT);
        expect(CHAT_ATTACHMENT_ACCEPT.split(",")).toContain("application/json");
    });
    it("submits an exact slash command on the first Enter", () => {
        const onApplySlashSuggestion = jest.fn();
        const onSend = jest.fn();
        render(
            <ChatComposer
                attachments={[]}
                canSend={true}
                draft="/help"
                fileInputRef={{
                    current: undefined,
                }}
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
                onAttachFiles={jest.fn()}
                onChangeDraft={jest.fn()}
                onPreview={jest.fn()}
                onRemoveAttachment={jest.fn()}
                onSend={onSend}
                onToggleRecording={jest.fn()}
            />
        );
        expect(
            fireEvent.keyDown(
                screen.getByRole("textbox", {
                    name: "Message",
                }),
                {
                    key: "Enter",
                }
            )
        ).toBe(false);
        expect(onApplySlashSuggestion).not.toHaveBeenCalled();
        expect(onSend).toHaveBeenCalledTimes(1);
    });
    it("keeps slash argument suggestions open after command completion", async () => {
        const user = userEvent.setup();
        const onApplySlashSuggestion = jest.fn();
        function StatefulComposer() {
            const [draft, setDraft] = useState("/thi");
            const slashCommandSuggestions =
                draft === "/think "
                    ? [
                          {
                              description: "Set thinking level",
                              title: "/think high",
                              value: "/think high",
                          },
                      ]
                    : [
                          {
                              description: "Show or set thinking level",
                              title: "/think [level]",
                              value: "/think ",
                          },
                      ];
            return (
                <ChatComposer
                    attachments={[]}
                    canSend={true}
                    draft={draft}
                    fileInputRef={{
                        current: undefined,
                    }}
                    isConnected={true}
                    isRecording={false}
                    isSending={false}
                    isTranscribing={false}
                    selectedSessionKey="agent:main:main"
                    slashCommandSuggestions={slashCommandSuggestions}
                    onApplySlashSuggestion={(suggestion) => {
                        onApplySlashSuggestion(suggestion);
                        setDraft(suggestion);
                    }}
                    onAttachFiles={jest.fn()}
                    onChangeDraft={setDraft}
                    onPreview={jest.fn()}
                    onRemoveAttachment={jest.fn()}
                    onSend={jest.fn()}
                    onToggleRecording={jest.fn()}
                />
            );
        }
        render(<StatefulComposer />);
        await user.click(
            screen.getByRole("option", {
                name: /think/i,
            })
        );
        expect(onApplySlashSuggestion).toHaveBeenCalledWith("/think ");
        expect(
            screen.getByRole("textbox", {
                name: "Message",
            })
        ).toHaveAttribute("aria-controls", "chat-slash-command-options");
        expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
    it("submits an exact optional-argument command", () => {
        const onApplySlashSuggestion = jest.fn();
        const onSend = jest.fn();
        render(
            <ChatComposer
                attachments={[]}
                canSend={true}
                draft="/think"
                fileInputRef={{
                    current: undefined,
                }}
                isConnected={true}
                isRecording={false}
                isSending={false}
                isTranscribing={false}
                selectedSessionKey="agent:main:main"
                slashCommandSuggestions={[
                    {
                        description: "Show or set thinking level",
                        title: "/think [level]",
                        value: "/think ",
                    },
                ]}
                onApplySlashSuggestion={onApplySlashSuggestion}
                onAttachFiles={jest.fn()}
                onChangeDraft={jest.fn()}
                onPreview={jest.fn()}
                onRemoveAttachment={jest.fn()}
                onSend={onSend}
                onToggleRecording={jest.fn()}
            />
        );
        expect(
            fireEvent.keyDown(
                screen.getByRole("textbox", {
                    name: "Message",
                }),
                {
                    key: "Enter",
                }
            )
        ).toBe(false);
        expect(onApplySlashSuggestion).not.toHaveBeenCalled();
        expect(onSend).toHaveBeenCalledTimes(1);
    });
    it("completes an exact required-argument command before sending", () => {
        const onApplySlashSuggestion = jest.fn();
        const onSend = jest.fn();
        render(
            <ChatComposer
                attachments={[]}
                canSend={true}
                draft="/bash"
                fileInputRef={{
                    current: undefined,
                }}
                isConnected={true}
                isRecording={false}
                isSending={false}
                isTranscribing={false}
                selectedSessionKey="agent:main:main"
                slashCommandSuggestions={[
                    {
                        description: "Run a host shell command",
                        requiresArgument: true,
                        title: "/bash <command>",
                        value: "/bash ",
                    },
                ]}
                onApplySlashSuggestion={onApplySlashSuggestion}
                onAttachFiles={jest.fn()}
                onChangeDraft={jest.fn()}
                onPreview={jest.fn()}
                onRemoveAttachment={jest.fn()}
                onSend={onSend}
                onToggleRecording={jest.fn()}
            />
        );
        expect(
            fireEvent.keyDown(
                screen.getByRole("textbox", {
                    name: "Message",
                }),
                {
                    key: "Enter",
                }
            )
        ).toBe(false);
        expect(onApplySlashSuggestion).toHaveBeenCalledWith("/bash ");
        expect(onSend).not.toHaveBeenCalled();
    });
    it("handles chat slash commands without rendering the page", async () => {
        const abort = jest.fn(async () => {});
        const clearRuntime = jest.fn();
        const setMessages = jest.fn(
            (updater: SetStateAction<ChatHistoryMessage[]>): void => {
                if (typeof updater === "function") {
                    updater([]);
                }
            }
        );
        const setDraft = jest.fn();
        const setSendError = jest.fn();
        const confirmResetSession = jest.fn(() => Promise.try(() => false));
        const selectedSessionKeyRef = {
            current: "agent:main:main",
        };
        const commandParameters = {
            attachments: [],
            abort,
            clearRuntime,
            confirmResetSession,
            selectedSessionKey: "agent:main:main",
            selectedSessionKeyRef: selectedSessionKeyRef,
            setDraft,
            setMessages,
            setSendError,
        };
        const runSlashCommand = (
            commandText: string,
            currentAttachments?: ChatSendAttachment[]
        ) => executeChatSlashCommand(commandParameters, commandText, currentAttachments);
        expect(await runSlashCommand("hello")).toBe(false);
        expect(await runSlashCommand("/unknown")).toBe(false);
        expect(await runSlashCommand("/reset")).toBe(true);
        expect(setMessages).toHaveBeenCalled();
        expect(await runSlashCommand("/stop")).toBe(true);
        expect(abort).toHaveBeenCalledWith("agent:main:main");
        expect(clearRuntime).toHaveBeenCalledWith("agent:main:main");
        expect(
            await executeChatSlashCommand(
                {
                    ...commandParameters,
                    attachments: [
                        {
                            contentBase64: "a",
                            file: new File(["a"], "a.txt", {
                                type: "text/plain",
                            }),
                            fileName: "a.txt",
                            id: "a",
                            kind: "text",
                            mimeType: "text/plain",
                            sizeBytes: 1,
                        },
                    ],
                },
                "/stop"
            )
        ).toBe(true);
        expect(setSendError).toHaveBeenCalledWith("/stop cannot include attachments.");
        expect(
            await runSlashCommand("/compact", [
                {
                    contentBase64: "b",
                    file: new File(["b"], "late.txt", {
                        type: "text/plain",
                    }),
                    fileName: "late.txt",
                    id: "late",
                    kind: "text",
                    mimeType: "text/plain",
                    sizeBytes: 1,
                },
            ])
        ).toBe(true);
        expect(setSendError).toHaveBeenCalledWith("/compact cannot include attachments.");
        const abortDeferred = Promise.withResolvers<void>();
        const switchedMessages = jest.fn(
            (_updater: SetStateAction<ChatHistoryMessage[]>): void => {}
        );
        const stopPromise = executeChatSlashCommand(
            {
                ...commandParameters,
                abort: jest.fn(() => abortDeferred.promise),
                setMessages: switchedMessages,
            },
            "/stop"
        );
        selectedSessionKeyRef.current = "agent:other:main";
        abortDeferred.resolve();
        expect(await stopPromise).toBe(true);
        expect(switchedMessages).not.toHaveBeenCalled();
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
            {
                label: "Default",
                value: "",
            },
            {
                label: "off",
                value: "off",
            },
            {
                label: "on",
                value: "low",
            },
            {
                label: "Think Harder",
                value: "medium",
            },
            {
                label: "Extra High",
                value: "xhigh",
            },
        ]);
    });
    it("ignores a completed text preview after switching attachments", async () => {
        const textPreviewDeferred = Promise.withResolvers<string>();
        const previewFetch = jest.fn(() =>
            Promise.try(() => ({
                ok: true,
                text: () => textPreviewDeferred.promise,
            }))
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: previewFetch,
            writable: true,
        });
        const { rerender } = render(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "text",
                    mimeType: "text/plain",
                    title: "first.txt",
                    url: "/api/media?path=first.txt",
                }}
                onClose={jest.fn()}
            />
        );
        await waitFor(() => expect(previewFetch).toHaveBeenCalledTimes(1));
        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "text",
                    mimeType: "text/plain",
                    title: "second.txt",
                    url: "https://files.example.test/second.txt",
                }}
                onClose={jest.fn()}
            />
        );
        expect(
            screen.getByText(
                "Preview is not available for this file type yet. Use the download link above to open it locally."
            )
        ).toBeInTheDocument();
        await act(async () => {
            textPreviewDeferred.resolve("stale first attachment");
            await textPreviewDeferred.promise;
        });
        expect(screen.queryByText("stale first attachment")).not.toBeInTheDocument();
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
        const managedAttachmentUrl =
            "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full";
        const optimisticManagedAttachment = {
            attachments: [
                {
                    contentBase64: "aW1hZ2UtYnl0ZXM=",
                    dataUrl: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
                    fileName: "photo.png",
                    id: "local-photo",
                    kind: "image" as const,
                    mimeType: "image/png",
                    sizeBytes: 11,
                },
            ],
            content: "",
            local: true,
            role: "user",
            runId: "dashboard-chat-attachment-run",
            text: "",
            timestamp: "2026-07-10T15:03:00.000Z",
        };
        const retainedManagedAttachmentBeforeEcho = mergeWithRecentOptimisticMessages(
            [repeatedAttachmentOnlyTurns[0]!, optimisticManagedAttachment],
            [repeatedAttachmentOnlyTurns[0]!]
        );
        expect(retainedManagedAttachmentBeforeEcho).toHaveLength(2);
        expect(
            retainedManagedAttachmentBeforeEcho.some(
                (message) =>
                    message.local === true &&
                    message.runId === "dashboard-chat-attachment-run"
            )
        ).toBe(true);
        const persistedManagedAttachment = {
            attachments: [
                {
                    dataUrl: managedAttachmentUrl,
                    fileName: "photo.png",
                    id: `content-${managedAttachmentUrl}-0`,
                    kind: "image" as const,
                    mimeType: "image/png",
                    url: managedAttachmentUrl,
                },
            ],
            content: "",
            role: "user",
            runId: "dashboard-chat-attachment-run",
            text: "",
            timestamp: "2026-07-10T15:03:01.000Z",
        };
        const reconciledManagedAttachment = mergeWithRecentOptimisticMessages(
            [optimisticManagedAttachment],
            [persistedManagedAttachment]
        );
        expect(reconciledManagedAttachment).toHaveLength(1);
        expect(reconciledManagedAttachment[0]).toMatchObject({
            attachments: [
                {
                    url: managedAttachmentUrl,
                },
            ],
        });
        expect(reconciledManagedAttachment[0]?.local).toBeUndefined();
        const distinctAssistantMediaInOneRun = mergeWithRecentOptimisticMessages(
            [
                {
                    ...optimisticManagedAttachment,
                    role: "assistant",
                },
            ],
            [
                {
                    ...persistedManagedAttachment,
                    attachments: [
                        {
                            dataUrl: `${managedAttachmentUrl}?variant=second`,
                            fileName: "second-photo.png",
                            id: "second-photo",
                            kind: "image" as const,
                            mimeType: "image/png",
                            url: `${managedAttachmentUrl}?variant=second`,
                        },
                    ],
                    role: "assistant",
                },
            ]
        );
        expect(distinctAssistantMediaInOneRun).toHaveLength(2);
        const unrelatedPreviousAttachment = {
            ...persistedManagedAttachment,
            attachments: [
                {
                    dataUrl: `${managedAttachmentUrl}?variant=unrelated`,
                    fileName: "unrelated.png",
                    id: "unrelated-photo",
                    kind: "image" as const,
                    mimeType: "image/png",
                    url: `${managedAttachmentUrl}?variant=unrelated`,
                },
            ],
            timestamp: "2026-07-10T15:02:59.000Z",
        };
        const reconciledAfterUnrelatedPreviousMedia = mergeWithRecentOptimisticMessages(
            [unrelatedPreviousAttachment, optimisticManagedAttachment],
            [persistedManagedAttachment]
        );
        expect(reconciledAfterUnrelatedPreviousMedia).toHaveLength(1);
        expect(reconciledAfterUnrelatedPreviousMedia[0]?.attachments?.[0]?.url).toBe(
            managedAttachmentUrl
        );
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
            images: [
                {
                    data: "generated-image",
                    type: "image" as const,
                },
            ],
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
                [
                    {
                        ...localMediaMessage,
                        local: undefined,
                    },
                ]
            )
        ).toHaveLength(1);
        const reconciledAssistantMediaHistory = mergeWithRecentOptimisticMessages(
            [
                {
                    ...localMediaMessage,
                    runId: "local-media-run",
                },
            ],
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
            [
                {
                    ...localMediaMessage,
                    local: undefined,
                },
            ]
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
                    arguments: {
                        command: "git status",
                    },
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
                    arguments: {
                        command: "git status",
                    },
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
            content: [
                {
                    text: "Thinking after tool",
                    type: "thinking",
                },
            ],
            local: true,
            role: "assistant",
            text: "",
            thinking: [
                {
                    text: "Thinking after tool",
                },
            ],
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
                    arguments: {
                        command: "git diff",
                    },
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
                    arguments: {
                        command: "git diff",
                    },
                    name: "functions.exec_command",
                },
            ],
        };
        const alreadyEnrichedHistoryRow = {
            ...namedHistoryRow,
            toolCalls: [
                {
                    arguments: {
                        command: "git diff",
                    },
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
                    arguments: {
                        command: "first",
                    },
                    name: "functions.exec_command",
                    toolResult: {
                        content: "first output",
                        name: "functions.exec_command",
                    },
                },
                {
                    arguments: {
                        command: "second",
                    },
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
                    arguments: {
                        command: "first",
                    },
                    name: "functions.exec_command",
                },
                {
                    arguments: {
                        command: "second",
                    },
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
                [
                    {
                        ...duplicateNameHistoryRow,
                        runId: "new-duplicate-tool-row-run",
                    },
                ]
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
                    arguments: {
                        command: "first",
                    },
                    name: "functions.exec_command",
                    toolResult: {
                        content: "first live output",
                        name: "functions.exec_command",
                    },
                },
                {
                    arguments: {
                        command: "second",
                    },
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
                    arguments: {
                        command: "first",
                    },
                    name: "functions.exec_command",
                },
                {
                    arguments: {
                        command: "second",
                    },
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
                    arguments: {
                        command: "status",
                    },
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
                    arguments: {
                        command: "status",
                    },
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
                {
                    text: "same visible text",
                    type: "text",
                },
                {
                    text: "local reasoning",
                    type: "thinking",
                },
            ],
            images: [
                {
                    data: "local-generated-image",
                    type: "image" as const,
                },
            ],
            local: true,
            role: "assistant",
            text: "same visible text",
            thinking: [
                {
                    text: "local reasoning",
                },
            ],
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
            images: [
                {
                    data: "history-generated-image",
                    type: "image" as const,
                },
            ],
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
                {
                    id: "history-generated-media",
                },
                {
                    id: "local-generated-media",
                },
            ],
            images: [
                {
                    data: "history-generated-image",
                },
                {
                    data: "local-generated-image",
                },
            ],
        });
        expect(
            mergeWithRecentOptimisticMessages(
                [mixedDiagnosticLocalRow],
                [
                    {
                        ...mixedDiagnosticHistoryRow,
                        thinking: [
                            {
                                text: "history reasoning",
                            },
                        ],
                    },
                ]
            )[0]?.thinking?.[0]?.text
        ).toBe("history reasoning");
        const firstDoneDiagnostic = {
            ...mixedDiagnosticLocalRow,
            runId: "done-1",
            text: "Done",
            thinking: [
                {
                    text: "first done reasoning",
                },
            ],
        };
        expect(
            mergeWithRecentOptimisticMessages(
                [firstDoneDiagnostic],
                [
                    {
                        content: "Done",
                        role: "assistant",
                        runId: "done-2",
                        text: "Done",
                    },
                ]
            )[0]?.thinking
        ).toBeUndefined();
        expect(
            mergeWithRecentOptimisticMessages(
                [firstDoneDiagnostic],
                [
                    {
                        content: "Done",
                        role: "assistant",
                        runId: "done-1",
                        text: "Done",
                    },
                ]
            )[0]?.thinking?.[0]?.text
        ).toBe("first done reasoning");
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
                {
                    index: 0,
                    message: previousMessage,
                },
            ])
        ).toEqual([previousMessage]);
    });
    it("renders chat messages list helpers and primary row actions", async () => {
        const user = userEvent.setup();
        const longActivityText = `Bash ${"very-long-status-segment".repeat(12)}`;
        const onDynamicContentLoad = jest.fn();
        const onFollow = jest.fn();
        const onPreview = jest.fn();
        const onScroll = jest.fn();
        const onUserScrollIntent = jest.fn();
        const onTtsError = jest.fn();
        const onDeleteMessage = jest.fn();
        const messagesContainerRef = {
            current: undefined,
        } as RefObject<HTMLDivElement | undefined>;
        const virtualizer = {
            getTotalSize: () => 240,
            getVirtualItems: () => [
                {
                    end: 100,
                    index: 0,
                    key: "user",
                    start: 0,
                },
                {
                    end: 200,
                    index: 1,
                    key: "assistant",
                    start: 100,
                },
                {
                    end: 230,
                    index: 2,
                    key: "typing",
                    start: 200,
                },
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
        ).toMatchObject({
            text: "hello",
            title: "note.txt",
        });
        expect(
            previewFromAttachment({
                fileName: "empty.bin",
                id: "empty",
                kind: "file",
            })
        ).toBeUndefined();
        expect(
            previewFromAttachment({
                dataUrl:
                    "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full?preview=image",
                fileName: "diagram.svg",
                id: "diagram",
                kind: "image",
                mimeType: "image/svg+xml",
                url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
            })
        ).toMatchObject({
            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
        });
        render(
            <>
                <AttachmentIcon
                    attachment={{
                        fileName: "image",
                        id: "i",
                        kind: "image",
                    }}
                />
                <AttachmentIcon
                    attachment={{
                        fileName: "text",
                        id: "t",
                        kind: "text",
                    }}
                />
                <AttachmentIcon
                    attachment={{
                        fileName: "file",
                        id: "f",
                        kind: "file",
                    }}
                />
                <ChatMessagesList
                    isAtBottom={false}
                    isLoadingHistory={false}
                    newMessageCount={2}
                    chatRows={[
                        {
                            deleteKeys: ["user", "user-history"],
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
                                images: [
                                    {
                                        image_url: {
                                            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
                                        },
                                        mimeType: "image/svg+xml",
                                        type: "image_url",
                                    },
                                    {
                                        image_url: {
                                            url: "https://files.example.test/chat-image.png",
                                        },
                                        mimeType: "image/png",
                                        type: "image_url",
                                    },
                                ],
                                role: "assistant",
                                text: "answer",
                                timestamp: "2026-06-24T10:01:00.000Z",
                                toolCalls: [
                                    {
                                        id: "tool-1",
                                        name: "exec",
                                    },
                                ],
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
                                text: longActivityText,
                            },
                        },
                    ]}
                    messagesContainerRef={messagesContainerRef}
                    messagesVirtualizer={virtualizer as never}
                    onDeleteMessage={onDeleteMessage}
                    onDynamicContentLoad={onDynamicContentLoad}
                    onFollow={onFollow}
                    onPreview={onPreview}
                    onScroll={onScroll}
                    onUserScrollIntent={onUserScrollIntent}
                    onTtsError={onTtsError}
                    visibility={{
                        shouldShowThinking: true,
                        shouldShowTools: true,
                    }}
                />
            </>
        );
        expect(
            screen.getByText("Bash").closest("[class*='border-amber']")
        ).not.toContainElement(screen.getByText("answer"));
        await waitFor(() => expect(onDynamicContentLoad).toHaveBeenCalled());
        const newMessageButton = screen.getByRole("button", {
            name: "2 new messages. Scroll to bottom",
        });
        expect(newMessageButton).toHaveClass("bg-primary-700");
        expect(newMessageButton).toHaveClass("border-primary-600", "text-primary-100");
        expect(newMessageButton).not.toHaveClass("bg-accent-500");
        expect(newMessageButton.querySelector("svg")).toHaveClass("size-4");
        fireEvent.click(newMessageButton);
        expect(onUserScrollIntent).not.toHaveBeenCalled();
        Object.defineProperties(messagesContainerRef.current!, {
            clientWidth: {
                configurable: true,
                value: 90,
            },
            getBoundingClientRect: {
                configurable: true,
                value: () => ({
                    right: 100,
                }),
            },
            offsetWidth: {
                configurable: true,
                value: 100,
            },
        });
        fireEvent.scroll(messagesContainerRef.current!);
        fireEvent.pointerDown(messagesContainerRef.current!, {
            clientX: 95,
        });
        fireEvent.wheel(messagesContainerRef.current!);
        fireEvent.touchMove(messagesContainerRef.current!);
        const deleteMessageButton = screen.getByRole("button", {
            name: /delete your message/i,
        });
        deleteMessageButton.focus();
        fireEvent.keyDown(deleteMessageButton, {
            key: "PageUp",
        });
        await user.click(deleteMessageButton);
        await user.click(
            screen.getByRole("button", {
                name: /open chat image 1 preview/i,
            })
        );
        const chatImage = screen.getByAltText("Chat attachment");
        expect(chatImage).toHaveAttribute(
            "src",
            "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full?preview=image"
        );
        expect(
            document.querySelector('img[src="https://files.example.test/chat-image.png"]')
        ).toBeNull();
        expect(
            screen.getByRole("button", {
                name: "Open chat image 2 preview",
            })
        ).toBeInTheDocument();
        const dynamicContentLoadCount = onDynamicContentLoad.mock.calls.length;
        fireEvent.load(chatImage);
        fireEvent.error(chatImage);
        await user.click(
            screen.getByRole("button", {
                name: /readme.txt/i,
            })
        );
        expect(onScroll).toHaveBeenCalledTimes(1);
        expect(onUserScrollIntent).toHaveBeenCalledTimes(4);
        expect(onFollow).toHaveBeenCalledTimes(1);
        expect(onDynamicContentLoad).toHaveBeenCalledTimes(dynamicContentLoadCount + 2);
        expect(onDeleteMessage).toHaveBeenCalledWith("user", ["user", "user-history"]);
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "image",
                title: "Chat image",
                url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
            })
        );
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "text",
                title: "readme.txt",
            })
        );
        const activityText = screen.getByText(longActivityText);
        expect(activityText).toHaveClass("min-w-0", "flex-1", "wrap-break-word");
        expect(messagesContainerRef.current).toHaveClass("overflow-x-hidden");
        expect(screen.getByLabelText("Assistant is working")).toBeInTheDocument();
    });
});
