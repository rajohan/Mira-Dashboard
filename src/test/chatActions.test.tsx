import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";
import type { SetStateAction } from "react";

import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import { createChatRuntimeState } from "../components/features/chat/domain/chatState";
import type { ChatTransport } from "../components/features/chat/transport/chatTransport";
import { useChatActions } from "../components/features/chat/useChatActions";
import type { ChatRuntimeController } from "../components/features/chat/useChatRuntime";
import type { Session } from "../types/session";

const SESSION_A = "agent:main:main";
const SESSION_B = "agent:other:main";
const DASHBOARD_CHAT_RUN_ID =
    /^dashboard-chat-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u;

function fakeRuntime(): ChatRuntimeController {
    return {
        acknowledgeRun: jest.fn(),
        beginRun: jest.fn(),
        clearRun: jest.fn(),
        clearSession: jest.fn(),
        failRun: jest.fn(),
        state: createChatRuntimeState(),
    };
}

async function defaultSend() {
    return { runId: "run-1" };
}

function unsubscribe() {}

function subscribe() {
    return unsubscribe;
}

function fakeTransport(
    send: ChatTransport["send"] = jest.fn(defaultSend)
): ChatTransport {
    return {
        abort: jest.fn(async () => {}),
        compact: jest.fn(async () => {}),
        connectionGeneration: 1,
        history: jest.fn(async () => []),
        isConnected: true,
        models: jest.fn(async () => []),
        patchSession: jest.fn(async () => {}),
        send,
        snapshot: jest.fn(async () => ({
            completed: false,
            events: [],
            throughSequence: 0,
        })),
        subscribe,
    };
}

function selectedSession(): Session {
    return {
        id: "legacy-id",
        key: SESSION_A,
        sessionId: "provider-session-id",
        verboseLevel: "full",
    } as Session;
}

