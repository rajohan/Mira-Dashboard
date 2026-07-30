import { describe, expect, it } from "bun:test";

import { renderHook } from "@testing-library/react";

import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import { createChatRuntimeState } from "../components/features/chat/domain/chatState";
import { useChatProjectionShadow } from "../components/features/chat/useChatProjectionShadow";

describe("chat projection shadow hook", () => {
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
                return useChatProjectionShadow({
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
        const history: ChatHistoryMessage[] = [];
        const runtime = createChatRuntimeState();
        const deletedMessageKeys = new Set<string>();
        const { result, rerender } = renderHook(
            ({ shouldShowThinking }: { shouldShowThinking: boolean }) =>
                useChatProjectionShadow({
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
    });
});
