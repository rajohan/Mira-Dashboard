import { describe, expect, it } from "bun:test";

import {
    createChatRuntimeState,
    reduceChatRuntime,
} from "../components/features/chat/domain/chatState";
import { OpenClawChatAdapter } from "../components/features/chat/transport/openClawChatAdapter";

const SESSION = "agent:main:main";

function envelope(
    event: string,
    payload: Record<string, unknown>,
    runtimeSequence: number
) {
    return {
        event,
        payload: {
            runId: "run-1",
            sessionKey: SESSION,
            ts: 1_752_664_800_000,
            ...payload,
        },
        runtimeSequence,
        type: "event",
    };
}

describe("OpenClaw chat adapter", () => {
    it("maps chat deltas and terminal finals to canonical events", () => {
        const adapter = new OpenClawChatAdapter();
        const delta = adapter.event(
            envelope("chat", { deltaText: "Hello", state: "delta" }, 3)
        );
        const final = adapter.event(
            envelope(
                "chat",
                {
                    message: { content: "Hello world", role: "assistant" },
                    state: "final",
                },
                4
            )
        );

        expect(delta).toEqual([
            expect.objectContaining({
                kind: "assistant",
                mode: "merge",
                runId: "run-1",
                sequence: 48,
                source: "chat",
            }),
        ]);
        expect(final).toEqual([
            expect.objectContaining({
                kind: "finish",
                outcome: "completed",
                sequence: 64,
            }),
        ]);
        expect(final[0]?.kind === "finish" && final[0].message?.text).toBe("Hello world");
    });

    it("maps thinking, tools, progress and terminal lifecycle in order", () => {
        const adapter = new OpenClawChatAdapter();
        const thinking = adapter.event(
            envelope("agent", { data: { delta: "considering" }, stream: "reasoning" }, 5)
        );
        const tool = adapter.event(
            envelope(
                "session.tool",
                {
                    data: {
                        args: { cmd: "date" },
                        id: "call-1",
                        name: "functions.exec_command",
                        phase: "start",
                    },
                    stream: "tool",
                },
                6
            )
        );
        const terminal = adapter.event(
            envelope("agent", { data: { phase: "end" }, stream: "lifecycle" }, 7)
        );

        expect(thinking.map((item) => item.kind)).toEqual(["status", "thinking"]);
        expect(tool.map((item) => item.kind)).toEqual(["status", "tool"]);
        expect(terminal.map((item) => item.kind)).toEqual(["finish"]);
        expect(tool[1]?.kind === "tool" && tool[1].toolKey).toBe("tool:call-1");
    });

    it("restores active-run status from a replayed session start", () => {
        const adapter = new OpenClawChatAdapter();
        const started = adapter.event(envelope("session.started", {}, 8));

        expect(started).toEqual([
            expect.objectContaining({ kind: "status", text: "Thinking" }),
        ]);
    });

    it("ignores non-chat envelopes and delivery-noise tools", () => {
        const adapter = new OpenClawChatAdapter();
        expect(adapter.event({ type: "sessions" })).toEqual([]);
        expect(
            adapter.event(
                envelope(
                    "session.tool",
                    {
                        data: { name: "message", phase: "start" },
                        stream: "tool",
                    },
                    8
                )
            )
        ).toEqual([]);
    });

    it("sorts snapshot events by the backend sequence", () => {
        const adapter = new OpenClawChatAdapter();
        const events = adapter.snapshot({
            completed: false,
            events: [
                envelope("chat", { deltaText: "B", state: "delta" }, 2),
                envelope("chat", { deltaText: "A", state: "delta" }, 1),
            ],
            throughSequence: 2,
        });

        expect(events.map((event) => event.sequence)).toEqual([16, 32]);
    });

    it("preserves provider ordering when a snapshot follows a newer live event", () => {
        const adapter = new OpenClawChatAdapter();
        adapter.event(envelope("chat", { deltaText: "live", state: "delta" }, 3));

        const replay = adapter.snapshot({
            completed: false,
            events: [
                envelope("chat", { deltaText: "B", state: "delta" }, 2),
                envelope("chat", { deltaText: "A", state: "delta" }, 1),
            ],
            throughSequence: 2,
        });
        const queued = adapter.event(
            envelope("chat", { deltaText: "queued", state: "delta" }, 4)
        );

        expect(replay.map((event) => event.sequence)).toEqual([16, 32]);
        expect(queued[0]?.sequence).toBe(64);
    });

    it("keeps fallback sequences ahead of previously observed provider sequences", () => {
        const adapter = new OpenClawChatAdapter();
        const sequenced = adapter.event(
            envelope("chat", { deltaText: "first", state: "delta" }, 100)
        );
        const unsequenced = envelope(
            "chat",
            { deltaText: "second", state: "delta" },
            0
        ) as Record<string, unknown>;
        delete unsequenced.runtimeSequence;

        const fallback = adapter.event(unsequenced);

        expect(fallback[0]?.sequence).toBeGreaterThan(sequenced[0]?.sequence || 0);
    });

    it("uses the backend recording time when a provider event has no timestamp", () => {
        const adapter = new OpenClawChatAdapter();
        const raw = envelope("chat", { deltaText: "hello", state: "delta" }, 1);
        const payload: Record<string, unknown> = {
            ...raw.payload,
            ts: Number.MAX_VALUE,
        };
        const recordedAt = Date.parse("2026-07-16T12:34:56.000Z");

        const events = adapter.event({ ...raw, payload, runtimeRecordedAt: recordedAt });

        expect(events[0]?.timestamp).toBe("2026-07-16T12:34:56.000Z");
    });

    it("retains attachment-only tool history while folding matching results", () => {
        const adapter = new OpenClawChatAdapter();
        const messages = adapter.history([
            {
                content: [
                    {
                        arguments: { path: "/tmp/report.txt" },
                        id: "call-1",
                        name: "read",
                        type: "toolCall",
                    },
                ],
                role: "assistant",
            },
            {
                MediaPath: "/tmp/report.txt",
                content: "",
                role: "tool",
                toolCallId: "call-1",
                toolName: "read",
            },
            {
                MediaPath: "/tmp/orphan.txt",
                content: "",
                role: "tool",
                toolCallId: "orphan",
                toolName: "write",
            },
        ]);

        expect(messages[0]?.toolCalls?.[0]?.toolResult?.id).toBe("call-1");
        expect(messages[0]?.attachments?.[0]?.fileName).toBe("report.txt");
        expect(messages[1]?.attachments?.[0]?.fileName).toBe("orphan.txt");
    });

    it("recovers a Dashboard user run id from its history idempotency key", () => {
        const adapter = new OpenClawChatAdapter();
        const messages = adapter.history([
            {
                content: "steer",
                idempotencyKey: "dashboard-chat-123:user",
                role: "user",
            },
        ]);

        expect(messages[0]?.runId).toBe("dashboard-chat-123");
    });

    it("retains attachment-only runtime tool results", () => {
        const adapter = new OpenClawChatAdapter();
        const events = adapter.event(
            envelope(
                "session.tool",
                {
                    data: {
                        MediaPath: "/tmp/generated.png",
                        MediaType: "image/png",
                        name: "generate",
                        phase: "result",
                        result: "",
                    },
                    stream: "tool",
                },
                7
            )
        );
        const tool = events.find((event) => event.kind === "tool");

        expect(tool?.kind === "tool" && tool.message.attachments?.[0]).toMatchObject({
            fileName: "generated.png",
            kind: "image",
        });
    });

    it("does not fold a no-id tool result across a user-turn boundary", () => {
        const adapter = new OpenClawChatAdapter();
        const messages = adapter.history([
            {
                content: [
                    { arguments: { path: "old.txt" }, name: "read", type: "toolCall" },
                ],
                role: "assistant",
            },
            { content: "next", role: "user" },
            { content: "new result", role: "tool", toolName: "read" },
        ]);

        expect(messages).toHaveLength(3);
        expect(messages[0]?.toolCalls?.[0]?.toolResult).toBeUndefined();
        expect(messages[2]?.role).toBe("tool");
    });

    it("folds a run-scoped tool result across a newer user boundary", () => {
        const adapter = new OpenClawChatAdapter();
        const messages = adapter.history([
            {
                content: [{ id: "call-1", name: "read", type: "toolCall" }],
                role: "assistant",
                runId: "run-1",
            },
            { content: "next", role: "user" },
            {
                content: "late result",
                role: "tool",
                runId: "run-1",
                toolCallId: "call-1",
                toolName: "read",
            },
        ]);

        expect(messages).toHaveLength(2);
        expect(messages[0]?.toolCalls?.[0]?.toolResult?.content).toBe("late result");
        expect(messages[1]?.role).toBe("user");
    });

    it("matches sequential no-id results to one pending call at a time", () => {
        const adapter = new OpenClawChatAdapter();
        const messages = adapter.history([
            {
                content: [
                    { arguments: { cmd: "first" }, name: "exec", type: "toolCall" },
                    { arguments: { cmd: "second" }, name: "exec", type: "toolCall" },
                ],
                role: "assistant",
            },
            { content: "first output", role: "tool", toolName: "exec" },
            { content: "second output", role: "tool", toolName: "exec" },
        ]);

        expect(messages).toHaveLength(1);
        expect(messages[0]?.toolCalls?.map((call) => call.toolResult?.content)).toEqual([
            "first output",
            "second output",
        ]);
    });

    it("keeps repeated completed results standalone and uses the folded timestamp", () => {
        const adapter = new OpenClawChatAdapter();
        const messages = adapter.history([
            {
                content: [{ id: "call-1", name: "exec", type: "toolCall" }],
                role: "assistant",
                timestamp: "2026-07-16T10:00:00.000Z",
            },
            {
                content: "first output",
                role: "tool",
                timestamp: "2026-07-16T10:01:00.000Z",
                toolCallId: "call-1",
                toolName: "exec",
            },
            {
                content: "delayed duplicate",
                role: "tool",
                timestamp: "2026-07-16T10:02:00.000Z",
                toolCallId: "call-1",
                toolName: "exec",
            },
        ]);

        expect(messages).toHaveLength(2);
        expect(messages[0]?.timestamp).toBe("2026-07-16T10:01:00.000Z");
        expect(messages[0]?.toolCalls?.[0]?.toolResult?.content).toBe("first output");
        expect(messages[1]?.toolResult?.content).toBe("delayed duplicate");
    });

    it("keeps tool-terminal failures in diagnostic rows instead of global errors", () => {
        const adapter = new OpenClawChatAdapter();
        const failedTool = adapter.event(
            envelope(
                "session.tool",
                {
                    data: {
                        error: "database is locked",
                        name: "functions.exec_command",
                    },
                    stream: "tool",
                },
                9
            )
        );
        const repeatedToolError = adapter.event(
            envelope(
                "chat",
                {
                    errorMessage: "tool execution failed: database is locked",
                    state: "error",
                },
                10
            )
        );
        const repeatedState = reduceChatRuntime(createChatRuntimeState(), [
            ...failedTool,
            ...repeatedToolError,
        ]);

        const nonMatchingAdapter = new OpenClawChatAdapter();
        const nonMatchingState = reduceChatRuntime(createChatRuntimeState(), [
            ...nonMatchingAdapter.event(
                envelope(
                    "session.tool",
                    {
                        data: {
                            error: "database is locked",
                            isError: true,
                            name: "functions.exec_command",
                            phase: "error",
                        },
                        stream: "tool",
                    },
                    11
                )
            ),
            ...nonMatchingAdapter.event(
                envelope("chat", { errorMessage: "request failed", state: "error" }, 12)
            ),
        ]);
        const otherSession = adapter.event({
            ...envelope("chat", { errorMessage: "model failed", state: "error" }, 13),
            payload: {
                errorMessage: "model failed",
                runId: "run-1",
                sessionKey: "agent:main:other",
                state: "error",
            },
        });
        const runlessToolError = adapter.event({
            event: "chat",
            payload: {
                errorMessage: "⚠️ 🛠️ `run lint` failed",
                sessionKey: SESSION,
                state: "error",
            },
            runtimeSequence: 14,
            type: "event",
        });
        const duplicateToolMessage = adapter.event(
            envelope(
                "chat",
                {
                    message: "tool execution failed: database is locked",
                    state: "error",
                },
                15
            )
        );
        const legitimateFinal = adapter.event(
            envelope(
                "chat",
                {
                    message: "⚠️ 🛠️ warnings can also be ordinary final text",
                    state: "final",
                },
                16
            )
        );
        const failedToolEvent = failedTool.find((event) => event.kind === "tool");

        expect(
            failedToolEvent?.kind === "tool" &&
                failedToolEvent.message.toolResult?.isError
        ).toBe(true);
        expect(repeatedState.sessions[SESSION]?.runs["run-1"]?.error).toBeUndefined();
        expect(nonMatchingState.sessions[SESSION]?.runs["run-1"]?.error).toBe(
            "request failed"
        );
        expect(otherSession[0]?.kind === "finish" && otherSession[0].error).toBe(
            "model failed"
        );
        expect(runlessToolError[0]?.kind === "finish" && runlessToolError[0].error).toBe(
            undefined
        );
        expect(
            repeatedToolError[0]?.kind === "finish" && repeatedToolError[0].error
        ).toBe(undefined);
        expect(
            duplicateToolMessage[0]?.kind === "finish" && duplicateToolMessage[0].message
        ).toBeUndefined();
        expect(
            duplicateToolMessage[0]?.kind === "finish" && duplicateToolMessage[0].error
        ).toBeUndefined();
        expect(
            legitimateFinal[0]?.kind === "finish" && legitimateFinal[0].message?.text
        ).toBe("⚠️ 🛠️ warnings can also be ordinary final text");
    });

    it("retains an empty error-only tool result as a failure", () => {
        const adapter = new OpenClawChatAdapter();
        const events = adapter.event(
            envelope(
                "session.tool",
                {
                    data: {
                        error: "",
                        name: "functions.exec_command",
                        phase: "end",
                    },
                    stream: "tool",
                },
                15
            )
        );
        const tool = events.find((event) => event.kind === "tool");

        expect(tool?.kind === "tool" && tool.message.toolResult).toMatchObject({
            content: "",
            isError: true,
        });
    });

    it("normalizes malformed raw history metadata without throwing", () => {
        const adapter = new OpenClawChatAdapter();
        const messages = adapter.history([
            {
                MediaPaths: [42, undefined, { path: "report.txt" }],
                MediaTypes: ["text/plain", 17],
                content: "",
                role: { unexpected: true },
                runId: 99,
                timestamp: Number.MAX_VALUE,
            },
        ]);

        expect(messages[0]).toMatchObject({
            role: "unknown",
            runId: undefined,
            timestamp: undefined,
        });
        expect(
            messages[0]?.attachments?.map((attachment) => attachment.fileName)
        ).toEqual(["42", "undefined", "[object Object]"]);
        expect(adapter.history({ messages: [] })).toEqual([]);
        expect(adapter.history([undefined, "invalid"])).toEqual([]);
        expect(adapter.snapshot({ events: { invalid: true } })).toEqual([]);
    });
});
