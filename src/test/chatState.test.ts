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
        expect(run?.phase).toBe("completed");
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

    it("drops a completed turn when the next run starts", () => {
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

        expect(next.sessions[SESSION]?.runs["old-run"]).toBeUndefined();
        expect(next.sessions[SESSION]?.runs["new-run"]?.phase).toBe("active");
    });
});
