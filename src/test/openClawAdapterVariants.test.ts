import { describe, expect, it } from "bun:test";

import {
    createChatVisibility,
    presentChatMessages,
} from "../components/features/chat/domain/chatPresentation";
import {
    createChatRuntimeState,
    reduceChatRuntime,
} from "../components/features/chat/domain/chatState";
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
    it("groups heartbeat-style thinking around preamble tool steps", () => {
        const adapter = new OpenClawChatAdapter();
        const history = adapter.history([
            { content: "heartbeat", role: "user" },
            {
                content: [
                    { thinking: "inspect services", type: "thinking" },
                    { text: "Checking services", type: "text" },
                    {
                        arguments: { command: "systemctl --failed" },
                        id: "functions.exec:0",
                        name: "exec",
                        type: "toolCall",
                    },
                ],
                role: "assistant",
            },
            {
                content: [{ text: "all units healthy", type: "text" }],
                role: "toolResult",
                toolCallId: "functions.exec:0",
                toolName: "exec",
            },
            {
                content: [
                    { thinking: "inspect disk", type: "thinking" },
                    {
                        arguments: { command: "df -h" },
                        id: "functions.exec:1",
                        name: "exec",
                        type: "toolCall",
                    },
                ],
                role: "assistant",
            },
            {
                content: [{ text: "disk healthy", type: "text" }],
                role: "toolResult",
                toolCallId: "functions.exec:1",
                toolName: "exec",
            },
            {
                content: [
                    { thinking: "report result", type: "thinking" },
                    { text: "HEARTBEAT_OK", type: "text" },
                ],
                role: "assistant",
            },
        ]);
        const visible = presentChatMessages(
            history,
            createChatVisibility(true, true),
            true
        );
        const thinkingRows = visible.filter((message) => message.thinking?.length);
        const thinkingIndex = visible.findIndex((message) => message.thinking?.length);
        const lastToolIndex = visible.findLastIndex(
            (message) => message.toolCalls?.length || message.toolResult
        );
        const finalIndex = visible.findIndex(
            (message) => message.text === "HEARTBEAT_OK"
        );

        expect(thinkingRows).toHaveLength(1);
        expect(thinkingRows[0]?.thinking?.map((block) => block.text)).toEqual([
            "inspect services",
            "inspect disk",
            "report result",
        ]);
        expect(thinkingIndex).toBeGreaterThan(lastToolIndex);
        expect(thinkingIndex).toBeLessThan(finalIndex);
        expect(visible[finalIndex]?.thinking).toBeUndefined();
    });

    it("normalizes session, assistant, thinking and item streams", () => {
        const adapter = new OpenClawChatAdapter();
        const sessionMessage = adapter.event(
            envelope(
                "session.message",
                { message: { content: "preamble", role: "assistant" } },
                20
            )
        );
        const userMessage = adapter.event(
            envelope(
                "session.message",
                { message: { content: "prompt", role: "user" } },
                21
            )
        );
        const runlessUserMessage = adapter.event(
            envelope(
                "session.message",
                {
                    message: { content: "provider echo", role: "user" },
                    runId: undefined,
                },
                22
            )
        );
        const topLevelAssistant = adapter.event(
            envelope(
                "session.message",
                { content: "top-level preamble", role: "assistant" },
                22
            )
        );
        const topLevelUser = adapter.event(
            envelope("session.message", { content: "top-level prompt", role: "user" }, 23)
        );
        const nestedTopLevelUser = adapter.event(
            envelope(
                "session.message",
                { message: "nested top-level prompt", role: "user" },
                24
            )
        );
        const nestedTopLevelAssistant = adapter.event(
            envelope(
                "session.message",
                { message: "nested top-level answer", role: "assistant" },
                25
            )
        );
        const assistant = adapter.event(
            envelope("agent", { data: { delta: "answer" }, stream: "assistant" }, 26)
        );
        const thinking = adapter.event(
            envelope("agent", { data: { text: "considering" }, stream: "thinking" }, 27)
        );
        const emptyThinking = adapter.event(
            envelope("agent", { data: {}, stream: "reasoning" }, 28)
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
                29
            )
        );

        expect(sessionMessage[0]).toMatchObject({
            kind: "assistant",
            source: "session",
        });
        expect(userMessage[0]).toMatchObject({
            kind: "user",
            message: { role: "user", text: "prompt" },
        });
        expect(runlessUserMessage[0]).toMatchObject({
            kind: "user",
            message: { role: "user", text: "provider echo" },
            runId: undefined,
        });
        expect(topLevelAssistant[0]).toMatchObject({
            kind: "assistant",
            message: { role: "assistant", text: "top-level preamble" },
            source: "session",
        });
        expect(topLevelUser[0]).toMatchObject({
            kind: "user",
            message: { role: "user", text: "top-level prompt" },
        });
        expect(nestedTopLevelUser[0]).toMatchObject({
            kind: "user",
            message: { role: "user", text: "nested top-level prompt" },
        });
        expect(nestedTopLevelAssistant[0]).toMatchObject({
            kind: "assistant",
            message: { role: "assistant", text: "nested top-level answer" },
        });
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
        const lifecycleStatusOnlyError = adapter.event(
            envelope("agent", { data: { phase: "error" }, stream: "lifecycle" }, 52)
        );
        const nestedLifecycleEnd = adapter.event(
            envelope("agent", { data: { phase: "end", stream: "lifecycle" } }, 53)
        );

        expect(compactionEnd[0]).toMatchObject({
            kind: "status",
            operation: "compact",
            operationPhase: "inactive",
            text: undefined,
        });
        expect(lifecycleStart[0]).toMatchObject({ kind: "status", text: "Thinking" });
        expect(lifecycleError[0]).toMatchObject({
            error: "model failed",
            kind: "finish",
            outcome: "error",
            settlesCompaction: true,
        });
        expect(modelAborted[0]).toMatchObject({
            error: undefined,
            kind: "finish",
            outcome: "aborted",
        });
        expect(sessionAborted[0]).toMatchObject({
            error: undefined,
            kind: "finish",
            outcome: "aborted",
        });
        expect(modelFailed[0]).toMatchObject({
            error: "Chat run failed",
            kind: "finish",
            outcome: "error",
        });
        expect(lifecycleStatusOnlyError.at(-1)).toMatchObject({
            error: "Chat run failed",
            kind: "finish",
            outcome: "error",
        });
        expect(nestedLifecycleEnd.at(-1)).toMatchObject({
            kind: "finish",
            outcome: "completed",
        });
    });

    it("tracks both OpenClaw compaction lifecycle signal shapes", () => {
        const adapter = new OpenClawChatAdapter();
        const parentStart = adapter.event(
            envelope(
                "agent",
                {
                    phase: "start",
                    runId: "parent-chat-run",
                    stream: "lifecycle",
                },
                52
            )
        );
        const sessionStart = adapter.event(
            envelope(
                "session.compaction",
                {
                    operation: "compact",
                    operationId: "compact-operation",
                    phase: "start",
                    runId: undefined,
                },
                53
            )
        );
        const sessionEnd = adapter.event(
            envelope(
                "session.compaction",
                {
                    operation: "compact",
                    operationId: "compact-operation",
                    phase: "end",
                    runId: undefined,
                },
                54
            )
        );
        const retrying = adapter.event(
            envelope(
                "agent",
                {
                    data: { completed: true, phase: "end", willRetry: true },
                    stream: "compaction",
                },
                55
            )
        );
        const unidentifiedStart = adapter.event(
            envelope(
                "session.compaction",
                {
                    operation: "compact",
                    operationId: undefined,
                    phase: "start",
                    runId: undefined,
                },
                56
            )
        );
        const failedAgentCompaction = adapter.event(
            envelope(
                "agent",
                {
                    data: { phase: "error", status: "failed" },
                    stream: "compaction",
                },
                57
            )
        );
        const failedSessionCompaction = adapter.event(
            envelope(
                "session.compaction",
                {
                    operation: "compact",
                    phase: "failed",
                    runId: undefined,
                    status: "failed",
                },
                58
            )
        );
        const nestedAgentStart = adapter.event(
            envelope(
                "agent",
                {
                    data: {
                        operationId: "nested-compact-operation",
                        phase: "start",
                        stream: "compaction",
                    },
                    runId: "parent-chat-run",
                    stream: undefined,
                },
                59
            )
        );
        const nestedAgentEnd = adapter.event(
            envelope(
                "agent",
                {
                    data: {
                        completed: true,
                        operationId: "nested-compact-operation",
                        phase: "end",
                        stream: "compaction",
                    },
                    runId: "parent-chat-run",
                    stream: undefined,
                },
                60
            )
        );
        const failedRetrying = adapter.event(
            envelope(
                "agent",
                {
                    data: { phase: "error", status: "failed", willRetry: true },
                    stream: "compaction",
                },
                61
            )
        );

        expect(sessionStart[0]).toMatchObject({
            kind: "status",
            operation: "compact",
            operationPhase: "active",
            runId: "compaction:compact-operation",
        });
        expect(sessionEnd[0]).toMatchObject({
            kind: "status",
            operation: "compact",
            operationPhase: "complete",
            runId: "compaction:compact-operation",
        });
        expect(retrying[0]).toMatchObject({
            kind: "status",
            operationPhase: "retrying",
            runId: "compaction:run-variants",
            text: "Compacting context",
        });
        expect(failedRetrying[0]).toMatchObject({
            kind: "status",
            operationPhase: "retrying",
            runId: "compaction:run-variants",
            text: "Compacting context",
        });
        expect(unidentifiedStart[0]).toMatchObject({
            kind: "status",
            operationPhase: "active",
            runId: `compaction:${SESSION}`,
        });
        expect(failedAgentCompaction[0]).toMatchObject({
            kind: "status",
            operation: "compact",
            operationPhase: "inactive",
            text: undefined,
        });
        expect(failedSessionCompaction[0]).toMatchObject({
            kind: "status",
            operation: "compact",
            operationPhase: "inactive",
            text: undefined,
        });
        expect(nestedAgentStart[0]).toMatchObject({
            kind: "status",
            operation: "compact",
            operationPhase: "active",
            runId: "compaction:nested-compact-operation",
        });
        expect(nestedAgentEnd[0]).toMatchObject({
            kind: "status",
            operation: "compact",
            operationPhase: "complete",
            runId: "compaction:nested-compact-operation",
        });
        const nestedCompactionRuntime = reduceChatRuntime(createChatRuntimeState(), [
            ...parentStart,
            ...nestedAgentStart,
            ...nestedAgentEnd,
        ]);
        expect(
            nestedCompactionRuntime.sessions[SESSION]?.runs["parent-chat-run"]
        ).toMatchObject({ phase: "active" });
        expect(
            nestedCompactionRuntime.sessions[SESSION]?.runs[
                "compaction:nested-compact-operation"
            ]
        ).toMatchObject({ phase: "completed" });
    });

    it("marks failed structured tool results as errors", () => {
        const adapter = new OpenClawChatAdapter();
        const events = adapter.event(
            envelope(
                "session.tool",
                {
                    data: {
                        id: "failed-call",
                        name: "exec",
                        phase: "result",
                        result: { exitCode: 1, status: "failed" },
                    },
                    stream: "tool",
                },
                56
            )
        );
        const toolEvent = events.find((event) => event.kind === "tool");

        expect(toolEvent?.kind === "tool" && toolEvent.message.toolResult?.isError).toBe(
            true
        );
    });

    it("renders a coalesced replay tool with the same input and result", () => {
        const adapter = new OpenClawChatAdapter();
        const events = adapter.event(
            envelope(
                "session.tool",
                {
                    data: {
                        args: { command: "printf ready" },
                        itemId: "coalesced-call",
                        name: "bash",
                        phase: "result",
                        result: { exitCode: 0, status: "completed" },
                        toolCallId: "coalesced-call",
                    },
                    stream: "tool",
                },
                57
            )
        );
        const toolEvent = events.find((event) => event.kind === "tool");

        expect(toolEvent).toMatchObject({
            kind: "tool",
            message: {
                toolCalls: [
                    {
                        arguments: { command: "printf ready" },
                        id: "coalesced-call",
                        name: "bash",
                        toolResult: {
                            content: expect.stringContaining('"exitCode": 0'),
                            isError: false,
                        },
                    },
                ],
            },
        });
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
