import { describe, expect, it } from "vitest";

import {
    createChatVisibility,
    createLocalSystemMessage,
    finalMessageFromPayload,
    historyContainsRecoveredStream,
    isRecord,
    isSameSessionKey,
    mergeStreamMessage,
    mergeStreamText,
    normalizeAssistantPayload,
    payloadIsCommandMessage,
    shouldShowStreamRow,
    uniqueStrings,
    visibleHistoryMessages,
} from "./chatRuntime";
import type { ChatHistoryMessage } from "./chatTypes";
import { DEFAULT_CHAT_VISIBILITY } from "./chatTypes";

function message(overrides: Partial<ChatHistoryMessage>): ChatHistoryMessage {
    return {
        role: "assistant",
        content: overrides.text || "",
        text: "",
        ...overrides,
    };
}

describe("chat runtime helpers", () => {
    it("merges stream text without duplicating recovered chunks", () => {
        expect(mergeStreamText("hello", "")).toBe("hello");
        expect(mergeStreamText("", "hello")).toBe("hello");
        expect(mergeStreamText("hello", "hello world")).toBe("hello world");
        expect(mergeStreamText("hello world", "world")).toBe("hello world");
        expect(mergeStreamText("hello", " world")).toBe("hello world");
    });

    it("dedupes strings and compares session aliases", () => {
        expect(uniqueStrings(["main", undefined, "ops", "main"])).toEqual([
            "main",
            "ops",
        ]);

        expect(isSameSessionKey("agent:main:main", "MAIN")).toBe(true);
        expect(isSameSessionKey("agent:main:main", "agent:main:MAIN")).toBe(true);
        expect(isSameSessionKey("agent:main:main", "agent:ops:main")).toBe(false);
        expect(isSameSessionKey(undefined, "main")).toBe(false);
    });

    it("normalizes assistant payloads and final stream messages", () => {
        expect(normalizeAssistantPayload("plain text")).toMatchObject({
            role: "assistant",
            text: "plain text",
        });
        expect(normalizeAssistantPayload({ role: "user", text: "hello" })).toMatchObject({
            role: "user",
            text: "hello",
        });

        const finalMessage = finalMessageFromPayload({ runId: "run-1", text: "done" });
        expect(finalMessage).toMatchObject({
            role: "assistant",
            text: "done",
            runId: "run-1",
        });
        expect(finalMessage.timestamp).toBeTruthy();
    });

    it("merges stream message display fields from next and previous messages", () => {
        const previous = message({
            text: "old",
            images: [{ type: "image", data: "old" }],
            attachments: [{ id: "a", fileName: "a.txt", kind: "text" }],
            thinking: [{ text: "thinking" }],
        });
        const next = message({
            content: [{ type: "text", text: "next" }],
            text: "next",
            toolCalls: [{ name: "read" }],
        });

        expect(mergeStreamMessage(previous, next, "merged", "run-2")).toMatchObject({
            role: "assistant",
            content: next.content,
            text: "merged",
            images: previous.images,
            attachments: previous.attachments,
            thinking: previous.thinking,
            toolCalls: next.toolCalls,
            runId: "run-2",
        });
    });

    it("detects command payloads and creates local system messages", () => {
        expect(isRecord({ ok: true })).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(payloadIsCommandMessage({ command: true })).toBe(true);
        expect(payloadIsCommandMessage({ command: false })).toBe(false);

        expect(createLocalSystemMessage("notice")).toMatchObject({
            role: "system",
            text: "notice",
            local: true,
            images: [],
            attachments: [],
        });
    });

    it("detects recovered streams in assistant history", () => {
        expect(
            historyContainsRecoveredStream(
                [message({ role: "assistant", text: "long recovered answer" })],
                "recovered answer"
            )
        ).toBe(true);
        expect(
            historyContainsRecoveredStream(
                [message({ role: "user", text: "answer" })],
                "answer"
            )
        ).toBe(false);
    });

    it("wraps chat visibility and stream-row visibility decisions", () => {
        expect(createChatVisibility(true, false)).toEqual({
            showThinking: true,
            showTools: false,
        });

        expect(
            visibleHistoryMessages(
                [
                    {
                        role: "assistant",
                        content: [{ type: "thinking", thinking: "hidden" }],
                    },
                ],
                DEFAULT_CHAT_VISIBILITY
            )
        ).toEqual([]);

        expect(shouldShowStreamRow("streaming", undefined, DEFAULT_CHAT_VISIBILITY)).toBe(
            true
        );
        expect(
            shouldShowStreamRow(
                "",
                message({ role: "assistant", text: "visible" }),
                DEFAULT_CHAT_VISIBILITY
            )
        ).toBe(true);
        expect(
            shouldShowStreamRow(
                "",
                message({ role: "assistant", text: "", thinking: [{ text: "hidden" }] }),
                DEFAULT_CHAT_VISIBILITY
            )
        ).toBe(false);
    });
});
