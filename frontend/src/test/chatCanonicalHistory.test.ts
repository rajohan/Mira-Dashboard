import { describe, expect, it } from "bun:test";

import { canonicalizeOpenClawHistoryPage } from "../../../contracts/chat/openClawHistoryPageAdapter";
import { parseCanonicalChatHistoryPage } from "../../../contracts/chatCanonicalHistory";
import { summarizeCanonicalChatValueForFingerprint } from "../../../contracts/chatCanonicalMessage";

const SESSION = "agent:main:format-probe";

describe("canonical chat history contract", () => {
    it("canonicalizes redacted Codex history with UUID identity and sequence", () => {
        const raw = {
            hasMore: false,
            messages: [
                {
                    __openclaw: {
                        id: "018f3f55-9a79-7f70-a8d8-111111111111",
                        seq: 2,
                    },
                    content: [
                        {
                            arguments: { cmd: "pwd" },
                            id: "call_codex_probe",
                            name: "functions.exec_command",
                            type: "toolCall",
                        },
                    ],
                    model: "gpt-5.6-sol",
                    provider: "openai",
                    role: "assistant",
                    stopReason: "toolUse",
                    timestamp: "2026-07-30T05:10:00.000Z",
                },
                {
                    __openclaw: {
                        id: "018f3f55-9a79-7f70-a8d8-222222222222",
                        seq: 3,
                    },
                    content: [{ text: "/workspace", type: "text" }],
                    model: "gpt-5.6-sol",
                    provider: "openai",
                    role: "toolResult",
                    toolCallId: "call_codex_probe",
                    toolName: "functions.exec_command",
                },
            ],
            offset: 0,
            sessionId: "codex-session",
            sessionKey: SESSION,
            totalMessages: 4,
        };

        const first = canonicalizeOpenClawHistoryPage(raw, {
            offset: 0,
            sessionKey: SESSION,
        });
        const replay = canonicalizeOpenClawHistoryPage(raw, {
            offset: 0,
            sessionKey: SESSION,
        });

        expect(first).toMatchObject({
            offset: 0,
            schemaVersion: 1,
            sessionId: "codex-session",
            sessionKey: SESSION,
            totalMessages: 4,
        });
        expect(first.messages[0]).toMatchObject({
            id: `openclaw-history:${encodeURIComponent(
                SESSION
            )}:018f3f55-9a79-7f70-a8d8-111111111111`,
            message: {
                isToolUse: true,
                role: "assistant",
                toolCalls: [
                    {
                        id: "call_codex_probe",
                        name: "functions.exec_command",
                    },
                ],
            },
            provider: {
                eventName: "chat.history",
                format: "openclaw-history",
                model: "gpt-5.6-sol",
                provider: "openai",
            },
            sequence: 2,
            source: "openclaw-history",
        });
        expect(first.messages[1]?.message.toolResult).toMatchObject({
            content: "/workspace",
            id: "call_codex_probe",
            name: "functions.exec_command",
        });
        expect(replay.messages.map((row) => row.id)).toEqual(
            first.messages.map((row) => row.id)
        );
    });

    it("uses nested Synthetic history metadata and preserves mixed content blocks", () => {
        const page = canonicalizeOpenClawHistoryPage(
            {
                hasMore: false,
                messages: [
                    {
                        __openclaw: { id: "syn_probe_a1", seq: 2 },
                        content: [
                            {
                                thinking: "Inspect the current directory.",
                                type: "thinking",
                            },
                            {
                                arguments: { command: "pwd" },
                                id: "syn_tool_1",
                                name: "functions.exec_command",
                                type: "toolCall",
                            },
                        ],
                        model: "syn:large:text",
                        provider: "synthetic",
                        role: "assistant",
                        stopReason: "toolUse",
                    },
                    {
                        __openclaw: { id: "syn_probe_t1", seq: 3 },
                        content: [{ text: "/workspace", type: "text" }],
                        model: "syn:large:text",
                        provider: "synthetic",
                        role: "toolResult",
                        toolCallId: "syn_tool_1",
                        toolName: "functions.exec_command",
                    },
                ],
                model: "gpt-5.6-sol",
                modelProvider: "openai",
                offset: 0,
                sessionId: "synthetic-session",
                sessionKey: "agent:stale:other",
                totalMessages: 4,
            },
            { offset: 0, sessionKey: SESSION }
        );

        expect(page.messages[0]).toMatchObject({
            id: `openclaw-history:${encodeURIComponent(SESSION)}:syn_probe_a1`,
            message: {
                isToolUse: true,
                thinking: [{ text: "Inspect the current directory." }],
                toolCalls: [
                    {
                        id: "syn_tool_1",
                        name: "functions.exec_command",
                    },
                ],
            },
            provider: {
                model: "syn:large:text",
                provider: "synthetic",
            },
            sequence: 2,
        });
        expect(page.messages[1]).toMatchObject({
            message: {
                toolResult: {
                    content: "/workspace",
                    id: "syn_tool_1",
                    name: "functions.exec_command",
                },
            },
            provider: {
                model: "syn:large:text",
                provider: "synthetic",
            },
            sequence: 3,
        });
    });

    it("summarizes hydrated media bytes while preserving text and tool identity", () => {
        const imageData = `image-head-${"a".repeat(200_000)}-image-tail`;
        const raw = {
            messages: [
                {
                    content: [
                        { text: "Inspect", type: "text" },
                        {
                            arguments: { command: "pwd" },
                            id: "tool-1",
                            name: "functions.exec_command",
                            type: "toolCall",
                        },
                        { data: imageData, mimeType: "image/png", type: "image" },
                    ],
                    role: "assistant",
                },
            ],
            offset: 0,
        };
        const first = canonicalizeOpenClawHistoryPage(raw, {
            offset: 0,
            sessionKey: SESSION,
        });
        const changedTool = canonicalizeOpenClawHistoryPage(
            {
                ...raw,
                messages: [
                    {
                        ...raw.messages[0],
                        content: [
                            { text: "Inspect", type: "text" },
                            {
                                arguments: { command: "ls" },
                                id: "tool-1",
                                name: "functions.exec_command",
                                type: "toolCall",
                            },
                            {
                                data: imageData,
                                mimeType: "image/png",
                                type: "image",
                            },
                        ],
                    },
                ],
            },
            { offset: 0, sessionKey: SESSION }
        );

        expect(first.messages[0]?.id).not.toContain("image-head");
        expect(changedTool.messages[0]?.id).not.toBe(first.messages[0]?.id);
    });

    it("bounds canonical media fields without rewriting similarly named tool data", () => {
        const summarized = summarizeCanonicalChatValueForFingerprint([
            {
                data: "a".repeat(10_000),
                mimeType: "image/png",
                type: "image",
            },
            {
                arguments: { data: "tool-data-must-remain-exact" },
                name: "exec",
                type: "toolCall",
            },
            {
                contentBase64: "b".repeat(10_000),
                fileName: "result.png",
                kind: "image",
            },
        ]) as Array<Record<string, unknown>>;

        expect(summarized[0]?.data).toMatchObject({ length: 10_000 });
        expect(
            (summarized[1]?.arguments as Record<string, unknown> | undefined)?.data
        ).toBe("tool-data-must-remain-exact");
        expect(summarized[2]?.contentBase64).toMatchObject({ length: 10_000 });
    });

    it("keeps repeated metadata-less rows distinct with stable page positions", () => {
        const raw = {
            messages: [
                { content: "OK", role: "assistant" },
                { content: "OK", role: "assistant" },
            ],
            offset: 0,
        };
        const first = canonicalizeOpenClawHistoryPage(raw, {
            offset: 0,
            sessionKey: SESSION,
        });
        const replay = canonicalizeOpenClawHistoryPage(raw, {
            offset: 0,
            sessionKey: SESSION,
        });

        expect(new Set(first.messages.map((row) => row.id)).size).toBe(2);
        expect(replay.messages.map((row) => row.id)).toEqual(
            first.messages.map((row) => row.id)
        );
    });

    it("keeps distinct seq-only sibling rows when provider ids are absent", () => {
        const page = canonicalizeOpenClawHistoryPage(
            {
                messages: [
                    {
                        __openclaw: { seq: 7 },
                        content: [
                            {
                                arguments: { command: "pwd" },
                                name: "functions.exec_command",
                                type: "toolCall",
                            },
                        ],
                        role: "assistant",
                    },
                    {
                        __openclaw: { seq: 7 },
                        content: [{ text: "/workspace", type: "text" }],
                        role: "toolResult",
                        toolName: "functions.exec_command",
                    },
                ],
                offset: 0,
            },
            { offset: 0, sessionKey: SESSION }
        );

        expect(new Set(page.messages.map((row) => row.id)).size).toBe(2);
        expect(page.messages.map((row) => row.sequence)).toEqual([7, 7]);
    });

    it("uses idempotency keys to distinguish repeated seq-only user rows", () => {
        const page = canonicalizeOpenClawHistoryPage(
            {
                messages: [
                    {
                        __openclaw: { seq: 7 },
                        content: "repeat",
                        idempotencyKey: "dashboard-chat-first:user",
                        role: "user",
                        timestamp: "2026-07-30T05:10:00.000Z",
                    },
                    {
                        __openclaw: { seq: 7 },
                        content: "repeat",
                        idempotencyKey: "dashboard-chat-second:user",
                        role: "user",
                        timestamp: "2026-07-30T05:10:00.000Z",
                    },
                ],
                offset: 0,
            },
            { offset: 0, sessionKey: SESSION }
        );

        expect(new Set(page.messages.map((row) => row.id)).size).toBe(2);
        expect(page.messages.map((row) => row.message.runId)).toEqual([
            "dashboard-chat-first",
            "dashboard-chat-second",
        ]);
    });

    it("includes top-level media references in seq-only row identity", () => {
        const page = canonicalizeOpenClawHistoryPage(
            {
                messages: [
                    {
                        __openclaw: { seq: 8 },
                        content: "Generated image",
                        MediaPath: "/tmp/first.png",
                        MediaType: "image/png",
                        role: "assistant",
                    },
                    {
                        __openclaw: { seq: 8 },
                        content: "Generated image",
                        MediaPath: "/tmp/second.webp",
                        MediaType: "image/webp",
                        role: "assistant",
                    },
                ],
                offset: 0,
            },
            { offset: 0, sessionKey: SESSION }
        );

        expect(new Set(page.messages.map((row) => row.id)).size).toBe(2);
        expect(page.messages.map((row) => row.sequence)).toEqual([8, 8]);
        expect(
            page.messages.map((row) =>
                row.message.attachments?.map((attachment) => attachment.fileName)
            )
        ).toEqual([["first.png"], ["second.webp"]]);
    });

    it("accepts OpenClaw complete snapshots without pagination offsets", () => {
        const page = canonicalizeOpenClawHistoryPage(
            {
                completeSnapshot: true,
                hasMore: false,
                messages: [{ content: "Imported", role: "assistant" }],
                totalMessages: 1,
            },
            { offset: 0, sessionKey: SESSION }
        );

        expect(page).toMatchObject({
            hasMore: false,
            offset: 0,
            totalMessages: 1,
        });
        expect(page.messages).toHaveLength(1);
    });

    it("accepts anchored history windows without pagination offsets", () => {
        const page = canonicalizeOpenClawHistoryPage(
            {
                messages: [{ content: "Anchored", role: "assistant" }],
                sessionId: "session-1",
            },
            {
                messageId: "message-anchor",
                offset: 0,
                sessionKey: SESSION,
            }
        );

        expect(page).toMatchObject({
            hasMore: false,
            offset: 0,
            sessionId: "session-1",
        });
        expect(page.messages).toHaveLength(1);
    });

    it("accepts an omitted first-page offset and rejects unsafe page offsets", () => {
        expect(
            canonicalizeOpenClawHistoryPage(
                { messages: [] },
                { offset: 0, sessionKey: SESSION }
            ).offset
        ).toBe(0);
        expect(() =>
            canonicalizeOpenClawHistoryPage(
                { messages: [] },
                { offset: 2, sessionKey: SESSION }
            )
        ).toThrow("requested 2, received missing");
        expect(() =>
            canonicalizeOpenClawHistoryPage(
                { messages: [], offset: 1 },
                { offset: 0, sessionKey: SESSION }
            )
        ).toThrow("requested 0, received 1");
        for (const offset of [-1, 1.5, "0"]) {
            expect(() =>
                canonicalizeOpenClawHistoryPage(
                    { messages: [], offset },
                    { offset: 0, sessionKey: SESSION }
                )
            ).toThrow("offset is invalid");
        }
    });

    it("invalidates raw provider pages at the frontend contract boundary", () => {
        expect(() =>
            parseCanonicalChatHistoryPage({
                messages: [{ content: "raw", role: "assistant" }],
            })
        ).toThrow("chatHistory");
    });
});
