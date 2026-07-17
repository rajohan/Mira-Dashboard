import { describe, expect, it } from "bun:test";

import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRuntimeEvent,
    clearChatRun,
    createChatRuntimeState,
    reduceChatRuntime,
} from "../components/features/chat/domain/chatState";

const SESSION = "agent:main:main";
const NOW = "2026-07-16T12:00:00.000Z";
type EventDraft = ChatRuntimeEvent extends infer Event
    ? Event extends ChatRuntimeEvent
        ? Omit<Event, "sequence" | "sessionKey" | "timestamp">
        : never
    : never;

function event(sequence: number, value: EventDraft): ChatRuntimeEvent {
    return {
        ...value,
        sequence,
        sessionKey: SESSION,
        timestamp: NOW,
    } as ChatRuntimeEvent;
}

function noIdToolCall(sequence: number): ChatRuntimeEvent {
    return event(sequence, {
        kind: "tool",
        message: {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [{ arguments: { cmd: "date" }, name: "exec" }],
        },
        runId: "run-1",
        toolKey: 'tool:exec:{"cmd":"date"}',
    });
}

function noIdToolResult(sequence: number, content: string): ChatRuntimeEvent {
    return event(sequence, {
        kind: "tool",
        message: {
            content,
            role: "tool",
            text: content,
            toolResult: { content, name: "exec" },
        },
        runId: "run-1",
        toolKey: "tool:exec:undefined",
    });
}

