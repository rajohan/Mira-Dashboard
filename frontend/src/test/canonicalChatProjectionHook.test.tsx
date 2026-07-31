import { describe, expect, it } from "bun:test";

import { renderHook } from "@testing-library/react";

import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import { createChatRuntimeState } from "../components/features/chat/domain/chatState";
import { useCanonicalChatProjection } from "../components/features/chat/useCanonicalChatProjection";

describe("canonical chat projection hook", () => {
    it("reuses projection work across unrelated parent renders", () => {
        const history = [
            {
                content: "Loaded answer",
                role: "assistant",
                text: "Loaded answer",
            },
        ];
        const runtime = createChatRuntimeState();
        const deletedMessageKeys = new Set<string>();
        const { result, rerender } = renderHook(
            ({ unrelatedValue }: { unrelatedValue: string }) => {
                void unrelatedValue;
                return useCanonicalChatProjection({
                    deletedMessageKeys,
                    history,
                    runtime,
                    selectedSessionKey: "agent:main:main",
                    shouldKeepThinkingAfterFinal: true,
                    shouldShowThinking: true,
                    shouldShowTools: true,
                });
            },
            { initialProps: { unrelatedValue: "before" } }
        );
        const initial = result.current;

        rerender({ unrelatedValue: "after" });

        expect(result.current).toBe(initial);
    });

    it("reprojects when a semantic input changes", () => {
        const history: ChatHistoryMessage[] = [
            {
                content: [{ text: "private analysis", type: "thinking" }],
                role: "assistant",
                text: "",
                thinking: [{ text: "private analysis" }],
            },
        ];
        const runtime = createChatRuntimeState();
        const deletedMessageKeys = new Set<string>();
        const { result, rerender } = renderHook(
            ({ shouldShowThinking }: { shouldShowThinking: boolean }) =>
                useCanonicalChatProjection({
                    deletedMessageKeys,
                    history,
                    runtime,
                    selectedSessionKey: "agent:main:main",
                    shouldKeepThinkingAfterFinal: true,
                    shouldShowThinking,
                    shouldShowTools: true,
                }),
            { initialProps: { shouldShowThinking: true } }
        );
        const initial = result.current;

        rerender({ shouldShowThinking: false });

        expect(result.current).not.toBe(initial);
        expect(initial.projection.rows.length).toBeGreaterThan(
            result.current.projection.rows.length
        );
    });
});
