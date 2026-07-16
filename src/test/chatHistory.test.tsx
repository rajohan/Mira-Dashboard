import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";
import type { MutableRefObject } from "react";

import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import type { ChatTransport } from "../components/features/chat/transport/chatTransport";
import { useChatHistory } from "../components/features/chat/useChatHistory";

const SESSION = "agent:main:main";

function message(text: string): ChatHistoryMessage {
    return { content: text, role: "assistant", text };
}

function unsubscribe(): void {}

function subscribeToNothing(): () => void {
    return unsubscribe;
}

function transportWithHistory(history: ChatTransport["history"]): ChatTransport {
    return {
        abort: jest.fn(async () => {}),
        connectionGeneration: 1,
        history,
        isConnected: true,
        models: jest.fn(async () => []),
        patchSession: jest.fn(async () => {}),
        send: jest.fn(async () => ({})),
        snapshot: jest.fn(async () => ({
            completed: false,
            events: [],
            throughSequence: 0,
        })),
        subscribe: subscribeToNothing,
    };
}

describe("chat history controller", () => {
    it("does not let an older refresh overwrite a newer response", async () => {
        const olderRefresh = Promise.withResolvers<ChatHistoryMessage[]>();
        const newerRefresh = Promise.withResolvers<ChatHistoryMessage[]>();
        const history = jest
            .fn<ChatTransport["history"]>()
            .mockResolvedValueOnce([message("initial")])
            .mockImplementationOnce(() => olderRefresh.promise)
            .mockImplementationOnce(() => newerRefresh.promise);
        const transport = transportWithHistory(history);
        const selectedSessionKeyReference = {
            current: SESSION,
        } as MutableRefObject<string>;
        const stickToBottomReference = {
            current: true,
        } as MutableRefObject<boolean>;
        const { result, rerender } = renderHook(
            ({ updatedAt }: { updatedAt?: number }) =>
                useChatHistory({
                    isConnected: true,
                    onError: jest.fn(),
                    selectedSessionKey: SESSION,
                    selectedSessionKeyReference,
                    selectedSessionUpdatedAt: updatedAt,
                    setIsAtBottom: jest.fn(),
                    shouldStickToBottomReference: stickToBottomReference,
                    transport,
                }),
            { initialProps: { updatedAt: undefined as number | undefined } }
        );

        await waitFor(() => expect(result.current.messages[0]?.text).toBe("initial"));
        act(() => result.current.refreshSoon(SESSION, 0));
        await waitFor(() => expect(history).toHaveBeenCalledTimes(2));

        rerender({ updatedAt: 1 });
        await waitFor(() => expect(history).toHaveBeenCalledTimes(3));
        await act(async () => {
            newerRefresh.resolve([message("newer")]);
            await newerRefresh.promise;
        });
        expect(result.current.messages[0]?.text).toBe("newer");

        await act(async () => {
            olderRefresh.resolve([message("older")]);
            await olderRefresh.promise;
        });
        expect(result.current.messages[0]?.text).toBe("newer");
    });
});
