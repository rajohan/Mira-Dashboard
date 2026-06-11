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

/** Renders the runtime event hook with controllable Gateway event input. */
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
            selectedSessionKey,
        }: {
            connectionId?: number;
            isConnected?: boolean;
            selectedSessionKey?: string;
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
                selectedSessionKey:
                    selectedSessionKey ?? overrides.selectedSessionKey ?? "session-a",
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
        expect(stringValue(" ".repeat(3))).toBeUndefined();
        expect(stringValue(123)).toBeUndefined();
        expect(formatToolName("functions.web_search-query")).toBe("Web search query");
        expect(formatToolName(" ".repeat(3))).toBe("");
        expect(detailFromArgs("raw detail")).toBe("raw detail");
        expect(detailFromArgs({ unused: "nope" })).toBeUndefined();
        expect(detailFromArgs({ message: " hello " })).toBe("hello");
        expect(normalizeRuntimeStream(null)).toBe("");
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
        expect(
            runtimeProgressText("session.tool", "tool", "start", {
                toolName: "functions.message",
            })
        ).toBeUndefined();
        expect(
            runtimeProgressText("session.tool", "tool", "start", {
                args: { command: "date" },
                toolName: "functions.exec",
            })
        ).toBe("Exec: date");
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

        expect(isRuntimeWorkEvent("session.tool", "", "")).toBe(false);
        expect(isRuntimeWorkEvent("session.tool", "tool", "", "Exec")).toBe(true);
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

    it("ignores delayed history refresh results after the selected session changes", async () => {
        let historyRequest: Promise<{ messages: Array<{ role: string; text: string }> }>;
        let resolveHistory:
            | ((value: { messages: Array<{ role: string; text: string }> }) => void)
            | undefined;
        const request = vi.fn((method: string) => {
            if (method === "chat.history") {
                historyRequest = new Promise((resolve) => {
                    resolveHistory = resolve;
                });
                return historyRequest;
            }

            return Promise.resolve({});
        });
        const {
            emit,
            rerender,
            request: requestMock,
            result,
        } = renderRuntimeEvents({
            clearInitialRequests: false,
            request,
        });
        requestMock.mockClear();

        act(() => {
            emit({
                event: "session.item",
                payload: {
                    data: { title: "Working" },
                    runId: "run-1",
                    sessionKey: "session-a",
                    stream: "item",
                },
                type: "event",
            });
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });

        expect(requestMock).toHaveBeenCalledWith("chat.history", {
            limit: 1000,
            sessionKey: "session-a",
        });

        rerender({ selectedSessionKey: "session-b" });

        await act(async () => {
            resolveHistory?.({
                messages: [{ role: "assistant", text: "stale history" }],
            });
            await historyRequest;
        });

        expect(result.current.historyLoadVersion).toBe(0);
        expect(result.current.messages.map((message) => message.text)).not.toContain(
            "stale history"
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

    it.each(["aborted", "error", "final"] as const)(
        "ignores stale selected-session %s events from replaced runs",
        async (state) => {
            const { emit, request, result } = renderRuntimeEvents({
                activeStreams: {
                    "session-a": {
                        sessionKey: "session-a",
                        runId: "run-new",
                        aliases: ["run-new"],
                        text: "Current response",
                        updatedAt: "2026-05-22T13:40:00.000Z",
                    },
                },
            });

            act(() => {
                emit({
                    event: "chat",
                    payload: {
                        message: { content: `Stale ${state}`, role: "assistant" },
                        runId: "run-old",
                        sessionKey: "session-a",
                        state,
                    },
                    type: "event",
                });
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
                await Promise.resolve();
            });

            expect(result.current.activeStreams["session-a"]).toEqual(
                expect.objectContaining({
                    runId: "run-new",
                    text: "Current response",
                })
            );
            expect(result.current.messages).toEqual([]);
            expect(request).not.toHaveBeenCalledWith("chat.history", {
                limit: 1000,
                sessionKey: "session-a",
            });
        }
    );

    it("accepts selected-session terminal events for active run aliases", async () => {
        const { emit, request, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    sessionKey: "session-a",
                    runId: "run-new",
                    aliases: ["run-old", "run-new"],
                    text: "Current response",
                    updatedAt: "2026-05-22T13:40:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    message: { content: "Alias final", role: "assistant" },
                    runId: "run-old",
                    sessionKey: "session-a",
                    state: "final",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toBeUndefined();
        expect(result.current.messages).toEqual([
            expect.objectContaining({
                text: "Alias final",
            }),
        ]);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
            await Promise.resolve();
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
                ["json-array-result", [{ ok: true }]],
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
            '[\n  {\n    "ok": true\n  }\n]',
            "",
            "[object Object]",
        ]);
    });

    it("renders Gateway v4 tool call fallbacks and error results", () => {
        const { emit, result } = renderRuntimeEvents({ showToolOutput: true });

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        arguments: { query: "status" },
                        callId: "call-1",
                        phase: "start",
                        toolName: "functions.web_search",
                    },
                    runId: "run-tool",
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        error: "boom",
                        isError: true,
                        phase: "error",
                        tool_call_id: "call-1",
                        toolName: "functions.web_search",
                    },
                    runId: "run-tool",
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        expect(result.current.messages[0]).toEqual(
            expect.objectContaining({
                toolCalls: [
                    expect.objectContaining({
                        arguments: { query: "status" },
                        id: "call-1",
                        name: "functions.web_search",
                    }),
                ],
            })
        );
        expect(result.current.messages[1]).toEqual(
            expect.objectContaining({
                toolResult: expect.objectContaining({
                    content: "boom",
                    id: "call-1",
                    isError: true,
                    name: "functions.web_search",
                }),
            })
        );
    });

    it("tracks Gateway v4 tool activity without rendering tool rows when hidden", () => {
        const { emit, result } = renderRuntimeEvents({ showToolOutput: false });

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        args: { command: "date" },
                        name: "functions.exec",
                        phase: "start",
                    },
                    runId: "run-tool-hidden",
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        expect(result.current.messages).toEqual([]);
        expect(result.current.activeStreams["session-a"]?.statusText).toBe("Exec: date");
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

    it("keeps active streams for Gateway v4 transcript media", () => {
        const { emit, result } = renderRuntimeEvents();

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    message: {
                        content: [{ data: "abc", mimeType: "image/png", type: "image" }],
                        role: "assistant",
                    },
                    runId: "run-image",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.message?.images).toHaveLength(
            1
        );
    });

    it("uses Gateway v4 transcript payload fallbacks and preserves existing message state", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-existing"],
                    message: {
                        role: "assistant",
                        content: "Existing message",
                        text: "Existing message",
                    },
                    runId: "run-existing",
                    sessionKey: "session-a",
                    text: "Existing message",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    content: "Content fallback",
                    runId: "run-existing",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.message?.text).toBe(
            "Content fallback"
        );

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    deltaText: "Delta text fallback",
                    runId: "run-existing",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
            emit({
                event: "session.message",
                payload: {
                    runId: 123,
                    sessionKey: "session-a",
                    stream: "message",
                    text: "Text fallback",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("Text fallback");
        expect(result.current.activeStreams["session-a"]?.runId).toBe("run-existing");
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

    it("uses Gateway v4 delta, content, and text fallbacks for live chat deltas", async () => {
        const { emit, result } = renderRuntimeEvents();

        for (const [runId, payloadKey, value] of [
            ["run-delta", "delta", "Delta fallback"],
            ["run-content", "content", "Content fallback"],
            ["run-text", "text", "Text fallback"],
        ] as const) {
            await act(async () => {
                emit({
                    event: "chat",
                    payload: {
                        [payloadKey]: value,
                        runId,
                        sessionKey: "session-a",
                        state: "delta",
                    },
                    type: "event",
                });
                await vi.advanceTimersByTimeAsync(80);
            });

            expect(result.current.activeStreams["session-a"]?.text).toBe(value);
        }
    });

    it("uses session-key run fallbacks and keeps existing status for empty queued deltas", async () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["session-a"],
                    runId: "session-a",
                    sessionKey: "session-a",
                    statusText: "Still working",
                    text: "",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                runId: "session-a",
                statusText: "Still working",
                text: "",
            })
        );
    });

    it("clears existing status for queued thinking-only deltas on the same run", async () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-existing"],
                    message: {
                        content: "previous visible text",
                        role: "assistant",
                        text: "previous visible text",
                    },
                    runId: "run-existing",
                    sessionKey: "session-a",
                    statusText: "Still working",
                    text: "",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    message: {
                        content: [{ text: "hidden", type: "thinking" }],
                        role: "assistant",
                    },
                    runId: "run-existing",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                runId: "run-existing",
                statusText: undefined,
                text: "hidden",
            })
        );
    });

    it("clears existing queued status when an empty delta starts a new run", async () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-old"],
                    runId: "run-old",
                    sessionKey: "session-a",
                    statusText: "Previous work",
                    text: "",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    message: {
                        content: [{ text: "thinking", type: "thinking" }],
                        role: "assistant",
                    },
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
                runId: "run-new",
                statusText: undefined,
                text: "thinking",
            })
        );
    });

    it("starts a fresh runtime transcript message without merging old message state", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-old"],
                    message: {
                        content: "old visible text",
                        role: "assistant",
                        text: "old visible text",
                    },
                    runId: "run-old",
                    sessionKey: "session-a",
                    text: "old visible text",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    message: {
                        content: "new visible text",
                        role: "assistant",
                    },
                    runId: "run-new",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.message?.text).toBe(
            "new visible text"
        );
    });

    it("uses the session key as the run id for queued deltas without run ids", async () => {
        const { emit, result } = renderRuntimeEvents();

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "No run id",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                aliases: ["session-a"],
                runId: "session-a",
                text: "No run id",
            })
        );
    });

    it("preserves queued fallback deltas when the real run id arrives", async () => {
        const { emit, result } = renderRuntimeEvents();

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "Early ",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            emit({
                event: "chat",
                payload: {
                    deltaText: "token",
                    runId: "run-real",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                aliases: ["session-a", "run-real"],
                runId: "run-real",
                text: "Earlytoken",
            })
        );
    });

    it("preserves queued real-run deltas when a fallback run id arrives", async () => {
        const { emit, result } = renderRuntimeEvents();

        await act(async () => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "Early ",
                    runId: "run-real",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            emit({
                event: "chat",
                payload: {
                    deltaText: "token",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                aliases: ["run-real", "session-a"],
                runId: "run-real",
                text: "Earlytoken",
            })
        );
    });

    it("drops stale aliases when Gateway v4 replacement starts a new run", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["old-run"],
                    runId: "old-run",
                    sessionKey: "session-a",
                    text: "Old",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "New",
                    replace: true,
                    runId: "new-run",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.aliases).toEqual(["new-run"]);
    });

    it("preserves buffered text when promoting a provisional run id", async () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["session-a"],
                    runId: "session-a",
                    sessionKey: "session-a",
                    message: {
                        role: "assistant",
                        content: "Buffered ",
                        text: "Buffered ",
                    },
                    text: "Buffered ",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "continuation",
                    runId: "real-run",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                message: expect.objectContaining({
                    role: "assistant",
                    runId: "real-run",
                    text: "Buffered continuation",
                }),
                runId: "real-run",
                text: "Buffered continuation",
            })
        );
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

    it("coalesces queued Gateway v4 deltas onto one flush timer", async () => {
        const setTimeoutSpy = vi.spyOn(window, "setTimeout");
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-v4"],
                    runId: "run-v4",
                    sessionKey: "session-a",
                    statusText: "Still thinking",
                    text: "",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        try {
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
                    event: "chat",
                    payload: {
                        deltaText: "lo",
                        runId: "run-v4",
                        sessionKey: "session-a",
                        state: "delta",
                    },
                    type: "event",
                });
            });

            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(80);
            });

            expect(result.current.activeStreams["session-a"]?.text).toBe("Hello");
        } finally {
            setTimeoutSpy.mockRestore();
        }
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

    it("keeps active streams for Gateway v4 transcript tool-call messages", () => {
        const { emit, result } = renderRuntimeEvents({ showToolOutput: true });

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    message: {
                        content: [
                            {
                                arguments: { command: "date" },
                                id: "tool-1",
                                name: "functions.exec",
                                type: "toolCall",
                            },
                        ],
                        role: "assistant",
                    },
                    runId: "run-v4",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.message?.toolCalls).toEqual([
            expect.objectContaining({ id: "tool-1", name: "functions.exec" }),
        ]);
    });

    it("uses fallback transcript tool and message payload fields", () => {
        const { emit, result } = renderRuntimeEvents({ showToolOutput: true });

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        args: { text: "fallback tool detail" },
                        phase: "start",
                    },
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        expect(result.current.messages[0]?.toolCalls?.[0]).toEqual(
            expect.objectContaining({
                arguments: { text: "fallback tool detail" },
                name: "tool",
            })
        );
        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                runId: "session-a",
                statusText: "Tool: fallback tool detail",
            })
        );

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    content: "Content transcript",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                message: expect.objectContaining({ text: "Content transcript" }),
                runId: "session-a",
                text: "Content transcript",
            })
        );
    });

    it("ignores empty Gateway v4 transcript text and clears pure transcript status", () => {
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

        expect(result.current.activeStreams["session-a"]).toBeUndefined();
    });

    it("does not clear active stream for empty Gateway v4 transcript from another run", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["active-run"],
                    runId: "active-run",
                    sessionKey: "session-a",
                    text: "Still active",
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
                    runId: "other-run",
                    sessionKey: "session-a",
                    stream: "message",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("Still active");
    });

    it("ignores empty Gateway v4 transcript text when no stream exists", () => {
        const { emit, result } = renderRuntimeEvents();

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

        expect(result.current.activeStreams).toEqual({});
    });

    it("only clears terminal lifecycle events for the matching active run", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["active-alias"],
                    runId: "active-run",
                    sessionKey: "session-a",
                    text: "Still active",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "session.lifecycle",
                payload: {
                    data: { phase: "end" },
                    runId: "old-run",
                    sessionKey: "session-a",
                    stream: "lifecycle",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.text).toBe("Still active");

        act(() => {
            emit({
                event: "session.lifecycle",
                payload: {
                    data: { phase: "end" },
                    runId: "active-alias",
                    sessionKey: "session-a",
                    stream: "lifecycle",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toBeUndefined();
    });

    it("flushes pending deltas before terminal lifecycle clear", async () => {
        const { emit, result } = renderRuntimeEvents();

        act(() => {
            emit({
                event: "chat",
                payload: {
                    deltaText: "Queued text",
                    runId: "run-v4",
                    sessionKey: "session-a",
                    state: "delta",
                },
                type: "event",
            });
            emit({
                event: "session.lifecycle",
                payload: {
                    data: { phase: "end" },
                    runId: "run-v4",
                    sessionKey: "session-a",
                    stream: "lifecycle",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toBeUndefined();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(80);
        });

        expect(result.current.activeStreams["session-a"]).toBeUndefined();
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

    it("does not create thinking status for filtered non-work tool events", () => {
        const { emit, result } = renderRuntimeEvents({ showToolOutput: true });

        act(() => {
            emit({
                event: "session.tool",
                payload: {
                    data: {
                        name: "message",
                        phase: "start",
                    },
                    runId: "run-message",
                    sessionKey: "session-a",
                    stream: "tool",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams).toEqual({});
        expect(result.current.messages).toEqual([]);
    });

    it("handles runtime events with missing stream and run identifiers", () => {
        const { emit, result } = renderRuntimeEvents();

        act(() => {
            emit({
                event: "session.message",
                payload: {
                    message: {
                        content: "Message without run id",
                        role: "assistant",
                    },
                    sessionKey: "session-a",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]).toEqual(
            expect.objectContaining({
                runId: "session-a",
                text: "Message without run id",
            })
        );
    });

    it("preserves status text or falls back to thinking for work events without text", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-existing"],
                    runId: "run-existing",
                    sessionKey: "session-a",
                    statusText: "Existing work",
                    text: "",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "session.item",
                payload: {
                    data: {},
                    runId: "run-existing",
                    sessionKey: "session-a",
                    stream: "item",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.statusText).toBe(
            "Existing work"
        );

        act(() => {
            emit({
                event: "session.item",
                payload: {
                    data: {},
                    runId: "run-new",
                    sessionKey: "session-a",
                    stream: "item",
                },
                type: "event",
            });
        });

        expect(result.current.activeStreams["session-a"]?.statusText).toBe("Thinking");
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

    it("uses buffered text for hidden final payloads and ignores remote errors", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-hidden"],
                    runId: "run-hidden",
                    sessionKey: "session-a",
                    text: "Buffered final text",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
                "session-b": {
                    aliases: ["run-remote"],
                    runId: "run-remote",
                    sessionKey: "session-b",
                    text: "",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    message: {
                        content: "hidden tool result",
                        role: "tool",
                        text: "hidden tool result",
                    },
                    runId: "run-hidden",
                    sessionKey: "session-a",
                    state: "final",
                },
                type: "event",
            });
        });

        expect(result.current.messages.map((message) => message.text)).toContain(
            "Buffered final text"
        );
        expect(result.current.activeStreams["session-a"]).toBeUndefined();

        act(() => {
            emit({
                event: "chat",
                payload: {
                    errorMessage: "remote boom",
                    runId: "run-remote",
                    state: "error",
                },
                type: "event",
            });
        });

        expect(result.current.sendError).toBeNull();
        expect(result.current.activeStreams["session-b"]).toBeUndefined();
    });

    it("clears empty finals without appending a fallback message", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-empty-final"],
                    runId: "run-empty-final",
                    sessionKey: "session-a",
                    text: "",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    runId: "run-empty-final",
                    sessionKey: "session-a",
                    state: "final",
                },
                type: "event",
            });
        });

        expect(result.current.messages).toEqual([]);
        expect(result.current.activeStreams["session-a"]).toBeUndefined();
    });

    it("clears empty aborted streams without appending text", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-empty"],
                    runId: "run-empty",
                    sessionKey: "session-a",
                    text: "",
                    updatedAt: "2026-05-15T10:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    runId: "run-empty",
                    sessionKey: "session-a",
                    state: "aborted",
                },
                type: "event",
            });
        });

        expect(result.current.messages).toEqual([]);
        expect(result.current.activeStreams["session-a"]).toBeUndefined();
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

    it("does not merge unflushed deltas across new runs", async () => {
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

    it("does not surface remote stream errors for non-selected sessions", () => {
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
                payload: {
                    errorMessage: "Remote failed",
                    runId: "run-b",
                    state: "error",
                },
                type: "event",
            });
        });

        expect(result.current.sendError).toBeNull();
        expect(result.current.activeStreams["session-b"]).toBeUndefined();
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

    it("ignores unknown chat terminal states", () => {
        const { emit, result } = renderRuntimeEvents({
            activeStreams: {
                "session-a": {
                    aliases: ["run-local"],
                    runId: "run-local",
                    sessionKey: "session-a",
                    text: "Partial",
                    updatedAt: "2026-05-11T00:00:00.000Z",
                },
            },
        });

        act(() => {
            emit({
                event: "chat",
                payload: {
                    runId: "run-local",
                    sessionKey: "session-a",
                    state: "unknown",
                },
                type: "event",
            });
        });

        expect(result.current.sendError).toBeNull();
        expect(result.current.activeStreams["session-a"]?.text).toBe("Partial");
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
