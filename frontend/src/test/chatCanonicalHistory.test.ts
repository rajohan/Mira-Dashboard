import { describe, expect, it } from "bun:test";

import { canonicalizeOpenClawHistoryPage } from "../../../contracts/chat/openClawHistoryPageAdapter";
import { parseCanonicalChatHistoryPage } from "../../../contracts/chatCanonicalHistory";

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

    it("invalidates raw provider pages at the frontend contract boundary", () => {
        expect(() =>
            parseCanonicalChatHistoryPage({
                messages: [{ content: "raw", role: "assistant" }],
            })
        ).toThrow("chatHistory");
    });
});