describe("chat runtime state", () => {
    it("keeps duplicate provider run ids scoped to their sessions", () => {
        const first = event(16, {
            kind: "assistant",
            message: { content: "one", role: "assistant", text: "one" },
            mode: "merge",
            runId: "same-run",
            source: "chat",
        });
        const second = {
            ...first,
            message: { content: "two", role: "assistant", text: "two" },
            sequence: 32,
            sessionKey: "agent:other:main",
        } as ChatRuntimeEvent;

        const state = reduceChatRuntime(createChatRuntimeState(), [first, second]);

        expect(state.sessions[SESSION]?.runs["same-run"]?.assistant?.text).toBe("one");
        expect(
            state.sessions["agent:other:main"]?.runs["same-run"]?.assistant?.text
        ).toBe("two");
    });

    it("promotes optimistic aliases and clears a failed send by either id", () => {
        const optimistic = addOptimisticChatRun(
            createChatRuntimeState(),
            SESSION,
            "dashboard-chat-1"
        );
        const acknowledged = acknowledgeChatRun(
            optimistic,
            SESSION,
            "dashboard-chat-1",
            "provider-1"
        );

        expect(acknowledged.sessions[SESSION]?.runs["provider-1"]?.aliases).toEqual([
            "dashboard-chat-1",
            "provider-1",
        ]);
        expect(
            clearChatRun(acknowledged, SESSION, "dashboard-chat-1").sessions[SESSION]
                ?.runs
        ).toEqual({});
    });

    it("acknowledges a recovered run through its optimistic alias", () => {
        const recovered = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "status",
                text: "Working",
            }),
        ]);
        const optimistic = addOptimisticChatRun(recovered, SESSION, "dashboard-chat-1");
        const aliased = acknowledgeChatRun(
            optimistic,
            SESSION,
            "dashboard-chat-1",
            "runtime-runless-16"
        );
        const acknowledged = acknowledgeChatRun(
            aliased,
            SESSION,
            "dashboard-chat-1",
            "provider-1"
        );

        expect(Object.keys(acknowledged.sessions[SESSION]?.runs || {})).toEqual([
            "provider-1",
        ]);
        expect(acknowledged.sessions[SESSION]?.runs["provider-1"]?.statusText).toBe(
            "Working"
        );
    });

    it("retains compact operation when provider events arrive before acknowledgement", () => {
        const providerFirst = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "status",
                runId: "provider-1",
                text: "Working",
            }),
        ]);
        const optimistic = addOptimisticChatRun(
            providerFirst,
            SESSION,
            "dashboard-compact-1",
            "compact"
        );
        const acknowledged = acknowledgeChatRun(
            optimistic,
            SESSION,
            "dashboard-compact-1",
            "provider-1"
        );

        expect(acknowledged.sessions[SESSION]?.runs["provider-1"]?.operation).toBe(
            "compact"
        );
    });

    it("keeps recovered deltas when an optimistic begin is repeated", () => {
        const recovered = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: { content: "working", role: "assistant", text: "working" },
                mode: "merge",
                runId: "dashboard-compact-recovered",
                source: "runtime",
            }),
        ]);

        const repeated = addOptimisticChatRun(
            recovered,
            SESSION,
            "dashboard-compact-recovered",
            "compact"
        );

        expect(
            repeated.sessions[SESSION]?.runs["dashboard-compact-recovered"]
        ).toMatchObject({
            assistant: { text: "working" },
            operation: "compact",
            phase: "active",
        });
    });

    it("merges optimistic payloads into an existing provider run", () => {
        const providerFirst = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: { content: "Hel", role: "assistant", text: "Hel" },
                mode: "append",
                runId: "provider-1",
                source: "runtime",
            }),
        ]);
        const withOptimistic = addOptimisticChatRun(
            providerFirst,
            SESSION,
            "dashboard-chat-1"
        );
        const accumulated = reduceChatRuntime(withOptimistic, [
            event(32, {
                kind: "assistant",
                message: { content: "lo", role: "assistant", text: "lo" },
                mode: "append",
                runId: "dashboard-chat-1",
                source: "runtime",
            }),
            event(48, {
                kind: "thinking",
                message: {
                    content: [{ text: "reasoning", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "reasoning" }],
                },
                runId: "dashboard-chat-1",
            }),
            event(64, {
                error: "late failure",
                kind: "finish",
                outcome: "error",
                runId: "dashboard-chat-1",
            }),
        ]);

        const acknowledged = acknowledgeChatRun(
            accumulated,
            SESSION,
            "dashboard-chat-1",
            "provider-1"
        );
        const run = acknowledged.sessions[SESSION]?.runs["provider-1"];

        expect(Object.keys(acknowledged.sessions[SESSION]?.runs || {})).toEqual([
            "provider-1",
        ]);
        expect(run).toMatchObject({
            assistant: { text: "Hello" },
            error: "late failure",
            lastSequence: 64,
            phase: "error",
        });
        expect(run?.aliases).toEqual(
            expect.arrayContaining(["dashboard-chat-1", "provider-1"])
        );
        expect(run?.diagnostics[0]?.message.thinking?.[0]?.text).toBe("reasoning");
    });

    it("keeps newer provider terminal metadata while merging optimistic diagnostics", () => {
        const providerFirst = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "status",
                runId: "provider-1",
                text: "Working",
            }),
        ]);
        const withOptimistic = addOptimisticChatRun(
            providerFirst,
            SESSION,
            "dashboard-chat-1"
        );
        const accumulated = reduceChatRuntime(withOptimistic, [
            event(32, {
                kind: "thinking",
                message: {
                    content: [{ text: "reasoning", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "reasoning" }],
                },
                runId: "dashboard-chat-1",
            }),
            event(48, {
                authoritative: true,
                kind: "finish",
                message: {
                    content: "done",
                    role: "assistant",
                    text: "done",
                },
                outcome: "completed",
                runId: "provider-1",
            }),
        ]);

        const acknowledged = acknowledgeChatRun(
            accumulated,
            SESSION,
            "dashboard-chat-1",
            "provider-1"
        );

        expect(acknowledged.sessions[SESSION]?.runs["provider-1"]).toMatchObject({
            assistant: { text: "done" },
            error: undefined,
            lastSequence: 48,
            phase: "completed",
            statusText: undefined,
        });
        expect(
            acknowledged.sessions[SESSION]?.runs["provider-1"]?.diagnostics[0]?.message
                .thinking?.[0]?.text
        ).toBe("reasoning");
    });

    it("reconciles a tool call and result split across acknowledged run aliases", () => {
        const providerFirst = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ arguments: { cmd: "date" }, name: "exec" }],
                },
                runId: "provider-1",
                toolKey: 'tool:exec:{"cmd":"date"}',
            }),
        ]);
        const withOptimistic = addOptimisticChatRun(
            providerFirst,
            SESSION,
            "dashboard-chat-1"
        );
        const accumulated = reduceChatRuntime(withOptimistic, [
            event(32, {
                kind: "tool",
                message: {
                    content: "Thu",
                    role: "tool",
                    text: "Thu",
                    toolResult: { content: "Thu", name: "exec" },
                },
                runId: "dashboard-chat-1",
                toolKey: "tool:exec:undefined",
            }),
        ]);

        const acknowledged = acknowledgeChatRun(
            accumulated,
            SESSION,
            "dashboard-chat-1",
            "provider-1"
        );
        const diagnostics =
            acknowledged.sessions[SESSION]?.runs["provider-1"]?.diagnostics;

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics?.[0]?.message.toolCalls?.[0]).toMatchObject({
            name: "exec",
            toolResult: { content: "Thu" },
        });
    });

    it("deduplicates replayed sequences and accepts the selected text source", () => {
        const runtime = event(16, {
            kind: "assistant",
            message: { content: "Hel", role: "assistant", text: "Hel" },
            mode: "append",
            runId: "run-1",
            source: "runtime",
        });
        const mirrored = event(17, {
            kind: "assistant",
            message: { content: "Hello", role: "assistant", text: "Hello" },
            mode: "merge",
            runId: "run-1",
            source: "chat",
        });
        const continuation = event(32, {
            kind: "assistant",
            message: { content: "lo", role: "assistant", text: "lo" },
            mode: "append",
            runId: "run-1",
            source: "runtime",
        });

        const state = reduceChatRuntime(createChatRuntimeState(), [
            runtime,
            mirrored,
            runtime,
            continuation,
        ]);

        expect(state.sessions[SESSION]?.runs["run-1"]?.assistant?.text).toBe("Hello");
    });

    it("lets the canonical final replace a mirrored runtime buffer", () => {
        const state = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: {
                    content: "runtime draft",
                    role: "assistant",
                    text: "runtime draft",
                },
                mode: "replace",
                runId: "run-1",
                source: "runtime",
            }),
            event(32, {
                kind: "finish",
                message: {
                    content: "canonical final",
                    role: "assistant",
                    text: "canonical final",
                },
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const run = state.sessions[SESSION]?.runs["run-1"];
        expect(run?.assistant?.text).toBe("canonical final");
        expect(run?.assistantSource).toBe("chat");
        expect(run?.phase).toBe("completed");

        const lateSessionUpdate = reduceChatRuntime(state, [
            event(48, {
                kind: "assistant",
                message: {
                    content: "different session copy",
                    role: "assistant",
                    text: "different session copy",
                },
                mode: "merge",
                runId: "run-1",
                source: "session",
            }),
        ]);
        expect(lateSessionUpdate.sessions[SESSION]?.runs["run-1"]?.assistant?.text).toBe(
            "canonical final"
        );
    });

    it("merges a no-id tool result into its latest matching call", () => {
        const state = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ arguments: { cmd: "date" }, name: "exec" }],
                },
                runId: "run-1",
                toolKey: 'tool:exec:{"cmd":"date"}',
            }),
            event(32, {
                kind: "tool",
                message: {
                    content: "Thu",
                    role: "tool",
                    text: "Thu",
                    toolResult: { content: "Thu", name: "exec" },
                },
                runId: "run-1",
                toolKey: "tool:exec:undefined",
            }),
        ]);

        const diagnostics = state.sessions[SESSION]?.runs["run-1"]?.diagnostics;
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics?.[0]?.message.toolCalls?.[0]?.toolResult?.content).toBe("Thu");
    });

    it("keeps repeated no-id tool invocations distinct", () => {
        const state = reduceChatRuntime(createChatRuntimeState(), [
            noIdToolCall(16),
            noIdToolResult(32, "first"),
            noIdToolCall(48),
            noIdToolResult(64, "second"),
        ]);

        const diagnostics = state.sessions[SESSION]?.runs["run-1"]?.diagnostics;
        expect(diagnostics).toHaveLength(2);
        expect(
            diagnostics?.map((entry) => entry.message.toolCalls?.[0]?.toolResult?.content)
        ).toEqual(["first", "second"]);
        expect(new Set(diagnostics?.map((entry) => entry.key)).size).toBe(2);
    });

    it("retains a completed turn while the next run starts", () => {
        const completed = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "finish",
                outcome: "completed",
                runId: "old-run",
            }),
        ]);
        const next = reduceChatRuntime(completed, [
            event(32, {
                kind: "status",
                runId: "new-run",
                text: "Thinking",
            }),
        ]);

        expect(next.sessions[SESSION]?.runs["old-run"]?.phase).toBe("completed");
        expect(next.sessions[SESSION]?.runs["new-run"]?.phase).toBe("active");

        const optimistic = addOptimisticChatRun(
            completed,
            SESSION,
            "dashboard-chat-next"
        );
        expect(optimistic.sessions[SESSION]?.runs["old-run"]?.phase).toBe("completed");
        expect(optimistic.sessions[SESSION]?.runs["dashboard-chat-next"]?.phase).toBe(
            "active"
        );
    });

    it("normalizes unambiguous provider session aliases without crossing agents", () => {
        const optimistic = addOptimisticChatRun(
            createChatRuntimeState(),
            SESSION,
            "dashboard-chat-1"
        );
        const aliasedEvent = {
            ...event(16, {
                kind: "assistant",
                message: { content: "done", role: "assistant", text: "done" },
                mode: "merge",
                runId: "provider-1",
                source: "chat",
            }),
            sessionKey: "main",
        } as ChatRuntimeEvent;
        const normalized = reduceChatRuntime(optimistic, [aliasedEvent]);

        expect(normalized.sessions.main).toBeUndefined();
        expect(normalized.sessions[SESSION]?.runs["provider-1"]?.assistant?.text).toBe(
            "done"
        );

        const shortOptimistic = addOptimisticChatRun(
            optimistic,
            "main",
            "dashboard-chat-short"
        );
        expect(shortOptimistic.sessions.main).toBeUndefined();
        expect(shortOptimistic.sessions[SESSION]?.runs).toMatchObject({
            "dashboard-chat-1": { sessionKey: SESSION },
            "dashboard-chat-short": { sessionKey: SESSION },
        });

        const ambiguous = reduceChatRuntime(
            reduceChatRuntime(createChatRuntimeState(), [
                event(16, {
                    kind: "status",
                    runId: "main-run",
                    text: "main",
                }),
                {
                    ...event(32, {
                        kind: "status",
                        runId: "other-run",
                        text: "other",
                    }),
                    sessionKey: "agent:other:main",
                } as ChatRuntimeEvent,
            ]),
            [
                {
                    ...event(48, {
                        kind: "status",
                        runId: "short-run",
                        text: "short",
                    }),
                    sessionKey: "main",
                } as ChatRuntimeEvent,
            ]
        );
        expect(ambiguous.sessions.main?.runs["short-run"]?.statusText).toBe("short");
        expect(ambiguous.sessions[SESSION]?.runs["short-run"]).toBeUndefined();
        expect(ambiguous.sessions["agent:other:main"]?.runs["short-run"]).toBeUndefined();
    });

    it("rekeys a short provider session when its full identity becomes known", () => {
        const shortFirst = reduceChatRuntime(createChatRuntimeState(), [
            {
                ...event(16, { kind: "status", runId: "run-1", text: "short" }),
                sessionKey: "main",
            } as ChatRuntimeEvent,
        ]);
        const providerRekeyed = reduceChatRuntime(shortFirst, [
            event(32, {
                kind: "assistant",
                message: { content: "answer", role: "assistant", text: "answer" },
                mode: "merge",
                runId: "run-1",
                source: "chat",
            }),
        ]);
        expect(providerRekeyed.sessions.main).toBeUndefined();
        expect(providerRekeyed.sessions[SESSION]?.runs["run-1"]?.assistant?.text).toBe(
            "answer"
        );

        const optimisticRekeyed = addOptimisticChatRun(
            shortFirst,
            SESSION,
            "dashboard-chat-2"
        );
        expect(optimisticRekeyed.sessions.main).toBeUndefined();
        expect(Object.keys(optimisticRekeyed.sessions[SESSION]?.runs || {})).toEqual([
            "run-1",
            "dashboard-chat-2",
        ]);

        const acknowledgedRekeyed = acknowledgeChatRun(
            addOptimisticChatRun(createChatRuntimeState(), "main", "dashboard-chat-3"),
            SESSION,
            "dashboard-chat-3",
            "provider-3"
        );
        expect(acknowledgedRekeyed.sessions.main).toBeUndefined();
        expect(acknowledgedRekeyed.sessions[SESSION]?.runs["provider-3"]?.runId).toBe(
            "provider-3"
        );
    });

    it("creates and reuses a provisional run for runless events", () => {
        const state = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "working" }],
                },
            }),
            event(32, {
                kind: "finish",
                message: {
                    content: "done",
                    role: "assistant",
                    text: "done",
                },
                outcome: "completed",
            }),
        ]);

        const runs = Object.values(state.sessions[SESSION]?.runs || {});
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
            assistant: { text: "done" },
            phase: "completed",
            runId: "runtime-runless-16",
        });
        expect(runs[0]?.diagnostics[0]?.message.thinking?.[0]?.text).toBe("working");
    });

    it("keeps a concrete final when a runless terminal event follows it", () => {
        const state = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "finish",
                message: {
                    content: "done",
                    role: "assistant",
                    text: "done",
                },
                outcome: "completed",
                runId: "run-1",
            }),
            event(32, {
                kind: "finish",
                outcome: "completed",
            }),
        ]);

        const runs = Object.values(state.sessions[SESSION]?.runs || {});
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
            assistant: { text: "done" },
            lastSequence: 32,
            phase: "completed",
            runId: "run-1",
        });
    });

    it("keeps a matching runless session echo on the completed run", () => {
        const completed = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                authoritative: true,
                kind: "finish",
                message: {
                    content: "OK",
                    role: "assistant",
                    text: "OK",
                },
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const echoed = reduceChatRuntime(completed, [
            event(32, {
                kind: "assistant",
                message: { content: " OK ", role: "assistant", text: " OK " },
                mode: "merge",
                source: "session",
            }),
        ]);

        expect(echoed.sessions[SESSION]?.runs).toEqual({
            "run-1": expect.objectContaining({
                assistant: expect.objectContaining({ text: "OK" }),
                lastSequence: 32,
                phase: "completed",
            }),
        });

        const withFollowUp = addOptimisticChatRun(
            completed,
            SESSION,
            "dashboard-chat-follow-up"
        );
        const lateEcho = reduceChatRuntime(withFollowUp, [
            event(32, {
                kind: "assistant",
                message: { content: "OK", role: "assistant", text: "OK" },
                mode: "merge",
                source: "session",
            }),
        ]);
        expect(lateEcho.sessions[SESSION]?.runs["run-1"]?.lastSequence).toBe(32);
        expect(
            lateEcho.sessions[SESSION]?.runs["dashboard-chat-follow-up"]?.assistant
        ).toBeUndefined();

        const delayedEcho = {
            ...event(48, {
                kind: "assistant",
                message: { content: "OK", role: "assistant", text: "OK" },
                mode: "merge",
                source: "session",
            }),
            timestamp: "2026-07-16T12:02:00.000Z",
        } as ChatRuntimeEvent;
        const nextTurn = reduceChatRuntime(echoed, [delayedEcho]);
        expect(nextTurn.sessions[SESSION]?.runs["run-1"]?.phase).toBe("completed");
        expect(nextTurn.sessions[SESSION]?.runs["runtime-runless-48"]).toMatchObject({
            assistant: { text: "OK" },
            phase: "active",
        });

        const differentImmediateMessage = reduceChatRuntime(completed, [
            event(48, {
                kind: "assistant",
                message: { content: "Different", role: "assistant", text: "Different" },
                mode: "merge",
                source: "session",
            }),
        ]);
        expect(
            differentImmediateMessage.sessions[SESSION]?.runs["runtime-runless-48"]
        ).toMatchObject({
            assistant: { text: "Different" },
            phase: "active",
        });
    });

    it("keeps an attachment-only session echo on its completed run", () => {
        const attachment = {
            fileName: "report.pdf",
            id: "report",
            kind: "file" as const,
            mimeType: "application/pdf",
        };
        const completed = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                authoritative: true,
                kind: "finish",
                message: {
                    attachments: [attachment],
                    content: "",
                    role: "assistant",
                    text: "",
                },
                outcome: "completed",
                runId: "run-media",
            }),
        ]);
        const echoed = reduceChatRuntime(completed, [
            event(32, {
                kind: "assistant",
                message: {
                    attachments: [attachment],
                    content: "",
                    role: "assistant",
                    text: "",
                },
                mode: "merge",
                source: "session",
            }),
        ]);

        expect(echoed.sessions[SESSION]?.runs).toEqual({
            "run-media": expect.objectContaining({
                assistant: expect.objectContaining({ attachments: [attachment] }),
                phase: "completed",
            }),
        });
    });

    it("does not let metadata completion overwrite a terminal error", () => {
        const state = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                error: "model failed",
                kind: "finish",
                outcome: "error",
                runId: "run-1",
            }),
            event(32, {
                kind: "finish",
                outcome: "completed",
            }),
        ]);

        expect(state.sessions[SESSION]?.runs["run-1"]).toMatchObject({
            error: "model failed",
            lastSequence: 32,
            phase: "error",
        });
    });

    it("lets an authoritative final replace an earlier terminal state", () => {
        const state = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                error: "transient failure",
                kind: "finish",
                outcome: "error",
                runId: "run-1",
            }),
            event(32, {
                authoritative: true,
                kind: "finish",
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        expect(state.sessions[SESSION]?.runs["run-1"]).toMatchObject({
            error: undefined,
            phase: "completed",
        });
    });
});
