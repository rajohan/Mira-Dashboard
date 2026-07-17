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

function fakeRuntime(): ChatRuntimeController {
    return {
        acknowledgeRun: jest.fn(),
        beginRun: jest.fn(),
        clearRun: jest.fn(),
        clearSession: jest.fn(),
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

        expect(runtime.clearRun).toHaveBeenCalledWith(
            SESSION_A,
            expect.stringMatching(/^dashboard-chat-/u)
        );
        expect(setMessages).toHaveBeenCalledTimes(1);
        expect(messages).toHaveLength(1);
        expect(setSendError).not.toHaveBeenCalledWith("delivery failed");
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
