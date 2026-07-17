import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";
import type { RefObject } from "react";

import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import type { ChatTransport } from "../components/features/chat/transport/chatTransport";
import { useChatHistory } from "../components/features/chat/useChatHistory";

const SESSION = "agent:main:main";
const OTHER_SESSION = "agent:other:main";

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
    it("preserves an optimistic send while the first history request is pending", async () => {
        const initialLoad = Promise.withResolvers<ChatHistoryMessage[]>();
        const history = jest
            .fn<ChatTransport["history"]>()
            .mockImplementationOnce(() => initialLoad.promise);
        const selectedSessionKeyReference = {
            current: SESSION,
        } as RefObject<string>;
        const stickToBottomReference = {
            current: true,
        } as RefObject<boolean>;
        const { result } = renderHook(() =>
            useChatHistory({
                isConnected: true,
                onError: jest.fn(),
                selectedSessionKey: SESSION,
                selectedSessionKeyReference,
                setIsAtBottom: jest.fn(),
                shouldStickToBottomReference: stickToBottomReference,
                transport: transportWithHistory(history),
            })
        );

        await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
        act(() =>
            result.current.setMessages([
                {
                    content: "new prompt",
                    local: true,
                    role: "user",
                    text: "new prompt",
                    timestamp: "2026-07-17T01:00:00.000Z",
                },
            ])
        );

        await act(async () => {
            initialLoad.resolve([message("older answer")]);
            await initialLoad.promise;
        });

        expect(result.current.messages.map((entry) => entry.text)).toEqual([
            "older answer",
            "new prompt",
        ]);
    });

    it("shows a background refresh that wins the initial-load race", async () => {
        const initialLoad = Promise.withResolvers<ChatHistoryMessage[]>();
        const backgroundRefresh = Promise.withResolvers<ChatHistoryMessage[]>();
        const history = jest
            .fn<ChatTransport["history"]>()
            .mockImplementationOnce(() => initialLoad.promise)
            .mockImplementationOnce(() => backgroundRefresh.promise);
        const selectedSessionKeyReference = {
            current: SESSION,
        } as RefObject<string>;
        const stickToBottomReference = {
            current: true,
        } as RefObject<boolean>;
        const onError = jest.fn();
        const { result } = renderHook(() =>
            useChatHistory({
                isConnected: true,
                onError,
                selectedSessionKey: SESSION,
                selectedSessionKeyReference,
                setIsAtBottom: jest.fn(),
                shouldStickToBottomReference: stickToBottomReference,
                transport: transportWithHistory(history),
            })
        );

        act(() => result.current.refreshSoon(SESSION, 0));
        await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
        await act(async () => {
            backgroundRefresh.resolve([message("refreshed")]);
            await backgroundRefresh.promise;
        });
        expect(result.current.messages[0]?.text).toBe("refreshed");

        await act(async () => {
            initialLoad.reject(new Error("stale initial failure"));
            try {
                await initialLoad.promise;
            } catch {
                // The rejected initial request is the stale response under test.
            }
        });
        expect(result.current.messages[0]?.text).toBe("refreshed");
        expect(onError).toHaveBeenCalledTimes(2);
        const staleErrorUpdate = onError.mock.calls[1]?.[0] as (
            previous: string | undefined
        ) => string | undefined;
        expect(staleErrorUpdate("existing error")).toBe("existing error");
    });

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
        } as RefObject<string>;
        const stickToBottomReference = {
            current: true,
        } as RefObject<boolean>;
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

    it("does not merge the previous session into a refresh that wins first load", async () => {
        const initialOtherLoad = Promise.withResolvers<ChatHistoryMessage[]>();
        const otherRefresh = Promise.withResolvers<ChatHistoryMessage[]>();
        const history = jest
            .fn<ChatTransport["history"]>()
            .mockResolvedValueOnce([message("selected history")])
            .mockImplementationOnce(() => initialOtherLoad.promise)
            .mockImplementationOnce(() => otherRefresh.promise);
        const selectedSessionKeyReference = {
            current: SESSION,
        } as RefObject<string>;
        const stickToBottomReference = {
            current: true,
        } as RefObject<boolean>;
        const { result, rerender } = renderHook(
            ({ sessionKey }: { sessionKey: string }) =>
                useChatHistory({
                    isConnected: true,
                    onError: jest.fn(),
                    selectedSessionKey: sessionKey,
                    selectedSessionKeyReference,
                    setIsAtBottom: jest.fn(),
                    shouldStickToBottomReference: stickToBottomReference,
                    transport: transportWithHistory(history),
                }),
            { initialProps: { sessionKey: SESSION } }
        );

        await waitFor(() =>
            expect(result.current.messages.map((entry) => entry.text)).toEqual([
                "selected history",
            ])
        );
        act(() => {
            selectedSessionKeyReference.current = OTHER_SESSION;
            rerender({ sessionKey: OTHER_SESSION });
        });
        await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
        act(() => result.current.refreshSoon(OTHER_SESSION, 0));
        await waitFor(() => expect(history).toHaveBeenCalledTimes(3));
        await act(async () => {
            otherRefresh.resolve([message("other history")]);
            await otherRefresh.promise;
        });

        expect(result.current.messages.map((entry) => entry.text)).toEqual([
            "other history",
        ]);

        await act(async () => {
            initialOtherLoad.resolve([message("stale other history")]);
            await initialOtherLoad.promise;
        });
        expect(result.current.messages.map((entry) => entry.text)).toEqual([
            "other history",
        ]);
    });

    it("refreshes settled history without changing scroll stickiness", async () => {
        const history = jest
            .fn<ChatTransport["history"]>()
            .mockResolvedValueOnce([message("initial")])
            .mockResolvedValueOnce([message("settled")]);
        const setIsAtBottom = jest.fn();
        const selectedSessionKeyReference = {
            current: SESSION,
        } as RefObject<string>;
        const stickToBottomReference = {
            current: false,
        } as RefObject<boolean>;
        const { result } = renderHook(() =>
            useChatHistory({
                isConnected: true,
                onError: jest.fn(),
                selectedSessionKey: SESSION,
                selectedSessionKeyReference,
                setIsAtBottom,
                shouldStickToBottomReference: stickToBottomReference,
                transport: transportWithHistory(history),
            })
        );

        await waitFor(() => expect(result.current.messages[0]?.text).toBe("initial"));
        await waitFor(() => expect(setIsAtBottom).toHaveBeenCalled());
        stickToBottomReference.current = false;
        setIsAtBottom.mockClear();
        act(() => result.current.refreshSoon(SESSION, 0));
        await waitFor(() => expect(result.current.messages[0]?.text).toBe("settled"));

        expect(history).toHaveBeenCalledTimes(2);
        expect(setIsAtBottom).not.toHaveBeenCalled();
    });
});
