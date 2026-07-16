import { describe, expect, it } from "bun:test";

import {
    argumentDetail,
    asRecord,
    compactStatus,
    formatToolName,
    isNonWorkTool,
    itemTexts,
    itemType,
    openClawThroughSequence,
    rawString,
    runtimeText,
    stringValue,
} from "../components/features/chat/transport/openClawAdapterValues";
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
            runId: "run-variants",
            sessionKey: SESSION,
            ts: 1_752_664_800_000,
            ...payload,
        },
        runtimeSequence,
        type: "event",
    };
}

describe("OpenClaw adapter variants", () => {
    it("normalizes session, assistant, thinking and item streams", () => {
        const adapter = new OpenClawChatAdapter();
        const sessionMessage = adapter.event(
            envelope(
                "session.message",
                { message: { content: "preamble", role: "assistant" } },
                20
            )
        );
        const ignoredUser = adapter.event(
            envelope(
                "session.message",
                { message: { content: "prompt", role: "user" } },
                21
            )
        );
        const assistant = adapter.event(
            envelope("agent", { data: { delta: "answer" }, stream: "assistant" }, 22)
        );
        const thinking = adapter.event(
            envelope("agent", { data: { text: "considering" }, stream: "thinking" }, 23)
        );
        const emptyThinking = adapter.event(
            envelope("agent", { data: {}, stream: "reasoning" }, 24)
        );
        const itemThinking = adapter.event(
            envelope(
                "agent",
                {
                    data: {
                        item: {
                            id: "thought-1",
                            summary: [{ text: "item thought", type: "text" }],
                            type: "reasoning",
                        },
                    },
                    stream: "item",
                },
                25
            )
        );

        expect(sessionMessage[0]).toMatchObject({
            kind: "assistant",
            source: "session",
        });
        expect(ignoredUser).toEqual([]);
        expect(assistant.map((event) => event.kind)).toEqual(["assistant"]);
        expect(assistant[0]?.kind === "assistant" && assistant[0].message.text).toBe(
            "answer"
        );
        expect(thinking.map((event) => event.kind)).toEqual(["status", "thinking"]);
        expect(
            thinking[1]?.kind === "thinking" &&
                thinking[1].message.thinking?.[0]?.snapshot
        ).toBe(true);
        expect(emptyThinking.map((event) => event.kind)).toEqual(["status"]);
        const expectedItemThinking = expect.objectContaining({
            kind: "thinking",
            message: expect.objectContaining({
                thinking: [
                    expect.objectContaining({
                        id: "thought-1",
                        text: "item thought",
                    }),
                ],
            }),
        });
        expect(itemThinking).toEqual([expectedItemThinking]);
    });

    it("normalizes item tool calls, results and progress-only items", () => {
        const adapter = new OpenClawChatAdapter();
        const call = adapter.event(
            envelope(
                "agent",
                {
                    data: {
                        item: {
                            arguments: { path: "/tmp/report.txt" },
                            call_id: "call-1",
                            name: "read",
                            type: "function_call",
                        },
                    },
                    stream: "item",
                },
                30
            )
        );
        const result = adapter.event(
            envelope(
                "agent",
                {
                    data: {
                        item: {
                            call_id: "call-1",
                            name: "read",
                            output: "contents",
                            type: "function_call_output",
                        },
                    },
                    stream: "item",
                },
                31
            )
        );
        const progress = adapter.event(
            envelope(
                "agent",
                {
                    data: { itemKind: "download", meta: "report.txt" },
                    stream: "item",
                },
                32
            )
        );

        expect(call[0]).toMatchObject({
            kind: "tool",
            toolKey: "tool:call-1",
        });
        expect(
            call[0]?.kind === "tool" && call[0].message.toolCalls?.[0]?.arguments
        ).toEqual({ path: "/tmp/report.txt" });
        expect(result[0]?.kind === "tool" && result[0].message.toolResult?.content).toBe(
            "contents"
        );
        expect(progress).toEqual([
            expect.objectContaining({ kind: "status", text: "Download: report.txt" }),
        ]);
    });

    it("maps progress channels and terminal lifecycle outcomes", () => {
        const adapter = new OpenClawChatAdapter();
        const cases = [
            ["plan", { explanation: "Check dependencies" }, "Check dependencies"],
            ["approval", { command: "deploy" }, "deploy"],
            ["patch", { summary: "Update files" }, "Update files"],
            ["compaction", { phase: "start" }, "Compacting context"],
            ["command_output", { exitCode: 0, phase: "end" }, "Exec: completed"],
        ] as const;

        for (const [index, [stream, data, text]] of cases.entries()) {
            const events = adapter.event(envelope("agent", { data, stream }, 40 + index));
            expect(events[0]).toMatchObject({ kind: "status", text });
        }

        const compactionEnd = adapter.event(
            envelope("agent", { data: { phase: "end" }, stream: "compaction" }, 46)
        );
        const lifecycleStart = adapter.event(
            envelope("agent", { data: { phase: "start" }, stream: "lifecycle" }, 47)
        );
        const lifecycleError = adapter.event(
            envelope(
                "agent",
                {
                    data: { errorMessage: "model failed", phase: "error" },
                    stream: "lifecycle",
                },
                48
            )
        );
        const modelAborted = adapter.event(
            envelope("model.completed", { data: { status: "aborted" } }, 49)
        );
        const sessionAborted = adapter.event(
            envelope("session.ended", { aborted: true }, 50)
        );
        const modelFailed = adapter.event(
            envelope("model.completed", { status: "failed" }, 51)
        );

        expect(compactionEnd[0]).toMatchObject({
            kind: "status",
            operation: "compact",
            text: undefined,
        });
        expect(lifecycleStart[0]).toMatchObject({ kind: "status", text: "Thinking" });
        expect(lifecycleError[0]).toMatchObject({
            error: "model failed",
            kind: "finish",
            outcome: "error",
        });
        expect(modelAborted[0]).toMatchObject({ kind: "finish", outcome: "aborted" });
        expect(sessionAborted[0]).toMatchObject({
            kind: "finish",
            outcome: "aborted",
        });
        expect(modelFailed[0]).toMatchObject({ kind: "finish", outcome: "error" });
    });

    it("maps command finals, replacement deltas and unsupported chat states", () => {
        const adapter = new OpenClawChatAdapter();
        const replacement = adapter.event(
            envelope(
                "chat",
                { content: "replacement", replace: true, state: "delta" },
                52
            )
        );
        const command = adapter.event(
            envelope(
                "chat",
                {
                    message: {
                        command: true,
                        content: "command complete",
                        role: "assistant",
                    },
                    state: "final",
                },
                53
            )
        );
        const payloadError = adapter.event(
            envelope("chat", { error: "provider failed", state: "error" }, 54)
        );
        const genericError = adapter.event(envelope("chat", { state: "error" }, 55));

        expect(replacement[0]).toMatchObject({ kind: "assistant", mode: "replace" });
        expect(command[0]).toMatchObject({
            kind: "finish",
            message: expect.objectContaining({ local: true, role: "system" }),
        });
        expect(payloadError[0]).toMatchObject({
            error: "provider failed",
            kind: "finish",
            outcome: "error",
        });
        expect(genericError[0]).toMatchObject({
            error: "Chat run failed",
            kind: "finish",
            outcome: "error",
        });
        expect(adapter.event(envelope("chat", { state: "working" }, 56))).toEqual([]);
    });

    it("keeps provider value helpers deterministic for unusual payloads", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        expect(asRecord([])).toBeUndefined();
        expect(stringValue("  value  ")).toBe("value");
        expect(stringValue(" ".repeat(3))).toBeUndefined();
        expect(rawString(" ")).toBe(" ");
        expect(runtimeText([{ text: "block", type: "text" }])).toBe("block");
        expect(runtimeText(undefined)).toBe("");
        expect(runtimeText({ ok: true })).toBe('{\n  "ok": true\n}');
        expect(runtimeText(circular)).toBe("[object Object]");
        expect(formatToolName("functions.read_file")).toBe("Read file");
        expect(formatToolName("---")).toBe("Tool");
        expect(isNonWorkTool("functions.message")).toBe(true);
        expect(argumentDetail("details")).toBe("details");
        expect(argumentDetail({ path: "/tmp/file" })).toBe("/tmp/file");
        expect(argumentDetail({ count: 1 })).toBeUndefined();
        expect(compactStatus("x".repeat(130))).toHaveLength(120);
        expect(
            itemTexts({ item: { summary: [{ text: "summary", type: "text" }] } }, [
                "summary",
            ])
        ).toEqual(["summary"]);
        expect(itemType({ payload: { type: "TOOL_USE" } })).toBe("tool_use");
        expect(openClawThroughSequence(2)).toBe(47);
        expect(openClawThroughSequence("2")).toBe(0);
        expect(openClawThroughSequence(Number.MAX_SAFE_INTEGER)).toBe(0);
    });
});
