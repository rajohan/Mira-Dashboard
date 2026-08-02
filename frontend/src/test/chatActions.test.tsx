import { describe, expect, it, jest } from "bun:test";

import { act, renderHook, waitFor } from "@testing-library/react";
import { type SetStateAction, useState } from "react";

import { OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION } from "../../../contracts/chat/transport";
import type { Session } from "../../../contracts/sessions";
import {
    type ChatHistoryMessage,
    type ChatSendAttachment,
} from "../components/features/chat/chatTypes";
import { createChatRuntimeState } from "../components/features/chat/domain/chatState";
import {
    type ChatRuntimeSnapshot,
    type ChatTransport,
} from "../components/features/chat/transport/chatTransport";
import { useChatActions } from "../components/features/chat/useChatActions";
import { type ChatRuntimeController } from "../components/features/chat/useChatRuntime";
import { SecurityVerificationCancelledError } from "../lib/securityVerification";

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

function defaultSend() {
    return Promise.try(() => {
        return { runId: "run-1" };
    });
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
        history: jest.fn(() => Promise.try(() => [])),
        isConnected: true,
        models: jest.fn(() => Promise.try(() => [])),
        patchSession: jest.fn(async () => {}),
        send,
        snapshot: jest.fn(() =>
            Promise.resolve<ChatRuntimeSnapshot>({
                completed: false,
                events: [],
                schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
                throughSequence: 0,
            })
        ),
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
        const selectedSessionKeyRef = { current: SESSION_A };
        let messages: ChatHistoryMessage[] = [];
        const setMessages = jest.fn((update: SetStateAction<ChatHistoryMessage[]>) => {
            messages = typeof update === "function" ? update(messages) : update;
        });
        const { result, rerender } = renderHook(
            ({ activeRunCount, draft, isCompacting }) =>
                useChatActions({
                    activeRunCount,
                    attachments: [],
                    attachmentsRef: { current: [] },
                    clearAttachments: jest.fn(() => 1),
                    confirmResetSession: jest.fn(() => Promise.try(() => true)),
                    draft,
                    isCompacting,
                    isConnected: true,
                    isRecording: false,
                    isTranscribing: false,
                    runtime,
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: selectedSession(),
                    selectedSessionKey: SESSION_A,
                    selectedSessionKeyRef: selectedSessionKeyRef,
                    setDraft: jest.fn(),
                    setIsAtBottom: jest.fn(),
                    setMessages,
                    setSendError: jest.fn(),
                    shouldStickToBottomRef: { current: true },
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

        rerender({ activeRunCount: 1, draft: "steer", isCompacting: false });
        expect(result.current.canSend).toBe(true);
        expect(result.current.preferenceControlsDisabled).toBe(false);
        expect(result.current.compactDisabled).toBe(true);

        let secondSend: Promise<void> | undefined;
        act(() => {
            secondSend = result.current.handleSend();
        });
        await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(2));
        expect(
            (transport.send as ReturnType<typeof jest.fn>).mock.calls[1]?.[0]
        ).not.toHaveProperty("queueMode");
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

        rerender({ activeRunCount: 1, draft: "blocked", isCompacting: true });
        expect(result.current.canSend).toBe(false);
        await act(async () => result.current.handleSend());
        expect(transport.send).toHaveBeenCalledTimes(2);
        expect(result.current.preferenceControlsDisabled).toBe(false);

        await act(async () => {
            sendDeferred.resolve({ runId: "run-1" });
            await Promise.all([firstSend, secondSend]);
        });
    });

    it("blocks duplicate live-steer submissions from the same input revision", async () => {
        const sendDeferred = Promise.withResolvers<{ runId?: string }>();
        const transport = fakeTransport(jest.fn(() => sendDeferred.promise));
        const runtime = fakeRuntime();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 1,
                attachments: [],
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 1),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft: "steer once",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: { current: SESSION_A },
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError: jest.fn(),
                shouldStickToBottomRef: { current: true },
                transport,
            })
        );

        let firstSend: Promise<void> | undefined;
        let duplicateSend: Promise<void> | undefined;
        act(() => {
            firstSend = result.current.handleSend();
            duplicateSend = result.current.handleSend();
        });

        await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
        expect(runtime.beginRun).toHaveBeenCalledTimes(1);

        await act(async () => {
            sendDeferred.resolve({ runId: "active-run" });
            await Promise.all([firstSend, duplicateSend]);
        });
    });

    it("restores the composer draft when delivery does not complete", async () => {
        const transport = fakeTransport(
            jest.fn(() => {
                return Promise.try(() => {
                    throw new Error("verification cancelled");
                });
            })
        );
        const attachments: ChatSendAttachment[] = [
            {
                contentBase64: "c2F2ZSBtZQ==",
                dataUrl: "data:text/plain;base64,c2F2ZSBtZQ==",
                file: new File(["save me"], "save-me.txt", {
                    type: "text/plain",
                }),
                fileName: "save-me.txt",
                id: "save-me",
                kind: "text",
                mimeType: "text/plain",
                sizeBytes: 7,
            },
        ];
        const restoreAttachments = jest.fn(() => true);
        let draftState = "message that must survive";
        const setDraft = jest.fn((update: SetStateAction<string>) => {
            draftState = typeof update === "function" ? update(draftState) : update;
        });
        let messages: ChatHistoryMessage[] = [];
        const setMessages = jest.fn((update: SetStateAction<ChatHistoryMessage[]>) => {
            messages = typeof update === "function" ? update(messages) : update;
        });
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments,
                attachmentsRef: { current: attachments },
                clearAttachments: jest.fn(() => 17),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft: draftState,
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                restoreAttachments,
                runtime: fakeRuntime(),
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: { current: SESSION_A },
                setDraft,
                setIsAtBottom: jest.fn(),
                setMessages,
                setSendError: jest.fn(),
                shouldStickToBottomRef: { current: true },
                transport,
            })
        );

        await act(async () => result.current.handleSend());

        expect(draftState).toBe("message that must survive");
        expect(messages).toEqual([]);
        expect(restoreAttachments).toHaveBeenCalledWith(attachments, 17);
    });

    it("aborts delivery when preliminary diagnostics verification is cancelled", async () => {
        const verificationCancellation = new SecurityVerificationCancelledError(
            "step_up_required"
        );
        const transport = fakeTransport();
        transport.patchSession = jest.fn(() => {
            return Promise.try(() => {
                throw verificationCancellation;
            });
        });
        const runtime = fakeRuntime();
        let messages: ChatHistoryMessage[] = [];
        const setMessages = jest.fn((update: SetStateAction<ChatHistoryMessage[]>) => {
            messages = typeof update === "function" ? update(messages) : update;
        });
        const { result } = renderHook(() => {
            const [draft, setDraft] = useState(
                "message that must not reopen verification"
            );
            const actions = useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 31),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft,
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                restoreAttachments: jest.fn(() => true),
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: {
                    ...selectedSession(),
                    verboseLevel: "compact",
                },
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: { current: SESSION_A },
                setDraft,
                setIsAtBottom: jest.fn(),
                setMessages,
                setSendError: jest.fn(),
                shouldStickToBottomRef: { current: true },
                transport,
            });
            return { ...actions, draft };
        });

        await act(async () => result.current.handleSend());

        expect(transport.patchSession).toHaveBeenCalledTimes(1);
        expect(transport.send).not.toHaveBeenCalled();
        expect(result.current.draft).toBe("message that must not reopen verification");
        expect(messages).toEqual([]);
        expect(runtime.failRun).toHaveBeenCalledTimes(1);
    });

    it("does not restore failed attachments into a newer draft", async () => {
        const sendDeferred = Promise.withResolvers<{ runId?: string }>();
        const transport = fakeTransport(jest.fn(() => sendDeferred.promise));
        const attachments: ChatSendAttachment[] = [
            {
                contentBase64: "b2xkIGF0dGFjaG1lbnQ=",
                dataUrl: "data:text/plain;base64,b2xkIGF0dGFjaG1lbnQ=",
                file: new File(["old attachment"], "old.txt", {
                    type: "text/plain",
                }),
                fileName: "old.txt",
                id: "old-attachment",
                kind: "text",
                mimeType: "text/plain",
                sizeBytes: 14,
            },
        ];
        const restoreAttachments = jest.fn(() => true);
        const { result } = renderHook(() => {
            const [draft, setDraft] = useState("old message");
            return {
                ...useChatActions({
                    activeRunCount: 0,
                    attachments,
                    attachmentsRef: { current: attachments },
                    clearAttachments: jest.fn(() => 23),
                    confirmResetSession: jest.fn(() => Promise.try(() => true)),
                    draft,
                    isCompacting: false,
                    isConnected: true,
                    isRecording: false,
                    isTranscribing: false,
                    restoreAttachments,
                    runtime: fakeRuntime(),
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: selectedSession(),
                    selectedSessionKey: SESSION_A,
                    selectedSessionKeyRef: { current: SESSION_A },
                    setDraft,
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError: jest.fn(),
                    shouldStickToBottomRef: { current: true },
                    transport,
                }),
                draft,
                setDraft,
            };
        });

        let sendPromise: Promise<void> | undefined;
        act(() => {
            sendPromise = result.current.handleSend();
        });
        await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
        act(() => {
            result.current.setDraft("new message");
        });

        await act(async () => {
            sendDeferred.reject(new Error("retry failed"));
            await sendPromise;
        });

        expect(result.current.draft).toBe("new message");
        expect(restoreAttachments).not.toHaveBeenCalled();
    });

    it("does not restore a failed draft after a transient composer edit", async () => {
        const sendDeferred = Promise.withResolvers<{ runId?: string }>();
        const transport = fakeTransport(jest.fn(() => sendDeferred.promise));
        const restoreAttachments = jest.fn(() => true);
        const { result } = renderHook(() => {
            const [draft, setDraft] = useState("old message");
            return {
                ...useChatActions({
                    activeRunCount: 0,
                    attachments: [],
                    attachmentsRef: { current: [] },
                    clearAttachments: jest.fn(() => 41),
                    confirmResetSession: jest.fn(() => Promise.try(() => true)),
                    draft,
                    isCompacting: false,
                    isConnected: true,
                    isRecording: false,
                    isTranscribing: false,
                    restoreAttachments,
                    runtime: fakeRuntime(),
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: selectedSession(),
                    selectedSessionKey: SESSION_A,
                    selectedSessionKeyRef: { current: SESSION_A },
                    setDraft,
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError: jest.fn(),
                    shouldStickToBottomRef: { current: true },
                    transport,
                }),
                draft,
                setDraft,
            };
        });

        let sendPromise: Promise<void> | undefined;
        act(() => {
            sendPromise = result.current.handleSend();
        });
        await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
        act(() => {
            result.current.setDraft("temporary replacement");
        });
        act(() => {
            result.current.setDraft("");
        });

        await act(async () => {
            sendDeferred.reject(new Error("retry failed"));
            await sendPromise;
        });

        expect(result.current.draft).toBe("");
        expect(restoreAttachments).not.toHaveBeenCalled();
    });

    it("does not restore a failed draft after attachment state changes", async () => {
        const sendDeferred = Promise.withResolvers<{ runId?: string }>();
        const transport = fakeTransport(jest.fn(() => sendDeferred.promise));
        const restoreAttachments = jest.fn(() => false);
        const { result } = renderHook(() => {
            const [draft, setDraft] = useState("old message");
            return {
                ...useChatActions({
                    activeRunCount: 0,
                    attachments: [],
                    attachmentsRef: { current: [] },
                    clearAttachments: jest.fn(() => 29),
                    confirmResetSession: jest.fn(() => Promise.try(() => true)),
                    draft,
                    isCompacting: false,
                    isConnected: true,
                    isRecording: false,
                    isTranscribing: false,
                    restoreAttachments,
                    runtime: fakeRuntime(),
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: selectedSession(),
                    selectedSessionKey: SESSION_A,
                    selectedSessionKeyRef: { current: SESSION_A },
                    setDraft,
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError: jest.fn(),
                    shouldStickToBottomRef: { current: true },
                    transport,
                }),
                draft,
            };
        });

        let sendPromise: Promise<void> | undefined;
        act(() => {
            sendPromise = result.current.handleSend();
        });
        await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));

        await act(async () => {
            sendDeferred.reject(new Error("retry failed"));
            await sendPromise;
        });

        expect(restoreAttachments).toHaveBeenCalledWith([], 29);
        expect(result.current.draft).toBe("");
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
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 1),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft: "queued message",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: { current: SESSION_A },
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError: jest.fn(),
                shouldStickToBottomRef: { current: true },
                transport,
            })
        );

        let compactPromise: Promise<void> | undefined;
        let duplicateCompactPromise: Promise<void> | undefined;
        act(() => {
            compactPromise = result.current.compactSelectedSession();
            duplicateCompactPromise = result.current.compactSelectedSession();
        });
        await waitFor(() => expect(transport.compact).toHaveBeenCalledWith(SESSION_A));
        expect(transport.compact).toHaveBeenCalledTimes(1);
        expect(result.current.isCompactingSession).toBe(true);
        expect(result.current.canSend).toBe(false);
        expect(result.current.compactDisabled).toBe(true);
        expect(runtime.beginRun).not.toHaveBeenCalled();
        await act(async () => result.current.handleSend());
        expect(transport.send).not.toHaveBeenCalled();

        await act(async () => {
            compactDeferred.resolve();
            await Promise.all([compactPromise, duplicateCompactPromise]);
        });
        expect(result.current.isCompactingSession).toBe(false);
        expect(result.current.canSend).toBe(true);
    });

    it("preserves an in-flight compaction lock across a reconnect", async () => {
        const compactDeferred = Promise.withResolvers<void>();
        const transport = fakeTransport();
        transport.compact = jest.fn(() => compactDeferred.promise);
        const { result, rerender } = renderHook(
            ({ isConnected }) =>
                useChatActions({
                    activeRunCount: 0,
                    attachments: [],
                    attachmentsRef: { current: [] },
                    clearAttachments: jest.fn(() => 1),
                    confirmResetSession: jest.fn(() => Promise.try(() => true)),
                    draft: "queued message",
                    isCompacting: false,
                    isConnected,
                    isRecording: false,
                    isTranscribing: false,
                    runtime: fakeRuntime(),
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: selectedSession(),
                    selectedSessionKey: SESSION_A,
                    selectedSessionKeyRef: { current: SESSION_A },
                    setDraft: jest.fn(),
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError: jest.fn(),
                    shouldStickToBottomRef: { current: true },
                    transport,
                }),
            { initialProps: { isConnected: true } }
        );

        let compactPromise: Promise<void> | undefined;
        act(() => {
            compactPromise = result.current.compactSelectedSession();
        });
        await waitFor(() => expect(transport.compact).toHaveBeenCalledTimes(1));

        rerender({ isConnected: false });
        rerender({ isConnected: true });
        expect(result.current.isCompactingSession).toBe(true);
        expect(result.current.compactDisabled).toBe(true);

        act(() => {
            void result.current.compactSelectedSession();
        });
        expect(transport.compact).toHaveBeenCalledTimes(1);

        await act(async () => {
            compactDeferred.resolve();
            await compactPromise;
        });
        expect(result.current.isCompactingSession).toBe(false);
        expect(result.current.compactDisabled).toBe(false);
    });

    it("re-enables sending after a compaction request fails", async () => {
        const compactDeferred = Promise.withResolvers<void>();
        const transport = fakeTransport();
        transport.compact = jest.fn(() => compactDeferred.promise);
        const setSendError = jest.fn();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 1),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft: "send after failure",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime: fakeRuntime(),
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: { current: SESSION_A },
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError,
                shouldStickToBottomRef: { current: true },
                transport,
            })
        );

        let compactPromise: Promise<void> | undefined;
        act(() => {
            compactPromise = result.current.compactSelectedSession();
        });
        await waitFor(() => expect(result.current.canSend).toBe(false));
        await act(async () => {
            compactDeferred.reject(new Error("compaction unavailable"));
            await compactPromise;
        });

        expect(setSendError).toHaveBeenCalledWith("compaction unavailable");
        expect(result.current.isCompactingSession).toBe(false);
        expect(result.current.canSend).toBe(true);
        await act(async () => result.current.handleSend());
        expect(transport.send).toHaveBeenCalledTimes(1);
    });

    it("tracks concurrent compaction requests per session", async () => {
        const compactA = Promise.withResolvers<void>();
        const compactB = Promise.withResolvers<void>();
        const transport = fakeTransport();
        transport.compact = jest.fn(
            (sessionKey) => (sessionKey === SESSION_A ? compactA : compactB).promise
        );
        const selectedSessionKeyRef = { current: SESSION_A };
        const { result, rerender } = renderHook(
            ({ sessionKey }) =>
                useChatActions({
                    activeRunCount: 0,
                    attachments: [],
                    attachmentsRef: { current: [] },
                    clearAttachments: jest.fn(() => 1),
                    confirmResetSession: jest.fn(() => Promise.try(() => true)),
                    draft: "queued message",
                    isCompacting: false,
                    isConnected: true,
                    isRecording: false,
                    isTranscribing: false,
                    runtime: fakeRuntime(),
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: { ...selectedSession(), key: sessionKey },
                    selectedSessionKey: sessionKey,
                    selectedSessionKeyRef: selectedSessionKeyRef,
                    setDraft: jest.fn(),
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError: jest.fn(),
                    shouldStickToBottomRef: { current: true },
                    transport,
                }),
            { initialProps: { sessionKey: SESSION_A } }
        );

        let firstRequest: Promise<void> | undefined;
        act(() => {
            firstRequest = result.current.compactSelectedSession();
        });
        await waitFor(() => expect(transport.compact).toHaveBeenCalledWith(SESSION_A));

        selectedSessionKeyRef.current = SESSION_B;
        rerender({ sessionKey: SESSION_B });
        expect(result.current.isCompactingSession).toBe(false);
        let secondRequest: Promise<void> | undefined;
        act(() => {
            secondRequest = result.current.compactSelectedSession();
        });
        await waitFor(() => expect(transport.compact).toHaveBeenCalledWith(SESSION_B));

        selectedSessionKeyRef.current = SESSION_A;
        rerender({ sessionKey: SESSION_A });
        expect(result.current.isCompactingSession).toBe(true);
        expect(result.current.canSend).toBe(false);

        await act(async () => {
            compactB.resolve();
            await secondRequest;
        });
        expect(result.current.isCompactingSession).toBe(true);

        await act(async () => {
            compactA.resolve();
            await firstRequest;
        });
        expect(result.current.isCompactingSession).toBe(false);
        expect(result.current.canSend).toBe(true);
    });

    it("clears a steer placeholder when the provider omits its run id", async () => {
        const transport = fakeTransport(jest.fn(() => Promise.try(() => ({}))));
        const runtime = fakeRuntime();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 1,
                attachments: [],
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 1),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft: "steer",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: { current: SESSION_A },
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError: jest.fn(),
                shouldStickToBottomRef: { current: true },
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

    it("uses active session metadata for a runless steer acknowledgement", async () => {
        const transport = fakeTransport(jest.fn(() => Promise.try(() => ({}))));
        const runtime = fakeRuntime();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 1),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft: "steer after reconnect",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: { ...selectedSession(), hasActiveRun: true },
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: { current: SESSION_A },
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError: jest.fn(),
                shouldStickToBottomRef: { current: true },
                transport,
            })
        );

        await act(async () => result.current.handleSend());

        const optimisticRunId = (runtime.beginRun as ReturnType<typeof jest.fn>).mock
            .calls[0]?.[1] as string;
        expect(runtime.beginRun).toHaveBeenCalledWith(SESSION_A, optimisticRunId, {
            replaceStatusOnlyRuns: false,
        });
        expect(runtime.clearRun).toHaveBeenCalledWith(SESSION_A, optimisticRunId);
        expect(runtime.acknowledgeRun).not.toHaveBeenCalled();
    });

    it("keeps a new-turn placeholder when the provider omits its run id", async () => {
        const transport = fakeTransport(jest.fn(() => Promise.try(() => ({}))));
        const runtime = fakeRuntime();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 1),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft: "new turn",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: { current: SESSION_A },
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages: jest.fn(),
                setSendError: jest.fn(),
                shouldStickToBottomRef: { current: true },
                transport,
            })
        );

        await act(async () => result.current.handleSend());

        const optimisticRunId = (runtime.beginRun as ReturnType<typeof jest.fn>).mock
            .calls[0]?.[1] as string;
        expect(runtime.acknowledgeRun).toHaveBeenCalledWith(SESSION_A, optimisticRunId);
        expect(runtime.clearRun).not.toHaveBeenCalled();
    });

    it("keeps failed sends scoped to their initiating session", async () => {
        const sendDeferred = Promise.withResolvers<{ runId?: string }>();
        const transport = fakeTransport(jest.fn(() => sendDeferred.promise));
        const runtime = fakeRuntime();
        const selectedSessionKeyRef = { current: SESSION_A };
        let messages: ChatHistoryMessage[] = [];
        const setMessages = jest.fn((update: SetStateAction<ChatHistoryMessage[]>) => {
            messages = typeof update === "function" ? update(messages) : update;
        });
        const setSendError = jest.fn();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 1),
                confirmResetSession: jest.fn(() => Promise.try(() => true)),
                draft: "hello",
                isCompacting: false,
                isConnected: true,
                isRecording: false,
                isTranscribing: false,
                runtime,
                scheduleBottomFollow: jest.fn(),
                selectedSession: selectedSession(),
                selectedSessionKey: SESSION_A,
                selectedSessionKeyRef: selectedSessionKeyRef,
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages,
                setSendError,
                shouldStickToBottomRef: { current: true },
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

        selectedSessionKeyRef.current = SESSION_B;
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
        const originalDescriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
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
                    attachmentsRef: { current: [] },
                    clearAttachments: jest.fn(() => 1),
                    confirmResetSession: jest.fn(() => Promise.try(() => true)),
                    draft: "fallback id",
                    isCompacting: false,
                    isConnected: true,
                    isRecording: false,
                    isTranscribing: false,
                    runtime: fakeRuntime(),
                    scheduleBottomFollow: jest.fn(),
                    selectedSession: selectedSession(),
                    selectedSessionKey: SESSION_A,
                    selectedSessionKeyRef: { current: SESSION_A },
                    setDraft: jest.fn(),
                    setIsAtBottom: jest.fn(),
                    setMessages: jest.fn(),
                    setSendError: jest.fn(),
                    shouldStickToBottomRef: { current: true },
                    transport,
                })
            );

            await act(async () => result.current.handleSend());

            expect(transport.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    idempotencyKey: expect.stringMatching(DASHBOARD_CHAT_RUN_ID),
                })
            );
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(crypto, "randomUUID", originalDescriptor);
            } else {
                Reflect.deleteProperty(crypto, "randomUUID");
            }
        }
    });

    it("does not send a reset after confirmation returns for another session", async () => {
        const confirmation = Promise.withResolvers<boolean>();
        const confirmResetSession = jest.fn(() => confirmation.promise);
        const transport = fakeTransport();
        const selectedSessionKeyRef = { current: SESSION_A };
        const setMessages = jest.fn();
        const { result } = renderHook(() =>
            useChatActions({
                activeRunCount: 0,
                attachments: [],
                attachmentsRef: { current: [] },
                clearAttachments: jest.fn(() => 1),
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
                selectedSessionKeyRef: selectedSessionKeyRef,
                setDraft: jest.fn(),
                setIsAtBottom: jest.fn(),
                setMessages,
                setSendError: jest.fn(),
                shouldStickToBottomRef: { current: true },
                transport,
            })
        );

        let sendPromise: Promise<void> | undefined;
        act(() => {
            sendPromise = result.current.handleSend();
        });
        await waitFor(() => expect(confirmResetSession).toHaveBeenCalledTimes(1));
        selectedSessionKeyRef.current = SESSION_B;
        await act(async () => {
            confirmation.resolve(true);
            await sendPromise;
        });

        expect(transport.send).not.toHaveBeenCalled();
        expect(setMessages).not.toHaveBeenCalled();
    });
});