describe("chat actions", () => {
    it("allows a new message to steer while the previous send acknowledgement is pending", async () => {
        const sendDeferred = Promise.withResolvers<{ runId?: string }>();
        const transport = fakeTransport(jest.fn(() => sendDeferred.promise));
        const runtime = fakeRuntime();
        const selectedSessionKeyReference = { current: SESSION_A };
        let messages: ChatHistoryMessage[] = [];
        const setMessages = jest.fn((update: SetStateAction<ChatHistoryMessage[]>) => {
            messages = typeof update === "function" ? update(messages) : update;
        });
        const { result, rerender } = renderHook(
            ({ activeRunCount, draft, isCompacting }) =>
                useChatActions({
                    activeRunCount,
                    attachments: [],
                    attachmentsReference: { current: [] },
                    clearAttachments: jest.fn(),
                    confirmResetSession: jest.fn(async () => true),
                    draft,
                    isCompacting,
                    isConnected: true,
                    isRecording: false,
                    isTranscribing: false,
                    runtime,
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: selectedSession(),
                    selectedSessionKey: SESSION_A,
                    selectedSessionKeyReference,
                    setDraft: jest.fn(),
                    setIsAtBottom: jest.fn(),
                    setMessages,
                    setSendError: jest.fn(),
                    shouldStickToBottomReference: { current: true },
                    transport,
                }),
            {
                initialProps: {
                    activeRunCount: 0,
                    draft: "first",
                    isCompacting: false,
                },
            }
        );

        let firstSend: Promise<void> | undefined;
        act(() => {
            firstSend = result.current.handleSend();
        });
        await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));

        rerender({ activeRunCount: 1, draft: "steer", isCompacting: true });
        expect(result.current.canSend).toBe(true);
        expect(result.current.preferenceControlsDisabled).toBe(false);
        expect(result.current.compactDisabled).toBe(true);

        let secondSend: Promise<void> | undefined;
        act(() => {
            secondSend = result.current.handleSend();
        });
        await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(2));
        expect(messages.map((message) => message.text)).toEqual(["first", "steer"]);
        expect(messages.map((message) => message.runId)).toEqual([
            expect.stringMatching(DASHBOARD_CHAT_RUN_ID),
            expect.stringMatching(DASHBOARD_CHAT_RUN_ID),
        ]);
        expect(runtime.beginRun).toHaveBeenNthCalledWith(
            1,
            SESSION_A,
            expect.stringMatching(DASHBOARD_CHAT_RUN_ID),
            { replaceStatusOnlyRuns: true }
        );
        expect(runtime.beginRun).toHaveBeenNthCalledWith(
            2,
            SESSION_A,
            expect.stringMatching(DASHBOARD_CHAT_RUN_ID),
            { replaceStatusOnlyRuns: false }
        );

        await act(async () => {
            sendDeferred.resolve({ runId: "run-1" });
            await Promise.all([firstSend, secondSend]);
        });
    });

    it("uses the session compaction RPC and clears request state when it finishes", async () => {
        const compactDeferred = Promise.withResolvers<void>();
        const transport = fakeTransport();
        transport.compact = jest.fn(() => compactDeferred.promise);
        const runtime = fakeRuntime();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsReference: { current: [] },
                clearAttachments: jest.fn(),
                confirmResetSession: jest.fn(async () => true),
                draft: "",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyReference: { current: SESSION_A },
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError: jest.fn(),
                shouldStickToBottomReference: { current: true },
                transport,
            })
        );

        let compactPromise: Promise<void> | undefined;
        act(() => {
            compactPromise = result.current.compactSelectedSession();
        });
        await waitFor(() => expect(transport.compact).toHaveBeenCalledWith(SESSION_A));
        expect(result.current.isCompactingSession).toBe(true);
        expect(result.current.compactDisabled).toBe(true);
        expect(runtime.beginRun).not.toHaveBeenCalled();

        await act(async () => {
            compactDeferred.resolve();
            await compactPromise;
        });
        expect(result.current.isCompactingSession).toBe(false);
    });

    it("clears a steer placeholder when the provider omits its run id", async () => {
        const transport = fakeTransport(jest.fn(async () => ({})));
        const runtime = fakeRuntime();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 1,
                attachments: [],
                attachmentsReference: { current: [] },
                clearAttachments: jest.fn(),
                confirmResetSession: jest.fn(async () => true),
                draft: "steer",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyReference: { current: SESSION_A },
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError: jest.fn(),
                shouldStickToBottomReference: { current: true },
                transport,
            })
        );

        await act(async () => result.current.handleSend());

        const optimisticRunId = (runtime.beginRun as ReturnType<typeof jest.fn>).mock
            .calls[0]?.[1] as string;
        expect(optimisticRunId).toMatch(DASHBOARD_CHAT_RUN_ID);
        expect(runtime.clearRun).toHaveBeenCalledWith(SESSION_A, optimisticRunId);
        expect(runtime.acknowledgeRun).not.toHaveBeenCalled();
    });

    it("keeps failed sends scoped to their initiating session", async () => {
        const sendDeferred = Promise.withResolvers<{ runId?: string }>();
        const transport = fakeTransport(jest.fn(() => sendDeferred.promise));
        const runtime = fakeRuntime();
        const selectedSessionKeyReference = { current: SESSION_A };
        let messages: ChatHistoryMessage[] = [];
        const setMessages = jest.fn((update: SetStateAction<ChatHistoryMessage[]>) => {
            messages = typeof update === "function" ? update(messages) : update;
        });
        const setSendError = jest.fn();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsReference: { current: [] },
                clearAttachments: jest.fn(),
                confirmResetSession: jest.fn(async () => true),
                draft: "hello",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyReference,
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages,
                setSendError,
                shouldStickToBottomReference: { current: true },
                transport,
            })
        );

        let sendPromise: Promise<void> | undefined;
        act(() => {
            sendPromise = result.current.handleSend();
        });
        await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
        expect(transport.send).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "provider-session-id",
                sessionKey: SESSION_A,
            })
        );

        selectedSessionKeyReference.current = SESSION_B;
        await act(async () => {
            sendDeferred.reject(new Error("delivery failed"));
            await sendPromise;
        });

        expect(runtime.failRun).toHaveBeenCalledWith(
            SESSION_A,
            expect.stringMatching(/^dashboard-chat-/u)
        );
        expect(setMessages).toHaveBeenCalledTimes(1);
        expect(messages).toHaveLength(1);
        expect(setSendError).not.toHaveBeenCalledWith("delivery failed");
    });

    it("generates a send id when randomUUID is unavailable", async () => {
        const crypto = globalThis.crypto;
        const originalRandomUuid = crypto.randomUUID;
        Object.defineProperty(crypto, "randomUUID", {
            configurable: true,
            value: undefined,
        });
        try {
            const transport = fakeTransport();
            const { result } = renderHook(() =>
                useChatActions({
                    activeRunCount: 0,
                    attachments: [],
                    attachmentsReference: { current: [] },
                    clearAttachments: jest.fn(),
                    confirmResetSession: jest.fn(async () => true),
                    draft: "fallback id",
                    isCompacting: false,
                    isConnected: true,
                    isRecording: false,
                    isTranscribing: false,
                    runtime: fakeRuntime(),
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: selectedSession(),
                    selectedSessionKey: SESSION_A,
                    selectedSessionKeyReference: { current: SESSION_A },
                    setDraft: jest.fn(),
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError: jest.fn(),
                    shouldStickToBottomReference: { current: true },
                    transport,
                })
            );

            await act(async () => result.current.handleSend());

            expect(transport.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    idempotencyKey: expect.stringMatching(/^dashboard-chat-[\da-z-]+$/u),
                })
            );
        } finally {
            Object.defineProperty(crypto, "randomUUID", {
                configurable: true,
                value: originalRandomUuid,
            });
        }
    });

    it("does not send a reset after confirmation returns for another session", async () => {
        const confirmation = Promise.withResolvers<boolean>();
        const confirmResetSession = jest.fn(() => confirmation.promise);
        const transport = fakeTransport();
        const selectedSessionKeyReference = { current: SESSION_A };
        const setMessages = jest.fn();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsReference: { current: [] },
                clearAttachments: jest.fn(),
                confirmResetSession,
                draft: "/reset",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime: fakeRuntime(),
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyReference,
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages,
                setSendError: jest.fn(),
                shouldStickToBottomReference: { current: true },
                transport,
            })
        );

        let sendPromise: Promise<void> | undefined;
        act(() => {
            sendPromise = result.current.handleSend();
        });
        await waitFor(() => expect(confirmResetSession).toHaveBeenCalledTimes(1));
        selectedSessionKeyReference.current = SESSION_B;
        await act(async () => {
            confirmation.resolve(true);
            await sendPromise;
        });

        expect(transport.send).not.toHaveBeenCalled();
        expect(setMessages).not.toHaveBeenCalled();
    });
});
