import { renderHook } from "@testing-library/react";
import { act, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveChatStreams } from "./chatRuntime";
import type { ChatHistoryMessage } from "./chatTypes";
import {
    compactStatusText,
    detailFromArgs,
    formatToolName,
    isNewRunForStream,
    isRuntimeWorkEvent,
    normalizeRuntimeStream,
    runtimeProgressText,
    stringValue,
    useChatRuntimeEvents,
} from "./useChatRuntimeEvents";

type ChatRequest = <T = unknown>(
    method: string,
    params?: Record<string, unknown>
) => Promise<T>;

function renderRuntimeEvents(
    overrides: {
        activeStreams?: ActiveChatStreams;
        clearInitialRequests?: boolean;
        connectionId?: number;
        isConnected?: boolean;
        request?: ReturnType<typeof vi.fn>;
        selectedSessionKey?: string;
        shouldStickToBottom?: boolean;
        showToolOutput?: boolean;
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

    const hook = renderHook(
        ({
            connectionId = overrides.connectionId ?? 1,
            isConnected = overrides.isConnected ?? true,
        }: {
            connectionId?: number;
            isConnected?: boolean;
        } = {}) => {
            const [activeStreams, setActiveStreams] = useState<ActiveChatStreams>(
                overrides.activeStreams ?? {}
            );
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
                connectionId,
                isConnected,
                liveHistoryRefreshTimerReference,
                request: request as unknown as ChatRequest,
                selectedSessionKey: overrides.selectedSessionKey ?? "session-a",
                setHistoryLoadVersion,
                setIsAtBottom,
                setMessages,
                setSendError,
                shouldStickToBottomReference,
                showThinkingOutput: false,
                showToolOutput: overrides.showToolOutput ?? false,
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
        }
    );

    if (overrides.clearInitialRequests !== false) {
        request.mockClear();
    }

    return {
        emit: (data: unknown) => listener?.(data),
        request,
        subscribe,
        unsubscribe,
        ...hook,
    };
}

describe("runtime event formatting helpers", () => {
    it("normalizes compact text, string values, tool names, args, and streams", () => {
        expect(compactStatusText(` ${"word ".repeat(40)} `)).toHaveLength(120);
        expect(compactStatusText(" short\ntext ")).toBe("short text");
        expect(stringValue(" value ")).toBe("value");
        expect(stringValue("   ")).toBeUndefined();
        expect(stringValue(123)).toBeUndefined();
        expect(formatToolName("functions.web_search-query")).toBe("Web search query");
        expect(formatToolName("   ")).toBe("");
        expect(detailFromArgs("raw detail")).toBe("raw detail");
        expect(detailFromArgs({ unused: "nope" })).toBeUndefined();
        expect(detailFromArgs({ message: " hello " })).toBe("hello");
        expect(normalizeRuntimeStream("command_output")).toBe("command-output");
        expect(normalizeRuntimeStream("tool")).toBe("tool");
    });

    it("formats all runtime progress fallbacks and non-work cases", () => {
        expect(runtimeProgressText("session.lifecycle", "lifecycle", "start", {})).toBe(
            "Thinking"
        );
        expect(
            runtimeProgressText("session.lifecycle", "lifecycle", "end", {})
        ).toBeUndefined();
        expect(
            runtimeProgressText("session.tool", "tool", "start", { name: "message" })
        ).toBeUndefined();
        expect(runtimeProgressText("session.tool", "tool", "start", {})).toBe("Tool");
        expect(runtimeProgressText("session.item", "item", "start", {})).toBeUndefined();
        expect(
            runtimeProgressText("session.item", "item", "start", { meta: "meta detail" })
        ).toBe("meta detail");
        expect(runtimeProgressText("session.plan", "plan", "start", {})).toBe(
            "Updating plan"
        );
        expect(runtimeProgressText("session.approval", "approval", "start", {})).toBe(
            "Waiting for approval"
        );
        expect(runtimeProgressText("session.patch", "patch", "start", {})).toBe(
            "Applying patch"
        );
        expect(
            runtimeProgressText("session.command", "command-output", "end", {
                exitCode: 0,
                name: "exec",
            })
        ).toBe("Exec: completed");
        expect(
            runtimeProgressText("session.command", "command-output", "end", {
                status: "running",
            })
        ).toBe("Exec: running");
        expect(
            runtimeProgressText("session.command", "command-output", "stdout", {})
        ).toBeUndefined();
        expect(
            runtimeProgressText("session.compaction", "compaction", "end", {})
        ).toBeUndefined();
        expect(runtimeProgressText("session.unknown", "unknown", "", {})).toBeUndefined();
    });

    it("detects stream run replacement and runtime work events", () => {
        expect(isNewRunForStream(undefined, "run-1")).toBe(false);
        expect(isNewRunForStream({ runId: "run-1" })).toBe(false);
        expect(isNewRunForStream({ runId: "run-1", aliases: ["run-2"] }, "run-2")).toBe(
            false
        );
        expect(isNewRunForStream({ runId: "run-1", aliases: [] }, "run-2")).toBe(true);

        expect(isRuntimeWorkEvent("session.tool", "", "")).toBe(true);
        expect(isRuntimeWorkEvent("session.lifecycle", "lifecycle", "start")).toBe(true);
        expect(isRuntimeWorkEvent("session.patch", "patch", "")).toBe(true);
        expect(isRuntimeWorkEvent("session.other", "other", "")).toBe(false);
        expect(isRuntimeWorkEvent("session.other", "other", "", "Working")).toBe(true);
    });
});

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

    it("subscribes to selected Gateway v4 transcript events", () => {
        const { request, unmount } = renderRuntimeEvents({
            clearInitialRequests: false,
        });

        expect(request).toHaveBeenCalledWith("sessions.messages.subscribe", {
            key: "session-a",
        });

        unmount();

        expect(request).toHaveBeenCalledWith("sessions.messages.unsubscribe", {
            key: "session-a",
        });
    });

    it("re-subscribes selected Gateway v4 transcript events after reconnect", () => {
        const { request, rerender } = renderRuntimeEvents({
            clearInitialRequests: false,
            connectionId: 1,
        });

        expect(request).toHaveBeenCalledWith("sessions.messages.subscribe", {
            key: "session-a",
        });

        request.mockClear();
        rerender({ connectionId: 2 });

        expect(request).toHaveBeenCalledWith("sessions.messages.unsubscribe", {
            key: "session-a",
        });
        expect(request).toHaveBeenCalledWith("sessions.messages.subscribe", {
            key: "session-a",
        });
    });

    it("does not subscribe selected Gateway v4 transcript events while disconnected", () => {
        const { request } = renderRuntimeEvents({
            clearInitialRequests: false,
            isConnected: false,
        });

        expect(request).not.toHaveBeenCalledWith("sessions.messages.subscribe", {
            key: "session-a",
        });
    });

    it("renders Gateway v4 tool events as ordered bubbles before history refresh", () => {
        const { emit, result } = renderRuntimeEvents({ showToolOutput: true });

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        args: { cmd: "status" },
                        id: "tool-1",
                        name: "functions.openclaw_status",
                        phase: "start",
                    },
                    runId: "run-tool",
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        expect(result.current.messages).toHaveLength(1);
        expect(result.current.messages[0]).toEqual(
            expect.objectContaining({
                local: true,
                role: "assistant",
                toolCalls: [
                    {
                        arguments: { cmd: "status" },
                        id: "tool-1",
                        name: "functions.openclaw_status",
                    },
                ],
            })
        );
        expect(result.current.activeStreams["session-a"]?.message).toBeUndefined();

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        id: "tool-1",
                        name: "functions.openclaw_status",
                        phase: "result",
                        result: { ok: true },
                    },
                    runId: "run-tool",
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        expect(result.current.messages).toHaveLength(2);
        expect(result.current.messages[1]).toEqual(
            expect.objectContaining({
                local: true,
                role: "tool",
                toolResult: expect.objectContaining({
                    content: '{\n  "ok": true\n}',
                    id: "tool-1",
                    name: "functions.openclaw_status",
                }),
            })
        );
    });

    it("renders Gateway v4 tool result display text variants", () => {
        const { emit, result } = renderRuntimeEvents({ showToolOutput: true });
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        act(() => {
            for (const [id, resultValue] of [
                ["string-result", "plain output"],
                ["array-result", [{ text: "array output" }]],
                ["empty-result", undefined],
                ["circular-result", circular],
            ] as const) {
                emit({
                    event: "session.tool",
                    payload: {
                        data: {
                            id,
                            name: "functions.openclaw_status",
                            phase: "result",
                            result: resultValue,
                        },
                        runId: "run-tool",
                        sessionKey: "session-a",
                        stream: "tool",
                    },
                    type: "event",
                });
            }
        });

        expect(result.current.messages.map((message) => message.text)).toEqual([
            "plain output",
            "array output",
            "",
            "[object Object]",
        ]);
    });

    it("ignores non-work Gateway v4 tool events", () => {
        const { emit, result } = renderRuntimeEvents({ showToolOutput: true });

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        id: "message-1",
                        name: "message",
                        phase: "result",
                        result: { deliveryStatus: "sent" },
                    },
                    runId: "run-tool",
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        expect(result.current.messages).toEqual([]);
    });

    it("ignores Gateway v4 user transcript message events", () => {
        const { emit, result } = renderRuntimeEvents();

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    message: {
                        content: "Ok har refreshet siden. Kan du prøve tests igjen",
                        role: "user",
                    },
                    runId: "run-user",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams).toEqual({});
        expect(result.current.messages).toEqual([]);
    });

    it("uses Gateway v4 deltaText replacements for live chat deltas", async () => {
        const { emit, result } = renderRuntimeEvents();

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "First",
                    runId: "run-v4",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("First");

        act(() => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "Replacement",
                    replace: true,
                    runId: "run-v4",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("Replacement");
    });

    it("drops queued Gateway v4 deltas when a replacement arrives before flush", async () => {
        const { emit, result } = renderRuntimeEvents();

        act(() => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "First",
                    runId: "run-v4",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            emit({
                event: "chat",
                payload: {
                    deltaText: "Replacement",
                    replace: true,
                    runId: "run-v4",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("Replacement");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("Replacement");
    });

    it("flushes queued chat deltas before applying Gateway v4 transcript messages", async () => {
        const { emit, result } = renderRuntimeEvents();

        act(() => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "Hel",
                    runId: "run-v4",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            emit({
                event: "session.message",
                payload: {
                    message: {
                        content: "Hello",
                        role: "assistant",
                    },
                    runId: "run-v4",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("Hello");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("Hello");
    });

    it("uses empty Gateway v4 transcript text and clears pure transcript status", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-v4"],
                    runId: "run-v4",
                    sessionKey: "session-a",
                    statusText: "Thinking",
                    text: "Previous text",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    message: {
                        content: "",
                        role: "assistant",
                    },
                    runId: "run-v4",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                statusText: undefined,
                text: "",
            })
        );
        expect(result.current.activeStreams["session-a"]?.message?.text).toBe("");
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

    it("skips chat terminal history refresh when not following the bottom", async () => {
        const { emit, request } = renderRuntimeEvents({
            shouldStickToBottom: false,
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Done", role: "assistant" },
                    runId: "run-done",
                    sessionKey: "session-a",
                    state: "final",
                },
                type: "event",
            });
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
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

    it("ignores malformed, empty, and irrelevant events", async () => {
        const { emit, request, result } = renderRuntimeEvents();

        await act(async () => {
            emit({ type: "log", event: "chat" });
            emit({ type: "event", event: "chat" });
            emit({ type: "event", event: "chat", payload: { state: "delta" } });
            emit({
                event: "session.tool",
                payload: {
                    data: { name: "exec", phase: "start" },
                    sessionKey: "session-b",
                    stream: "tool",
                },
                type: "event",
            });
            emit({ event: "session.tool", payload: null, type: "event" });
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(result.current.activeStreams).toEqual({});
        expect(result.current.messages).toEqual([]);
        expect(request).not.toHaveBeenCalled();
    });

    it("does not schedule runtime history refresh without a selected session", async () => {
        const { emit, request, result } = renderRuntimeEvents({ selectedSessionKey: "" });

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: { args: "npm test", name: "functions.exec", phase: "start" },
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(result.current.activeStreams).toEqual({});
        expect(request).not.toHaveBeenCalled();
    });

    it("replaces buffered stream text when a new run arrives", async () => {
        const { emit, result } = renderRuntimeEvents();

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Old" },
                    runId: "run-old",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
            emit({
                event: "chat",
                payload: {
                    message: { content: "New" },
                    runId: "run-new",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                aliases: expect.arrayContaining(["run-new"]),
                runId: "run-new",
                text: "New",
            })
        );
    });

    it("handles stream aliases for non-selected terminal events", async () => {
        const { emit, request, result } = renderRuntimeEvents({
            activeStreams: {
                "session-b": {
                    aliases: ["run-b"],
                    runId: "run-b",
                    sessionKey: "session-b",
                    text: "Buffered remote",
                    updatedAt: "2026-05-11T00:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Remote final", role: "assistant" },
                    runId: "run-b",
                    state: "final",
                },
                type: "event",
            });
        });

        expect(result.current.messages).toEqual([]);
        expect(result.current.activeStreams["session-b"]).toBeUndefined();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });

        expect(request).toHaveBeenCalledWith("chat.history", {
            limit: 1000,
            sessionKey: "session-b",
        });
        expect(result.current.historyLoadVersion).toBe(0);
    });

    it("keeps remote buffered aborts local to their stream and uses fallback errors", async () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-b": {
                    aliases: ["run-b"],
                    runId: "run-b",
                    sessionKey: "session-b",
                    text: "Remote partial",
                    updatedAt: "2026-05-11T00:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: { runId: "run-b", state: "aborted" },
                type: "event",
            });
            emit({
                event: "chat",
                payload: { runId: "run-b", state: "error" },
                type: "event",
            });
            emit({
                event: "chat",
                payload: {
                    runId: "run-local",
                    sessionKey: "session-a",
                    state: "error",
                },
                type: "event",
            });
        });

        expect(result.current.messages).toEqual([]);
        expect(result.current.sendError).toBe("Chat request failed");
    });

    it("handles runtime aliases, refresh failures, and command final messages", async () => {
        const request = vi.fn().mockRejectedValue(new Error("history offline"));
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-alias"],
                    runId: "run-alias",
                    sessionKey: "session-a",
                    text: "",
                    updatedAt: "2026-05-11T00:00:00.000Z",
                },
            },
            request,
        });

        act(() => {
            emit({
                event: "session.item",
                payload: {
                    data: { itemKind: "note", summary: "Alias progress" },
                    runId: "run-alias",
                    stream: "item",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.statusText).toBe(
            "Note: Alias progress"
        );

        act(() => {
            emit({
                event: "chat",
                payload: {
                    message: { command: true, content: "Command finished" },
                    runId: "run-alias",
                    sessionKey: "session-a",
                    state: "final",
                },
                type: "event",
            });
        });

        expect(result.current.messages.at(-1)).toEqual(
            expect.objectContaining({
                local: true,
                role: "system",
                text: "Command finished",
            })
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });

        expect(request).toHaveBeenCalledWith("chat.history", {
            limit: 1000,
            sessionKey: "session-a",
        });
        expect(result.current.historyLoadVersion).toBe(0);
    });

    it("uses buffered text when final payload is hidden by diagnostic visibility", async () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-thinking"],
                    runId: "run-thinking",
                    sessionKey: "session-a",
                    text: "Buffered visible fallback",
                    updatedAt: "2026-05-11T00:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    message: {
                        content: "",
                        role: "assistant",
                        text: "",
                        thinking: [{ text: "hidden thinking" }],
                    },
                    runId: "run-thinking",
                    sessionKey: "session-a",
                    state: "final",
                },
                type: "event",
            });
        });

        expect(result.current.messages.at(-1)).toEqual(
            expect.objectContaining({
                role: "assistant",
                text: "Buffered visible fallback",
            })
        );
        expect(result.current.activeStreams["session-a"]).toBeUndefined();
    });

    it("clears pending timers on unmount", async () => {
        const { emit, unmount, unsubscribe } = renderRuntimeEvents();

        act(() => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Pending" },
                    runId: "run-pending",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
        });

        unmount();
        expect(unsubscribe).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });
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
