import { describe, expect, it } from "bun:test";

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

    it("does not promote surfaced tool failures to a global chat error", () => {
        const adapter = new OpenClawChatAdapter();
        adapter.event(
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
                9
            )
        );
        const otherSession = adapter.event({
            ...envelope("chat", { errorMessage: "model failed", state: "error" }, 10),
            payload: {
                errorMessage: "model failed",
                runId: "run-1",
                sessionKey: "agent:main:other",
                state: "error",
            },
        });
        const sameRun = adapter.event(
            envelope("chat", { errorMessage: "request failed", state: "error" }, 11)
        );
        const runlessToolError = adapter.event({
            event: "chat",
            payload: {
                errorMessage: "⚠️ 🛠️ `run lint` failed",
                sessionKey: SESSION,
                state: "error",
            },
            runtimeSequence: 12,
            type: "event",
        });

        expect(sameRun[0]?.kind === "finish" && sameRun[0].error).toBeUndefined();
        expect(otherSession[0]?.kind === "finish" && otherSession[0].error).toBe(
            "model failed"
        );
        expect(
            runlessToolError[0]?.kind === "finish" && runlessToolError[0].error
        ).toBeUndefined();
    });
});
