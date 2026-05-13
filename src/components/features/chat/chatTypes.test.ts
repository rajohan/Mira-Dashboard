import { describe, expect, it } from "vitest";

import type { ChatHistoryMessage, ChatSendAttachment } from "./chatTypes";
import {
    attachmentKind,
    extractImages,
    extractThinkingBlocks,
    extractToolCalls,
    gatewayAttachments,
    isRenderableChatHistoryMessage,
    normalizeChatHistoryMessage,
    normalizeText,
    normalizeVisibleChatHistoryMessages,
    optimisticAttachmentDisplay,
} from "./chatTypes";

function sendAttachment(overrides: Partial<ChatSendAttachment> = {}): ChatSendAttachment {
    return {
        id: "att-1",
        file: new File(["hello"], "hello.txt", { type: "text/plain" }),
        fileName: "hello.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        contentBase64: "aGVsbG8=",
        kind: "text",
        ...overrides,
    };
}

function historyMessage(overrides: Partial<ChatHistoryMessage>): ChatHistoryMessage {
    return {
        role: "assistant",
        content: overrides.text || "",
        text: "",
        images: [],
        attachments: [],
        ...overrides,
    };
}

describe("chat type normalizers", () => {
    it("extracts images, thinking blocks, and tool calls from content blocks", () => {
        const content = [
            null,
            { type: "image", data: "abc" },
            { type: "thinking", thinking: "considering" },
            { type: "thinking", text: "fallback thought" },
            { type: "thinking" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
            { type: "toolCall" },
            { type: "text", text: "hello" },
        ];

        expect(extractImages(content)).toEqual([{ type: "image", data: "abc" }]);
        expect(extractThinkingBlocks(content)).toEqual([
            { text: "considering" },
            { text: "fallback thought" },
        ]);
        expect(extractToolCalls(content)).toEqual([
            { id: "call-1", name: "read", arguments: { path: "x" } },
            { id: undefined, name: "tool", arguments: undefined },
        ]);
    });

    it("maps attachment kinds and send attachments", () => {
        expect(attachmentKind("image/png")).toBe("image");
        expect(attachmentKind("text/markdown")).toBe("text");
        expect(attachmentKind("application/json")).toBe("text");
        expect(attachmentKind("application/zip")).toBe("file");

        const attachment = sendAttachment({ dataUrl: "data:text/plain;base64,aGVsbG8=" });
        expect(gatewayAttachments([attachment])).toEqual([
            {
                type: "text",
                mimeType: "text/plain",
                fileName: "hello.txt",
                content: "aGVsbG8=",
            },
        ]);
        expect(optimisticAttachmentDisplay([attachment])).toEqual([
            {
                id: "att-1",
                fileName: "hello.txt",
                mimeType: "text/plain",
                sizeBytes: 5,
                dataUrl: "data:text/plain;base64,aGVsbG8=",
                contentBase64: "aGVsbG8=",
                kind: "text",
            },
        ]);
    });

    it("normalizes text, media directives, inline files, and timestamps", () => {
        const normalized = normalizeChatHistoryMessage({
            role: "assistant",
            timestamp: 1778407200000,
            content:
                "hello\nMEDIA:   \nMEDIA:/tmp/archive.unknown\nMEDIA:/tmp/picture.png\n" +
                '<file name="note.txt" mime="text/plain">hello</file>' +
                '<file name="photo.svg" mime="image/svg+xml"><<<EXTERNAL_UNTRUSTED_CONTENT test>>>\n---\n<svg /><<<END_EXTERNAL_UNTRUSTED_CONTENT test>>></file>',
        });

        expect(normalized).toMatchObject({
            role: "assistant",
            text: "hello",
            images: [],
            timestamp: "2026-05-10T10:00:00.000Z",
        });
        expect(normalized.attachments).toEqual([
            {
                id: "media-/tmp/archive.unknown-0",
                fileName: "archive.unknown",
                mimeType: "application/octet-stream",
                dataUrl: undefined,
                kind: "file",
            },
            {
                id: "media-/tmp/picture.png-1",
                fileName: "picture.png",
                mimeType: "image/png",
                dataUrl: "/api/media?path=%2Ftmp%2Fpicture.png",
                kind: "image",
            },
            {
                id: "inline-note.txt-0",
                fileName: "note.txt",
                mimeType: "text/plain",
                sizeBytes: 5,
                contentBase64: window.btoa("hello"),
                dataUrl: undefined,
                kind: "text",
            },
            {
                id: "inline-photo.svg-1",
                fileName: "photo.svg",
                mimeType: "image/svg+xml",
                sizeBytes: 7,
                contentBase64: window.btoa("<svg />"),
                dataUrl: `data:image/svg+xml;base64,${window.btoa("<svg />")}`,
                kind: "image",
            },
        ]);
    });

    it("normalizes media references and generated image-only text", () => {
        expect(
            normalizeChatHistoryMessage({
                role: "assistant",
                content: [{ type: "image", source: { data: "abc" } }],
            })
        ).toMatchObject({
            text: "",
            images: [{ type: "image", source: { data: "abc" } }],
        });

        expect(
            normalizeChatHistoryMessage({
                role: "tool",
                content: "artifact",
                MediaPaths: ["/tmp/report.json", String.raw`C:\tmp\photo.jpg`],
                MediaTypes: ["application/json"],
            }).attachments
        ).toEqual([
            {
                id: "/tmp/report.json-0",
                fileName: "report.json",
                mimeType: "application/json",
                dataUrl: undefined,
                kind: "text",
            },
            {
                id: String.raw`C:\tmp\photo.jpg-1`,
                fileName: "photo.jpg",
                mimeType: "image/jpeg",
                dataUrl: "/api/media?path=C%3A%5Ctmp%5Cphoto.jpg",
                kind: "image",
            },
        ]);

        expect(
            normalizeChatHistoryMessage({
                content: "MEDIA:relative",
                MediaPath: "/tmp/sound.mp3",
                MediaType: "audio/mpeg",
            })
        ).toMatchObject({
            role: "unknown",
            attachments: [
                {
                    id: "/tmp/sound.mp3-0",
                    fileName: "sound.mp3",
                    mimeType: "audio/mpeg",
                    kind: "file",
                },
                {
                    id: "media-relative-0",
                    fileName: "relative",
                    mimeType: "application/octet-stream",
                    kind: "file",
                },
            ],
        });
    });

    it("normalizes tool result messages", () => {
        expect(
            normalizeChatHistoryMessage({
                role: "tool_result",
                tool_call_id: "tool-1",
                tool_name: "image",
                isError: true,
                content: [
                    { type: "image", data: "abc" },
                    { type: "text", text: "done" },
                ],
            }).toolResult
        ).toEqual({
            id: "tool-1",
            name: "image",
            content: "[image]\n\ndone",
            isError: true,
            images: [{ type: "image", data: "abc" }],
        });

        expect(
            normalizeChatHistoryMessage({
                role: "tool",
                toolCallId: "tool-2",
                toolName: "exec",
                content: "done",
            }).toolResult
        ).toMatchObject({ id: "tool-2", name: "exec", content: "done" });
    });

    it("normalizes text from common content shapes", () => {
        expect(normalizeText("hello")).toBe("hello");
        expect(normalizeText({ text: "object text" })).toBe("object text");
        expect(normalizeText(["a", { text: "b" }, { type: "image" }, null])).toBe(
            "a\n\nb\n\n[image]"
        );
        expect(normalizeText({ nope: true })).toBe("");
    });

    it("filters visible history and carries hidden tool media to assistant replies", () => {
        const visible = normalizeVisibleChatHistoryMessages([
            {
                role: "tool",
                content: "MEDIA:/tmp/plot.png",
            },
            { role: "assistant", content: "Here it is" },
        ]);

        expect(visible).toHaveLength(1);
        expect(visible[0]).toMatchObject({ role: "assistant", text: "Here it is" });
        expect(visible[0]?.attachments?.[0]).toMatchObject({
            fileName: "plot.png",
            kind: "image",
        });

        expect(
            normalizeVisibleChatHistoryMessages([
                { role: "tool", content: "MEDIA:/tmp/result.txt" },
            ])[0]
        ).toMatchObject({ role: "assistant", attachments: [{ fileName: "result.txt" }] });

        expect(
            normalizeVisibleChatHistoryMessages(
                [{ role: "tool", content: "tool output", toolName: "exec" }],
                { showThinking: false, showTools: true }
            )[0]?.toolResult
        ).toMatchObject({ name: "exec", content: "tool output" });
    });

    it("decides renderability from text, media, thinking, and tools visibility", () => {
        expect(isRenderableChatHistoryMessage(historyMessage({ text: "hello" }))).toBe(
            true
        );
        expect(
            isRenderableChatHistoryMessage(
                historyMessage({ text: "", thinking: [{ text: "hidden" }] })
            )
        ).toBe(false);
        expect(
            isRenderableChatHistoryMessage(
                historyMessage({ text: "", thinking: [{ text: "visible" }] }),
                { showThinking: true, showTools: false }
            )
        ).toBe(true);
        expect(
            isRenderableChatHistoryMessage(
                historyMessage({
                    role: "tool",
                    toolResult: { content: "result" },
                }),
                { showThinking: false, showTools: true }
            )
        ).toBe(true);
        expect(
            isRenderableChatHistoryMessage(
                historyMessage({ role: "tool", toolResult: { content: "" } }),
                { showThinking: false, showTools: true }
            )
        ).toBe(false);
        expect(
            isRenderableChatHistoryMessage(
                historyMessage({
                    role: "tool",
                    toolResult: { content: " ", images: [{ type: "image" }] },
                }),
                { showThinking: false, showTools: true }
            )
        ).toBe(true);
        expect(
            isRenderableChatHistoryMessage(
                historyMessage({
                    role: "assistant",
                    text: "",
                    toolCalls: [{ name: "read" }],
                }),
                { showThinking: false, showTools: true }
            )
        ).toBe(true);
    });
});
