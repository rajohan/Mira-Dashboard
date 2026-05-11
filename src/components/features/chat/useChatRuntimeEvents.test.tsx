import { renderHook } from "@testing-library/react";
import { act, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveChatStreams } from "./chatRuntime";
import type { ChatHistoryMessage } from "./chatTypes";
import { useChatRuntimeEvents } from "./useChatRuntimeEvents";

type ChatRequest = <T = unknown>(
    method: string,
    params?: Record<string, unknown>
) => Promise<T>;

function renderRuntimeEvents(
    overrides: {
        request?: ReturnType<typeof vi.fn>;
        selectedSessionKey?: string;
        shouldStickToBottom?: boolean;
    } = {}
) {
    let listener: ((data: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((nextListener: (data: unknown) => void) => {
        listener = nextListener;
        return unsubscribe;
    });
    const request =
        overrides.request ||
        vi.fn().mockResolvedValue({
            messages: [
                {
                    content: "history message",
                    role: "assistant",
                    text: "history message",
                },
            ],
        });

    const hook = renderHook(() => {
        const [activeStreams, setActiveStreams] = useState<ActiveChatStreams>({});
        const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
        const [sendError, setSendError] = useState<string | null>(null);
        const [isAtBottom, setIsAtBottom] = useState(false);
        const [historyLoadVersion, setHistoryLoadVersion] = useState(0);
        const activeStreamsReference = useRef(activeStreams);
        const liveHistoryRefreshTimerReference = useRef<number | null>(null);
        const shouldStickToBottomReference = useRef(
            overrides.shouldStickToBottom ?? true
        );
        activeStreamsReference.current = activeStreams;

        const updateActiveStreams = (
            updater: (previous: ActiveChatStreams) => ActiveChatStreams
        ) => {
            setActiveStreams((previous) => {
                const next = updater(previous);
                activeStreamsReference.current = next;
                return next;
            });
        };

        useChatRuntimeEvents({
            activeStreamsReference,
            liveHistoryRefreshTimerReference,
            request: request as unknown as ChatRequest,
            selectedSessionKey: overrides.selectedSessionKey ?? "session-a",
            setHistoryLoadVersion,
            setIsAtBottom,
            setMessages,
            setSendError,
            shouldStickToBottomReference,
            showThinkingOutput: false,
            showToolOutput: false,
            subscribe,
            updateActiveStreams,
        });

        return {
            activeStreams,
            historyLoadVersion,
            isAtBottom,
            messages,
            sendError,
        };
    });

    return {
        emit: (data: unknown) => listener?.(data),
        request,
        subscribe,
        unsubscribe,
        ...hook,
    };
}

describe("useChatRuntimeEvents", () => {
    beforeEach(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("buffers delta events, appends final messages, and refreshes history", async () => {
        const { emit, request, result } = renderRuntimeEvents();

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Hello" },
                    runId: "run-1",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                aliases: expect.arrayContaining(["run-1"]),
                runId: "run-1",
                text: "Hello",
            })
        );

        act(() => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Done", role: "assistant" },
                    runId: "run-1",
                    sessionKey: "session-a",
                    state: "final",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toBeUndefined();
        expect(result.current.messages.map((message) => message.text)).toContain("Done");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });

        expect(request).toHaveBeenCalledWith("chat.history", {
            limit: 1000,
            sessionKey: "session-a",
        });
        expect(result.current.historyLoadVersion).toBe(1);
        expect(result.current.isAtBottom).toBe(true);
        expect(result.current.messages.map((message) => message.text)).toContain(
            "history message"
        );
    });

    it("tracks runtime work events and clears them on terminal lifecycle", async () => {
        const { emit, request, result } = renderRuntimeEvents();

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "npm test" },
                        name: "functions.exec",
                        phase: "start",
                    },
                    runId: "run-tool",
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                runId: "run-tool",
                statusText: "Exec: npm test",
            })
        );

        act(() => {
            emit({
                event: "session.lifecycle",
                payload: {
                    data: { phase: "end" },
                    runId: "run-tool",
                    sessionKey: "session-a",
                    stream: "lifecycle",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toBeUndefined();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });

        expect(request).toHaveBeenCalledWith("chat.history", {
            limit: 1000,
            sessionKey: "session-a",
        });
    });

    it("formats OpenClaw runtime transcript progress events", () => {
        const { emit, result } = renderRuntimeEvents();

        const emitRuntimeEvent = (
            stream: string,
            data: Record<string, unknown>,
            runId: string
        ) => {
            act(() => {
                emit({
                    event: `session.${stream}`,
                    payload: {
                        data,
                        runId,
                        sessionKey: "session-a",
                        stream,
                    },
                    type: "event",
                });
            });
        };

        emitRuntimeEvent("lifecycle", { phase: "start" }, "run-lifecycle");
        expect(result.current.activeStreams["session-a"]?.statusText).toBe("Thinking");

        emitRuntimeEvent(
            "item",
            { itemKind: "task_update", summary: "Checking status" },
            "run-item"
        );
        expect(result.current.activeStreams["session-a"]?.statusText).toBe(
            "Task update: Checking status"
        );

        emitRuntimeEvent("plan", { explanation: "Updating next steps" }, "run-plan");
        expect(result.current.activeStreams["session-a"]?.statusText).toBe(
            "Updating next steps"
        );

        emitRuntimeEvent("approval", { command: "npm run build" }, "run-approval");
        expect(result.current.activeStreams["session-a"]?.statusText).toBe(
            "npm run build"
        );

        emitRuntimeEvent("patch", { summary: "Applying test fixes" }, "run-patch");
        expect(result.current.activeStreams["session-a"]?.statusText).toBe(
            "Applying test fixes"
        );

        emitRuntimeEvent(
            "command_output",
            { exitCode: 1, name: "functions.exec", phase: "end", title: "npm test" },
            "run-command"
        );
        expect(result.current.activeStreams["session-a"]?.statusText).toBe(
            "Exec: exit 1: npm test"
        );

        emitRuntimeEvent("compaction", { phase: "start" }, "run-compaction");
        expect(result.current.activeStreams["session-a"]?.statusText).toBe(
            "Compacting context"
        );
    });

    it("skips non-terminal command output and history refresh when not at bottom", async () => {
        const { emit, request, result } = renderRuntimeEvents({
            shouldStickToBottom: false,
        });

        act(() => {
            emit({
                event: "session.command_output",
                payload: {
                    data: { phase: "stdout", title: "still running" },
                    runId: "run-output",
                    sessionKey: "session-a",
                    stream: "command_output",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams).toEqual({});

        act(() => {
            emit({
                event: "session.lifecycle",
                payload: {
                    data: { phase: "end" },
                    runId: "run-output",
                    sessionKey: "session-a",
                    stream: "lifecycle",
                },
                type: "event",
            });
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });

        expect(request).not.toHaveBeenCalled();
    });

    it("appends aborted buffered text and surfaces chat errors", async () => {
        const { emit, result } = renderRuntimeEvents();

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Partial" },
                    runId: "run-2",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
            emit({
                event: "chat",
                payload: {
                    runId: "run-2",
                    sessionKey: "session-a",
                    state: "aborted",
                },
                type: "event",
            });
        });

        expect(result.current.messages.map((message) => message.text)).toContain(
            "Partial"
        );
        expect(result.current.activeStreams["session-a"]).toBeUndefined();

        act(() => {
            emit({
                event: "chat",
                payload: {
                    errorMessage: "boom",
                    runId: "run-3",
                    sessionKey: "session-a",
                    state: "error",
                },
                type: "event",
            });
        });

        expect(result.current.sendError).toBe("boom");
    });

    it("unsubscribes and ignores events for other sessions", async () => {
        const { emit, result, unmount, unsubscribe } = renderRuntimeEvents();

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Other" },
                    runId: "run-other",
                    sessionKey: "session-b",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams).toEqual({});

        unmount();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
