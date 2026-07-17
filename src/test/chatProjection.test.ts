import { describe, expect, it } from "bun:test";

import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import {
    createChatVisibility,
    presentChatMessages,
} from "../components/features/chat/domain/chatPresentation";
import {
    projectChat,
    reconcileChatMessages,
} from "../components/features/chat/domain/chatProjection";
import {
    addOptimisticChatRun,
    type ChatRuntimeEvent,
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

function event(sequence: number, draft: EventDraft): ChatRuntimeEvent {
    return {
        ...draft,
        sequence,
        sessionKey: SESSION,
        timestamp: NOW,
    } as ChatRuntimeEvent;
}

function eventAt(
    sequence: number,
    timestamp: string,
    draft: EventDraft
): ChatRuntimeEvent {
    return { ...event(sequence, draft), timestamp };
}

function message(role: string, text: string, runId?: string): ChatHistoryMessage {
    return { content: text, role, runId, text };
}

function thinkingMessage(runId: string): ChatHistoryMessage {
    return {
        content: [{ text: "same reasoning", type: "thinking" }],
        role: "assistant",
        runId,
        text: "",
        thinking: [{ text: "same reasoning" }],
    };
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

describe("chat projection", () => {
    it("keeps a completed runtime answer in its turn when a follow-up starts", () => {
        const history = [
            {
                ...message("user", "first"),
                timestamp: "2026-07-16T11:59:00.000Z",
            },
            {
                ...message("user", "follow-up"),
                local: true,
                timestamp: "2026-07-16T12:01:00.000Z",
            },
        ];
        const completed = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "finish",
                message: message("assistant", "first answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const runtime = addOptimisticChatRun(
            completed,
            SESSION,
            "dashboard-chat-follow-up"
        );

        expect(
            reconcileChatMessages(history, runtime.sessions[SESSION]).map(
                (item) => item.text
            )
        ).toEqual(["first", "first answer", "follow-up"]);

        const canonicalHistory = [
            history[0]!,
            {
                ...message("assistant", "first answer"),
                timestamp: "2026-07-16T12:00:30.000Z",
            },
            history[1]!,
        ];
        expect(
            reconcileChatMessages(canonicalHistory, runtime.sessions[SESSION]).map(
                (item) => item.text
            )
        ).toEqual(["first", "first answer", "follow-up"]);
    });

    it("matches a recovered final only inside the latest user turn", () => {
        const history = [
            message("user", "first"),
            message("assistant", "OK"),
            message("user", "second"),
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "finish",
                message: message("assistant", "OK", "run-2"),
                outcome: "completed",
                runId: "run-2",
            }),
        ]);

        expect(
            reconcileChatMessages(history, runtime.sessions[SESSION]).map(
                (item) => item.text
            )
        ).toEqual(["first", "OK", "second", "OK"]);
    });

    it("keeps identical answers from distinct overlapping runs", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: message("assistant", "same", "run-1"),
                mode: "merge",
                runId: "run-1",
                source: "chat",
            }),
            event(32, {
                kind: "assistant",
                message: message("assistant", "same", "run-2"),
                mode: "merge",
                runId: "run-2",
                source: "chat",
            }),
            event(48, {
                kind: "finish",
                message: message("assistant", "same", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
            event(64, {
                kind: "finish",
                message: message("assistant", "same", "run-2"),
                outcome: "completed",
                runId: "run-2",
            }),
        ]);

        const reconciled = reconcileChatMessages(
            [message("user", "parallel")],
            runtime.sessions[SESSION]
        );
        expect(reconciled.map((item) => [item.text, item.runId])).toEqual([
            ["parallel", undefined],
            ["same", "run-1"],
            ["same", "run-2"],
        ]);
    });

    it("keeps identical diagnostics from distinct overlapping runs", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: thinkingMessage("run-1"),
                runId: "run-1",
            }),
            event(32, {
                kind: "thinking",
                message: thinkingMessage("run-2"),
                runId: "run-2",
            }),
        ]);

        const reconciled = reconcileChatMessages(
            [message("user", "parallel")],
            runtime.sessions[SESSION]
        );
        expect(
            reconciled
                .filter((item) => item.thinking?.[0]?.text === "same reasoning")
                .map((item) => item.runId)
        ).toEqual(["run-1", "run-2"]);
    });

    it("groups all thinking items for one run while keeping activity visible", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, { kind: "status", runId: "run-1", text: "Working" }),
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "first", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "first" }],
                },
                runId: "run-1",
            }),
            event(32, {
                kind: "thinking",
                message: {
                    content: [{ text: "second", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-2", text: "second" }],
                },
                runId: "run-1",
            }),
        ]);

        const projection = projectChat(
            [message("user", "question")],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const thinkingRows = projection.rows.filter(
            (row) => (row.message.thinking?.length || 0) > 0
        );

        expect(thinkingRows).toHaveLength(1);
        expect(thinkingRows[0]?.message.thinking?.map((block) => block.text)).toEqual([
            "first",
            "second",
        ]);
        expect(projection.rows.at(-1)).toMatchObject({
            kind: "typing",
            message: { text: "Working" },
        });
    });

    it("moves active-run thinking below a live steer message", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:01.000Z", {
                kind: "status",
                runId: "run-1",
                text: "Thinking",
            }),
            eventAt(32, "2026-07-16T12:06:00.000Z", {
                kind: "thinking",
                message: {
                    content: [{ text: "after steer", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "after steer" }],
                },
                runId: "run-1",
            }),
        ]);
        const history = [
            { ...message("user", "first"), timestamp: "2026-07-16T12:00:00.000Z" },
            { ...message("user", "steer"), timestamp: "2026-07-16T12:05:00.000Z" },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
        const projection = projectChat(
            history,
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(reconciled.map((item) => item.text)).toEqual(["first", "steer", ""]);
        expect(reconciled[2]?.thinking?.[0]?.text).toBe("after steer");
        expect(projection.rows.at(-1)).toMatchObject({
            kind: "typing",
            message: { text: "Thinking" },
        });
    });

    it("places compaction thinking below a prompt persisted just after run start", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:05:37.641Z", {
                kind: "thinking",
                message: {
                    content: [{ text: "compacting", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "compacting" }],
                },
                runId: "compact-run",
            }),
        ]);
        const history = [
            { ...message("user", "previous"), timestamp: "2026-07-16T12:00:00.000Z" },
            {
                ...message("user", "Extract key decisions"),
                timestamp: "2026-07-16T12:05:37.764Z",
            },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled.map((item) => item.text)).toEqual([
            "previous",
            "Extract key decisions",
            "",
        ]);
        expect(reconciled[2]?.thinking?.[0]?.text).toBe("compacting");
    });

    it("keeps completed runs in terminal order after a delayed diagnostic", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "finish",
                message: message("assistant", "first", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
            event(32, {
                kind: "finish",
                message: message("assistant", "second", "run-2"),
                outcome: "completed",
                runId: "run-2",
            }),
            event(48, {
                kind: "thinking",
                message: thinkingMessage("run-1"),
                runId: "run-1",
            }),
        ]);

        const reconciled = reconcileChatMessages(
            [message("user", "question")],
            runtime.sessions[SESSION]
        );

        expect(
            reconciled
                .filter((item) => item.role === "assistant" && item.text)
                .map((item) => item.text)
        ).toEqual(["first", "second"]);
    });

    it("keeps repeated no-id tool invocations distinct within one run", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            noIdToolCall(16),
            noIdToolResult(32, "first"),
            noIdToolCall(48),
            noIdToolResult(64, "second"),
        ]);

        const projection = projectChat(
            [message("user", "run twice")],
            runtime,
            SESSION,
            createChatVisibility(false, true),
            false,
            new Set()
        );
        const toolRows = projection.rows.filter((row) => row.message.toolCalls?.length);

        expect(toolRows).toHaveLength(2);
        expect(
            toolRows.map((row) => row.message.toolCalls?.[0]?.toolResult?.content)
        ).toEqual(["first", "second"]);
        expect(new Set(toolRows.map((row) => row.key)).size).toBe(2);
    });

    it("inserts unrecovered diagnostics immediately before a canonical final", () => {
        const history = [
            message("user", "question"),
            message("assistant", "answer", "run-1"),
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "reasoning", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "reasoning" }],
                },
                runId: "run-1",
            }),
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "call-1", name: "read" }],
                },
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
            event(48, {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled).toHaveLength(4);
        expect(reconciled[1]?.toolCalls?.[0]?.id).toBe("call-1");
        expect(reconciled[2]?.thinking?.[0]?.text).toBe("reasoning");
        expect(reconciled[3]?.text).toBe("answer");
    });

    it("places diagnostics before an unscoped history final when finish has no text", () => {
        const history = [message("user", "question"), message("assistant", "answer")];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "reasoning", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "reasoning" }],
                },
                runId: "run-1",
            }),
            event(32, {
                kind: "finish",
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
        expect(reconciled.map((item) => item.text)).toEqual(["question", "", "answer"]);
        expect(reconciled[1]?.thinking?.[0]?.text).toBe("reasoning");
    });

    it("places a detached active tool row before its later unscoped final", () => {
        const history = [
            { ...message("user", "question"), timestamp: "2026-07-16T12:00:00.000Z" },
            { ...message("assistant", "answer"), timestamp: "2026-07-16T12:02:41.000Z" },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:02:40.000Z", {
                kind: "tool",
                message: {
                    content: "done",
                    role: "tool",
                    text: "done",
                    toolResult: { content: "done", id: "call-1", name: "exec" },
                },
                runId: "detached-run",
                toolKey: "tool:call-1",
            }),
        ]);

        const projection = projectChat(
            history,
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(projection.rows.map((row) => row.message.text)).toEqual([
            "question",
            "done",
            "answer",
        ]);
        expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
    });

    it("does not replay completed tool diagnostics already present in history", () => {
        const toolDiagnostic: ChatHistoryMessage = {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    arguments: { path: "a" },
                    id: "call-1",
                    name: "read",
                    toolResult: {
                        content: "done",
                        id: "call-1",
                        name: "read",
                    },
                },
            ],
        };
        const history = [
            message("user", "question"),
            toolDiagnostic,
            message("assistant", "answer", "run-1"),
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: toolDiagnostic,
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
            event(32, {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
        expect(
            reconciled.filter((item) => item.toolCalls?.[0]?.id === "call-1")
        ).toHaveLength(1);
    });

    it("keeps hidden tool media inside its originating run and user boundary", () => {
        const toolMedia: ChatHistoryMessage = {
            attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
            content: "",
            role: "tool",
            runId: "run-1",
            text: "",
            toolResult: { content: "", id: "call-1", name: "write" },
        };
        const user = message("user", "next");
        const nextAnswer = message("assistant", "answer", "run-2");

        const visible = presentChatMessages(
            [toolMedia, user, nextAnswer],
            createChatVisibility(true, false)
        );

        expect(visible.map((item) => item.role)).toEqual([
            "assistant",
            "user",
            "assistant",
        ]);
        expect(visible[0]?.runId).toBe("run-1");
        expect(visible[0]?.attachments?.[0]?.fileName).toBe("report.txt");
        expect(visible[2]?.attachments).toEqual(undefined);
    });

    it("merges hidden tool media into the compatible assistant run", () => {
        const visible = presentChatMessages(
            [
                {
                    attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
                    content: "",
                    role: "tool",
                    runId: "run-1",
                    text: "",
                    toolResult: { content: "", name: "write" },
                },
                message("assistant", "done", "run-1"),
            ],
            createChatVisibility(true, false)
        );

        expect(visible).toHaveLength(1);
        expect(visible[0]?.attachments?.[0]?.fileName).toBe("report.txt");
    });

    it("preserves media folded into a hidden assistant tool diagnostic", () => {
        const visible = presentChatMessages(
            [
                {
                    attachments: [
                        { fileName: "generated.txt", id: "generated", kind: "text" },
                    ],
                    content: "",
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "write",
                            toolResult: { content: "", id: "call-1", name: "write" },
                        },
                    ],
                },
                message("assistant", "done", "run-1"),
            ],
            createChatVisibility(true, false)
        );

        expect(visible).toHaveLength(1);
        expect(visible[0]?.attachments?.[0]?.fileName).toBe("generated.txt");
    });

    it("preserves top-level and nested tool images in both visibility modes", () => {
        const toolMessage: ChatHistoryMessage = {
            content: "",
            images: [{ data: "top-level", type: "image" }],
            role: "tool",
            runId: "run-1",
            text: "",
            toolResult: {
                content: "",
                images: [{ data: "nested", type: "image" }],
                name: "generate",
            },
            toolCalls: [
                {
                    name: "generate",
                    toolResult: {
                        content: "",
                        images: [{ data: "nested-call", type: "image" }],
                    },
                },
            ],
        };

        const hidden = presentChatMessages(
            [toolMessage, message("assistant", "done", "run-1")],
            createChatVisibility(true, false)
        );
        expect(hidden).toHaveLength(1);
        expect(hidden[0]?.images?.map((image) => image.data)).toEqual([
            "top-level",
            "nested",
            "nested-call",
        ]);

        const shown = presentChatMessages(
            [toolMessage],
            createChatVisibility(true, true)
        );
        expect(shown).toHaveLength(1);
        expect(shown[0]?.images?.[0]?.data).toBe("top-level");
    });

    it("treats thinking visibility as a reversible projection", () => {
        const raw = [
            message("user", "question"),
            {
                content: [{ text: "reasoning", type: "thinking" }],
                role: "assistant",
                runId: "run-1",
                text: "",
                thinking: [{ text: "reasoning" }],
            },
            message("assistant", "answer", "run-1"),
        ];

        expect(
            presentChatMessages(raw, createChatVisibility(false, true), true).some(
                (item) => item.thinking?.length
            )
        ).toBe(false);
        expect(
            presentChatMessages(raw, createChatVisibility(true, true), true).some(
                (item) => item.thinking?.[0]?.text === "reasoning"
            )
        ).toBe(true);
        expect(
            presentChatMessages(raw, createChatVisibility(true, true), false).some(
                (item) => item.thinking?.length
            )
        ).toBe(false);
    });

    it("projects a single compacting status without mutating messages", () => {
        const runtime = addOptimisticChatRun(
            createChatRuntimeState(),
            SESSION,
            "dashboard-compact-1",
            "compact"
        );
        const projection = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(false, false),
            false,
            new Set()
        );

        expect(projection.isCompacting).toBe(true);
        expect(projection.rows).toEqual([
            expect.objectContaining({
                kind: "typing",
                message: expect.objectContaining({ text: "Compacting context" }),
            }),
        ]);
    });

    it("projects an unambiguous short provider session alias", () => {
        const aliasedEvent = {
            ...event(16, {
                kind: "status",
                runId: "run-1",
                text: "Working",
            }),
            sessionKey: "main",
        } as ChatRuntimeEvent;
        const runtime = reduceChatRuntime(createChatRuntimeState(), [aliasedEvent]);

        const projection = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(false, false),
            false,
            new Set()
        );

        expect(projection.activeRuns.map((run) => run.runId)).toEqual(["run-1"]);
        expect(projection.rows[0]?.message.text).toBe("Working");
    });
});
