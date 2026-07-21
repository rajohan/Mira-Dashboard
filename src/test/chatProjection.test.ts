import { describe, expect, it } from "bun:test";

import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import {
    messageDeleteKey,
    stableChatStringify,
} from "../components/features/chat/chatUtilities";
import {
    createChatVisibility,
    presentChatMessages,
} from "../components/features/chat/domain/chatPresentation";
import {
    projectChat,
    reconcileChatMessages,
} from "../components/features/chat/domain/chatProjection";
import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRuntimeEvent,
    type ChatSessionRuntimeState,
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

function recoveredNoIdTool(timestamp: string): ChatHistoryMessage {
    return {
        content: "",
        role: "assistant",
        text: "",
        timestamp,
        toolCalls: [
            {
                arguments: { cmd: "date" },
                name: "exec",
                toolResult: { content: "same", name: "exec" },
            },
        ],
    };
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

    it("anchors repeated unscoped final text to the matching terminal timestamp", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:01.000Z", {
                kind: "finish",
                message: {
                    ...message("assistant", "same", "run-1"),
                    thinking: [{ text: "terminal detail" }],
                },
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const history = [
            {
                ...message("user", "first"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message("assistant", "same"),
                timestamp: "2026-07-16T12:00:01.000Z",
            },
            {
                ...message("user", "second"),
                timestamp: "2026-07-16T12:00:02.000Z",
            },
            {
                ...message("assistant", "same"),
                timestamp: "2026-07-16T12:00:10.000Z",
            },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled[1]?.thinking?.[0]?.text).toBe("terminal detail");
        expect(reconciled[3]?.thinking).toBeUndefined();
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

    it("does not claim an earlier final while scoping later run diagnostics", () => {
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "parallel"),
                timestamp: "2026-07-16T11:59:59.000Z",
            },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-16T12:00:00.000Z",
                toolCalls: [{ id: "call-old", name: "bash" }],
            },
            {
                ...message("assistant", "older answer"),
                timestamp: "2026-07-16T12:00:01.000Z",
            },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-16T12:00:02.000Z",
                toolCalls: [{ id: "call-new", name: "bash" }],
            },
            {
                ...message("assistant", "newer answer"),
                timestamp: "2026-07-16T12:00:03.000Z",
            },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(32, "2026-07-16T12:00:03.000Z", {
                kind: "finish",
                message: message("assistant", "newer answer", "run-new"),
                outcome: "completed",
                runId: "run-new",
            }),
            eventAt(48, "2026-07-16T12:00:01.000Z", {
                kind: "finish",
                message: message("assistant", "older answer", "run-old"),
                outcome: "completed",
                runId: "run-old",
            }),
        ]);

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled.map((item) => [item.text, item.runId])).toEqual([
            ["parallel", undefined],
            ["", "run-old"],
            ["older answer", "run-old"],
            ["", "run-new"],
            ["newer answer", "run-new"],
        ]);
    });

    it("does not let metadata-only completion claim another run final", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(32, "2026-07-16T12:00:04.000Z", {
                kind: "finish",
                outcome: "completed",
                runId: "metadata-only",
            }),
            eventAt(48, "2026-07-16T12:00:03.000Z", {
                kind: "finish",
                message: message("assistant", "answer", "run-real"),
                outcome: "completed",
                runId: "run-real",
            }),
        ]);
        const reconciled = reconcileChatMessages(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T11:59:59.000Z",
                },
                {
                    ...message("assistant", "answer"),
                    timestamp: "2026-07-16T12:00:03.000Z",
                },
            ],
            runtime.sessions[SESSION]
        );

        expect(reconciled.map((item) => [item.text, item.runId])).toEqual([
            ["question", undefined],
            ["answer", "run-real"],
        ]);
    });

    it("does not let diagnostic-only completion claim another run final", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:02.000Z", {
                kind: "thinking",
                message: thinkingMessage("diagnostic-only"),
                runId: "diagnostic-only",
            }),
            eventAt(32, "2026-07-16T12:00:04.000Z", {
                kind: "finish",
                outcome: "completed",
                runId: "diagnostic-only",
            }),
            eventAt(48, "2026-07-16T12:00:03.000Z", {
                kind: "finish",
                message: message("assistant", "answer", "run-real"),
                outcome: "completed",
                runId: "run-real",
            }),
        ]);
        const reconciled = reconcileChatMessages(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T11:59:59.000Z",
                },
                {
                    ...message("assistant", "answer"),
                    timestamp: "2026-07-16T12:00:03.000Z",
                },
            ],
            runtime.sessions[SESSION]
        );

        expect(
            reconciled.filter((item) => item.text === "answer").map((item) => item.runId)
        ).toEqual(["run-real"]);
    });

    it("leaves identical unanchored completed response blocks unscoped", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "thinking",
                message: thinkingMessage("run-old"),
                runId: "run-old",
            }),
            event(32, {
                kind: "finish",
                message: message("assistant", "same", "run-old"),
                outcome: "completed",
                runId: "run-old",
            }),
            event(40, {
                kind: "thinking",
                message: thinkingMessage("run-new"),
                runId: "run-new",
            }),
            event(64, {
                kind: "finish",
                message: message("assistant", "same", "run-new"),
                outcome: "completed",
                runId: "run-new",
            }),
        ]);
        const reconciled = reconcileChatMessages(
            [
                message("user", "parallel"),
                {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "call-old", name: "read" }],
                },
                message("assistant", "same"),
                {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "call-new", name: "read" }],
                },
                message("assistant", "same"),
            ],
            runtime.sessions[SESSION]
        );

        expect(
            reconciled
                .filter((item) => item.toolCalls?.length)
                .map((item) => [item.toolCalls?.[0]?.id, item.runId])
        ).toEqual([
            ["call-old", undefined],
            ["call-new", undefined],
        ]);
        expect(
            reconciled.filter((item) => item.text === "same").map((item) => item.runId)
        ).toEqual([undefined, undefined]);
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

    it("hides activity when the same run already has visible assistant text", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, { kind: "status", runId: "run-1", text: "Working" }),
            event(16, {
                kind: "assistant",
                message: message("assistant", "Streaming answer", "run-1"),
                mode: "merge",
                runId: "run-1",
                source: "chat",
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

        expect(projection.rows).toContainEqual(
            expect.objectContaining({
                kind: "stream",
                message: expect.objectContaining({ text: "Streaming answer" }),
            })
        );
        expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
    });

    it("restores activity when tool work follows visible assistant text", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, { kind: "status", runId: "run-1", text: "Working" }),
            event(16, {
                kind: "assistant",
                message: message("assistant", "I will inspect it.", "run-1"),
                mode: "merge",
                runId: "run-1",
                source: "chat",
            }),
            event(24, {
                kind: "tool",
                message: {
                    content: "I will inspect the repository.",
                    role: "assistant",
                    text: "I will inspect the repository.",
                    toolCalls: [{ id: "call-1", name: "read" }],
                },
                runId: "run-1",
                toolKey: "tool:call-1",
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

        expect(projection.rows.at(-1)).toMatchObject({
            kind: "typing",
            message: { text: "Working" },
        });
    });

    it("keeps optimistic user rows as deletable messages", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "user",
                message: {
                    ...message("user", "steer", "dashboard-chat-steer"),
                    timestamp: NOW,
                },
                runId: "dashboard-chat-steer",
            }),
            event(32, {
                kind: "assistant",
                message: message("assistant", "Working", "run-1"),
                mode: "merge",
                runId: "run-1",
                source: "chat",
            }),
        ]);

        const rows = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        ).rows;

        const userRow = rows.find((row) => row.message.role === "user");
        expect(userRow).toBeDefined();
        const optimisticUserRow = userRow!;
        expect(optimisticUserRow.kind).toBe("message");
        expect(optimisticUserRow.key).toBe(
            messageDeleteKey({
                ...optimisticUserRow.message,
                runId: undefined,
                runtimeKey: undefined,
            })
        );
        expect(rows.find((row) => row.message.role === "assistant")?.kind).toBe("stream");

        const recoveredHistoryMessage = {
            ...message("user", "steer"),
            timestamp: NOW,
        };
        expect(
            projectChat(
                [recoveredHistoryMessage],
                createChatRuntimeState(),
                SESSION,
                createChatVisibility(true, true),
                true,
                new Set([optimisticUserRow.key])
            ).rows
        ).toEqual([]);
    });

    it("keeps a thinking row anchored while runtime output recovers into history", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "same reasoning", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "same reasoning" }],
                },
                runId: "run-1",
            }),
        ]);
        const user = message("user", "question", "run-1");
        const runtimeProjection = projectChat(
            [user],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const recoveredProjection = projectChat(
            [user, thinkingMessage("run-1")],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(
            runtimeProjection.rows.find((row) => row.message.thinking?.length)?.key
        ).toBe("diagnostic-run-1-thinking");
        expect(
            recoveredProjection.rows.find((row) => row.message.thinking?.length)?.key
        ).toBe("diagnostic-run-1-thinking");
    });

    it("keeps the thinking key stable while a new tool moves before it", () => {
        const thinkingRuntime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "working", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "working" }],
                },
                runId: "run-1",
            }),
        ]);
        const before = projectChat(
            [message("user", "question")],
            thinkingRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const withTool = reduceChatRuntime(thinkingRuntime, [
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
        ]);
        const after = projectChat(
            [message("user", "question")],
            withTool,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const thinkingKey = "diagnostic-run-1-thinking";
        const beforeThinkingIndex = before.rows.findIndex(
            (row) => row.key === thinkingKey
        );
        const afterToolIndex = after.rows.findIndex(
            (row) => row.message.toolCalls?.length
        );
        const afterThinkingIndex = after.rows.findIndex((row) => row.key === thinkingKey);

        expect(beforeThinkingIndex).toBeGreaterThanOrEqual(0);
        expect(afterToolIndex).toBeGreaterThanOrEqual(0);
        expect(afterThinkingIndex).toBeGreaterThan(afterToolIndex);
        expect(after.rows[afterThinkingIndex]?.key).toBe(
            before.rows[beforeThinkingIndex]?.key
        );
    });

    it("keeps sibling tool call and result row keys distinct", () => {
        const projection = projectChat(
            [
                {
                    content: "",
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    toolCalls: [{ id: "call-1", name: "exec" }],
                },
                {
                    content: "done",
                    role: "tool",
                    runId: "run-1",
                    text: "done",
                    toolResult: { content: "done", id: "call-1", name: "exec" },
                },
            ],
            createChatRuntimeState(),
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(projection.rows.map((row) => row.key)).toEqual([
            "diagnostic-run-1-tool-call-call-1",
            "diagnostic-run-1-tool-result-call-1",
        ]);
    });

    it("keeps a grouped thinking diagnostic when history recovered only one block", () => {
        const optimistic = addOptimisticChatRun(
            createChatRuntimeState(),
            SESSION,
            "dashboard-chat-original"
        );
        const withThinking = reduceChatRuntime(optimistic, [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "first", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "first" }],
                },
                runId: "provider-run",
            }),
            event(32, {
                kind: "thinking",
                message: {
                    content: [{ text: "second", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-2", text: "second" }],
                },
                runId: "provider-run",
            }),
        ]);
        const runtime = acknowledgeChatRun(
            withThinking,
            SESSION,
            "dashboard-chat-original",
            "provider-run"
        );
        const history = [
            message("user", "question", "dashboard-chat-original"),
            {
                content: [{ text: "first", type: "thinking" }],
                role: "assistant",
                runId: "dashboard-chat-original",
                text: "",
                thinking: [{ text: "first" }],
            },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
        const grouped = reconciled.find(
            (item) => item.local === true && item.runtimeKey === "thinking:primary"
        );
        const projection = projectChat(
            history,
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const thinkingRows = projection.rows.filter(
            (row) => (row.message.thinking?.length || 0) > 0
        );

        expect(grouped?.thinking?.map((block) => block.text)).toEqual([
            "first",
            "second",
        ]);
        expect(thinkingRows).toHaveLength(1);
        expect(thinkingRows[0]?.message.thinking?.map((block) => block.text)).toEqual([
            "first",
            "second",
        ]);
    });

    it("moves active-run thinking below a live steer message", () => {
        const active = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:01.000Z", {
                kind: "status",
                runId: "run-1",
                text: "Thinking",
            }),
            eventAt(32, "2026-07-16T12:04:30.000Z", {
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
        const optimistic = addOptimisticChatRun(
            active,
            SESSION,
            "dashboard-chat-steer-2"
        );
        const history = [
            {
                ...message("user", "first", "run-1"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message("user", "steer", "dashboard-chat-steer-1"),
                timestamp: "2026-07-16T12:04:00.000Z",
            },
            {
                ...message("user", "latest steer", "dashboard-chat-steer-2"),
                timestamp: "2026-07-16T12:05:00.000Z",
            },
        ];

        const reconciled = reconcileChatMessages(history, optimistic.sessions[SESSION]);
        const projection = projectChat(
            history,
            optimistic,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        const latestSteerIndex = reconciled.findIndex(
            (item) => item.text === "latest steer"
        );
        const thinkingIndex = reconciled.findIndex((item) => item.thinking?.length);
        expect(latestSteerIndex).toBeGreaterThanOrEqual(0);
        expect(thinkingIndex).toBeGreaterThan(latestSteerIndex);
        expect(reconciled[thinkingIndex]?.thinking?.[0]?.text).toBe("after steer");
        expect(projection.rows.at(-1)).toMatchObject({
            kind: "typing",
            message: { text: "Thinking" },
        });
    });

    it("moves thinking below a recovered unscoped steer before more work arrives", () => {
        const visible = presentChatMessages(
            [
                message("user", "question", "run-1"),
                {
                    content: [{ thinking: "working", type: "thinking" }],
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    thinking: [{ text: "working" }],
                },
                message("user", "steer without provider run id"),
                message("assistant", "done", "run-1"),
            ],
            createChatVisibility(true, true),
            true
        );

        const steerIndex = visible.findIndex(
            (item) => item.text === "steer without provider run id"
        );
        const thinkingIndex = visible.findIndex((item) => item.thinking?.length);
        const finalIndex = visible.findIndex((item) => item.text === "done");

        expect(thinkingIndex).toBeGreaterThan(steerIndex);
        expect(thinkingIndex).toBeLessThan(finalIndex);
    });

    it("projects an unscoped runtime steer before later run diagnostics", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(8, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId: "run-1",
                text: "Thinking",
            }),
            eventAt(16, "2026-07-16T12:00:10.000Z", {
                kind: "thinking",
                message: {
                    content: [{ text: "working", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "working" }],
                },
                runId: "run-1",
            }),
            eventAt(24, "2026-07-16T12:00:20.000Z", {
                kind: "user",
                message: { content: "steer", role: "user", text: "steer" },
            }),
            eventAt(32, "2026-07-16T12:00:30.000Z", {
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
        ]);
        const question = {
            ...message("user", "question"),
            timestamp: "2026-07-16T11:59:59.000Z",
        };
        const histories = [
            [question],
            [
                question,
                {
                    ...message("user", "steer"),
                    timestamp: "2026-07-16T12:00:20.000Z",
                },
            ],
        ];

        for (const history of histories) {
            const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
            const projected = projectChat(
                history,
                runtime,
                SESSION,
                createChatVisibility(true, true),
                true,
                new Set()
            ).rows.map((row) => row.message);
            expect(reconciled.filter((item) => item.text === "steer")).toHaveLength(1);
            const steerIndex = projected.findIndex((item) => item.text === "steer");
            const thinkingIndex = projected.findIndex((item) => item.thinking?.length);
            const toolIndex = projected.findIndex((item) => item.toolCalls?.length);
            expect(steerIndex).toBeGreaterThan(0);
            expect(thinkingIndex).toBeGreaterThan(steerIndex);
            expect(thinkingIndex).toBeGreaterThan(toolIndex);
            expect(projected[steerIndex]?.runId).toBe("run-1");
        }
    });

    it("matches repeated runtime steers to distinct recovered user messages", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(8, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId: "run-1",
                text: "Thinking",
            }),
            eventAt(16, "2026-07-16T12:00:10.000Z", {
                kind: "user",
                message: { content: "repeat", role: "user", text: "repeat" },
                runId: "run-1",
            }),
            eventAt(24, "2026-07-16T12:00:12.000Z", {
                kind: "user",
                message: { content: "repeat", role: "user", text: "repeat" },
                runId: "run-1",
            }),
        ]);
        const history = [
            {
                ...message("user", "repeat"),
                timestamp: "2026-07-16T12:00:10.000Z",
            },
            {
                ...message("user", "repeat"),
                timestamp: "2026-07-16T12:00:12.000Z",
            },
        ];

        const repeated = reconcileChatMessages(history, runtime.sessions[SESSION]).filter(
            (item) => item.text === "repeat"
        );

        expect(repeated).toHaveLength(2);
        expect(repeated.every((item) => item.runId === "run-1")).toBe(true);
    });

    it("deduplicates a recovered steer whose optimistic alias is absent after refresh", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(8, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId: "provider-run",
                text: "Thinking",
            }),
            eventAt(16, "2026-07-16T12:00:10.000Z", {
                kind: "user",
                message: { content: "steer", role: "user", text: "steer" },
            }),
        ]);
        const history = [
            {
                ...message("user", "steer", "dashboard-chat-refresh-alias"),
                timestamp: "2026-07-16T12:00:09.500Z",
            },
        ];

        const steers = reconcileChatMessages(history, runtime.sessions[SESSION]).filter(
            (item) => item.text === "steer"
        );

        expect(steers).toHaveLength(1);
        expect(steers[0]?.runId).toBe("provider-run");
    });

    it("does not reassign an identical user message from another provider run", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:10.000Z", {
                kind: "user",
                message: { content: "repeat", role: "user", text: "repeat" },
                runId: "run-1",
            }),
        ]);
        const history = [
            {
                ...message("user", "repeat", "run-2"),
                timestamp: "2026-07-16T12:00:10.000Z",
            },
        ];

        const repeated = reconcileChatMessages(history, runtime.sessions[SESSION]).filter(
            (item) => item.text === "repeat"
        );

        expect(repeated.map((item) => item.runId)).toEqual(["run-2", "run-1"]);
    });

    it("merges a media-only provider echo into its optimistic dashboard row", () => {
        const attachment = {
            contentBase64: "c2FtZSBjb250ZW50",
            fileName: "same.txt",
            id: "local-random-id",
            kind: "text" as const,
            mimeType: "text/plain",
            sizeBytes: 12,
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:01.000Z", {
                kind: "user",
                message: {
                    attachments: [{ ...attachment, id: "inline-same.txt-0" }],
                    content: "",
                    role: "user",
                    text: "",
                },
                runId: "provider-run",
            }),
        ]);
        const history: ChatHistoryMessage[] = [
            {
                attachments: [attachment],
                content: "",
                local: true,
                role: "user",
                runId: "dashboard-chat-optimistic",
                text: "",
                timestamp: "2026-07-16T12:00:00.000Z",
            },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled).toHaveLength(1);
        expect(reconciled[0]).toMatchObject({
            attachments: [expect.objectContaining({ fileName: "same.txt" })],
            runId: "provider-run",
        });
    });

    it("anchors grouped thinking after recovered and live tools on refresh", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "status",
                runId: "run-1",
                text: "Working",
            }),
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "working", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "working" }],
                },
                runId: "run-1",
            }),
            event(24, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "call-recovered", name: "read" }],
                },
                runId: "run-1",
                toolKey: "tool:call-recovered",
            }),
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "call-live", name: "exec" }],
                },
                runId: "run-1",
                toolKey: "tool:call-live",
            }),
        ]);
        const history = [
            message("user", "question", "run-1"),
            {
                content: "",
                role: "assistant",
                text: "",
                toolCalls: [{ id: "call-recovered", name: "read" }],
            },
        ];

        const rows = projectChat(
            history,
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        ).rows;
        const thinkingIndex = rows.findIndex((row) => row.message.thinking?.length);
        const recoveredToolIndex = rows.findIndex((row) =>
            row.message.toolCalls?.some((call) => call.id === "call-recovered")
        );
        const liveToolIndex = rows.findIndex((row) =>
            row.message.toolCalls?.some((call) => call.id === "call-live")
        );

        expect(recoveredToolIndex).toBe(1);
        expect(rows[recoveredToolIndex]?.message.runId).toBe("run-1");
        expect(liveToolIndex).toBeGreaterThan(recoveredToolIndex);
        expect(thinkingIndex).toBeGreaterThan(liveToolIndex);
    });

    it("keeps activity visible when a runtime steer starts after older history", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId: "run-1",
                text: "Thinking",
            }),
            eventAt(32, "2026-07-16T12:01:00.000Z", {
                kind: "user",
                message: { content: "steer", role: "user", text: "steer" },
            }),
        ]);
        const history = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T11:59:59.000Z",
            },
            {
                ...message("assistant", "older answer"),
                timestamp: "2026-07-16T12:00:30.000Z",
            },
        ];

        const projection = projectChat(
            history,
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(projection.activeRuns.map((run) => run.runId)).toEqual(["run-1"]);
        expect(projection.rows.at(-1)).toMatchObject({
            kind: "typing",
            message: { text: "Thinking" },
        });
    });

    it("keeps an unscoped completed run with its initiating prompt", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId: "run-1",
                text: "Thinking",
            }),
            eventAt(32, "2026-07-16T12:02:00.000Z", {
                kind: "finish",
                message: message("assistant", "answer one", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const history = [
            {
                ...message("user", "question one"),
                timestamp: "2026-07-16T11:59:59.900Z",
            },
            {
                ...message("user", "question two"),
                timestamp: "2026-07-16T12:01:00.000Z",
            },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled.map((item) => item.text)).toEqual([
            "question one",
            "answer one",
            "question two",
        ]);
    });

    it("keeps an explicit older run anchored before a concurrent user turn", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(8, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId: "run-1",
                text: "Thinking",
            }),
            eventAt(16, "2026-07-16T12:01:00.000Z", {
                kind: "status",
                runId: "run-2",
                text: "Thinking",
            }),
            eventAt(24, "2026-07-16T12:02:00.000Z", {
                kind: "finish",
                message: message("assistant", "answer one", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
            eventAt(32, "2026-07-16T12:03:00.000Z", {
                kind: "finish",
                message: message("assistant", "answer two", "run-2"),
                outcome: "completed",
                runId: "run-2",
            }),
        ]);
        const history = [
            {
                ...message("user", "question one", "run-1"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message("user", "question two", "run-2"),
                timestamp: "2026-07-16T12:01:00.000Z",
            },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled.map((item) => item.text)).toEqual([
            "question one",
            "answer one",
            "question two",
            "answer two",
        ]);
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
            {
                ...message("user", "previous", "compact-run"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
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

    it("keeps completed compaction diagnostics before its final when the next user has an earlier timestamp", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-18T22:00:02.477Z", {
                kind: "thinking",
                message: {
                    content: [{ text: "compacting", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "compacting" }],
                },
                runId: "compact-run",
            }),
            eventAt(32, "2026-07-18T22:00:15.076Z", {
                kind: "finish",
                message: message("assistant", "NO_REPLY\n\nNO_FLUSH", "compact-run"),
                outcome: "completed",
                runId: "compact-run",
            }),
        ]);
        const history = [
            {
                ...message("user", "Extract key decisions"),
                timestamp: "2026-07-18T21:59:41.034Z",
            },
            {
                ...message("assistant", "NO_REPLY\n\nNO_FLUSH"),
                timestamp: "2026-07-18T22:00:15.076Z",
            },
            {
                ...message("user", "The order looks wrong"),
                timestamp: "2026-07-18T21:59:39.874Z",
            },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled.map((item) => item.text)).toEqual([
            "Extract key decisions",
            "",
            "NO_REPLY\n\nNO_FLUSH",
            "The order looks wrong",
        ]);
        expect(reconciled[1]?.thinking?.[0]?.text).toBe("compacting");
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

    it("matches repeated recovered tools to distinct history rows", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            noIdToolCall(16),
            noIdToolResult(32, "same"),
            noIdToolCall(48),
            noIdToolResult(64, "same"),
        ]);

        const reconciled = reconcileChatMessages(
            [
                message("user", "repeat"),
                recoveredNoIdTool("2026-07-16T12:00:01.000Z"),
                recoveredNoIdTool("2026-07-16T12:00:02.000Z"),
            ],
            runtime.sessions[SESSION]
        );
        const tools = reconciled.filter((item) => item.toolCalls?.length);

        expect(tools).toHaveLength(2);
        expect(tools.every((item) => item.runId === "run-1")).toBe(true);
    });

    it("matches separate runtime tools inside one recovered history row", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
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
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "call-2", name: "write" }],
                },
                runId: "run-1",
                toolKey: "tool:call-2",
            }),
        ]);
        const history: ChatHistoryMessage[] = [
            message("user", "two tools"),
            {
                content: "",
                role: "assistant",
                text: "",
                toolCalls: [
                    { id: "call-1", name: "read" },
                    { id: "call-2", name: "write" },
                ],
            },
        ];

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
        const tools = reconciled.filter((item) => item.toolCalls?.length);

        expect(tools).toHaveLength(1);
        expect(tools[0]?.runId).toBe("run-1");
        expect(tools[0]?.toolCalls?.map((call) => call.id)).toEqual(["call-1", "call-2"]);
    });

    it("matches nested tool arguments independently of object key order", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            arguments: { options: { alpha: 1, beta: 2 } },
                            id: "call-1",
                            name: "exec",
                        },
                    ],
                },
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
        ]);
        const reconciled = reconcileChatMessages(
            [
                message("user", "run tool"),
                {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            arguments: { options: { beta: 2, alpha: 1 } },
                            id: "call-1",
                            name: "exec",
                        },
                    ],
                },
            ],
            runtime.sessions[SESSION]
        );

        expect(
            reconciled.filter((item) => item.toolCalls?.[0]?.id === "call-1")
        ).toHaveLength(1);
    });

    it("keeps non-JSON diagnostic identities type-safe", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        expect(stableChatStringify(1n)).not.toBe(stableChatStringify("1"));
        expect(stableChatStringify(circular)).not.toBe(stableChatStringify("[Circular]"));
        expect(stableChatStringify({ ä: 1, z: 2 })).toBe(
            '["object","Object",[["z",["number",2]],["ä",["number",1]]]]'
        );
    });

    it("keeps text-bearing tool work separate from the final answer", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: {
                    content: "working",
                    role: "assistant",
                    text: "working",
                    toolCalls: [{ id: "call-1", name: "exec" }],
                },
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
        const reconciled = reconcileChatMessages(
            [
                message("user", "question"),
                {
                    content: "working",
                    role: "assistant",
                    runId: "run-1",
                    text: "working",
                    toolCalls: [{ id: "call-1", name: "exec" }],
                },
            ],
            runtime.sessions[SESSION]
        );

        expect(reconciled.filter((item) => item.toolCalls?.length)).toHaveLength(1);
        expect(
            reconciled.filter(
                (item) => item.role === "assistant" && item.text === "answer"
            )
        ).toHaveLength(1);
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
        expect(reconciled[1]?.thinking?.[0]?.text).toBe("reasoning");
        expect(reconciled[2]?.toolCalls?.[0]?.id).toBe("call-1");
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
        expect(projection.activeRuns).toEqual([]);
    });

    it("reconciles a late runtime copy of a history tool before the final answer", () => {
        const history: ChatHistoryMessage[] = [
            { ...message("user", "question"), timestamp: "2026-07-18T16:35:30.000Z" },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-18T16:35:31.998Z",
                toolCalls: [
                    {
                        arguments: { command: "gh api graphql" },
                        id: "call-1",
                        name: "bash",
                        toolResult: {
                            content: "completed",
                            id: "call-1",
                            name: "bash",
                        },
                    },
                ],
            },
            {
                ...message("assistant", "answer"),
                timestamp: "2026-07-18T16:35:32.000Z",
            },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-18T16:35:32.002Z", {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            arguments: { cmd: "gh api graphql" },
                            id: "call-1",
                            name: "Bash",
                            toolResult: {
                                content: "completed",
                                id: "call-1",
                                name: "Bash",
                            },
                        },
                    ],
                },
                runId: "late-runtime-run",
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

        expect(
            projection.rows.filter((row) => row.message.toolCalls?.length)
        ).toHaveLength(1);
        expect(projection.rows.at(-1)).toMatchObject({
            kind: "message",
            message: { text: "answer" },
        });
        expect(projection.activeRuns).toEqual([]);
    });

    it("keeps reused exact tool ids isolated across later user boundaries", () => {
        const history: ChatHistoryMessage[] = [
            { ...message("user", "question"), timestamp: "2026-07-18T16:35:30.000Z" },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-18T16:35:31.000Z",
                toolCalls: [
                    {
                        arguments: { command: "date" },
                        id: "functions.exec:0",
                        name: "bash",
                        toolResult: {
                            content: "completed",
                            id: "functions.exec:0",
                            name: "bash",
                        },
                    },
                ],
            },
            {
                ...message("assistant", "answer"),
                timestamp: "2026-07-18T16:35:32.000Z",
            },
            {
                ...message("user", "next question"),
                timestamp: "2026-07-18T16:35:33.000Z",
            },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-18T16:36:00.000Z", {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            arguments: { cmd: "date" },
                            id: "functions.exec:0",
                            name: "Bash",
                        },
                    ],
                },
                runId: "late-runtime-run",
                toolKey: "tool:functions.exec:0",
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

        const toolRows = projection.rows.filter((row) => row.message.toolCalls?.length);
        expect(toolRows).toHaveLength(2);
        expect(toolRows[0]?.message.toolCalls?.[0]?.toolResult?.content).toBe(
            "completed"
        );
        expect(toolRows[1]?.message).toMatchObject({
            runId: "late-runtime-run",
            toolCalls: [
                expect.objectContaining({
                    id: "functions.exec:0",
                }),
            ],
        });
        expect(toolRows[1]?.message.toolCalls?.[0]?.toolResult).toBeUndefined();
        expect(projection.activeRuns.map((run) => run.runId)).toEqual([
            "late-runtime-run",
        ]);
    });

    it("does not let a delayed run claim a reused tool in a later Dashboard turn", () => {
        const firstFinal: ChatHistoryMessage = {
            attachments: [{ fileName: "first.txt", id: "first", kind: "text" }],
            content: "",
            role: "assistant",
            text: "",
            timestamp: "2026-07-18T16:35:32.000Z",
        };
        const laterFinal: ChatHistoryMessage = {
            attachments: [{ fileName: "later.txt", id: "later", kind: "text" }],
            content: "",
            role: "assistant",
            text: "",
            timestamp: "2026-07-18T16:36:02.000Z",
        };
        const history: ChatHistoryMessage[] = [
            { ...message("user", "first"), timestamp: "2026-07-18T16:35:29.000Z" },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-18T16:35:31.000Z",
                toolCalls: [{ id: "functions.exec:0", name: "exec" }],
            },
            firstFinal,
            {
                ...message("user", "later", "dashboard-chat-later"),
                local: true,
                timestamp: "2026-07-18T16:36:00.000Z",
            },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-18T16:36:01.000Z",
                toolCalls: [{ id: "functions.exec:0", name: "exec" }],
            },
            laterFinal,
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-18T16:35:30.000Z", {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "functions.exec:0", name: "exec" }],
                },
                runId: "delayed-run",
                toolKey: "tool:functions.exec:0",
            }),
            eventAt(48, "2026-07-18T16:36:03.000Z", {
                kind: "finish",
                message: { ...firstFinal, runId: "delayed-run" },
                outcome: "completed",
                runId: "delayed-run",
            }),
        ]);

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(
            reconciled.find((item) => item.attachments?.[0]?.id === "first")?.runId
        ).toBe("delayed-run");
        expect(
            reconciled.find((item) => item.attachments?.[0]?.id === "later")?.runId
        ).toBeUndefined();
    });

    it("reconciles a large exact-id run without reserializing every tool payload", () => {
        const toolCount = 250;
        const payload = "x".repeat(20_000);
        const diagnostics: ChatSessionRuntimeState["runs"][string]["diagnostics"] = [];
        const history: ChatHistoryMessage[] = [message("user", "question")];
        for (let index = 0; index < toolCount; index += 1) {
            const id = `large-call-${index}`;
            const toolMessage: ChatHistoryMessage = {
                content: "",
                role: "assistant",
                text: "",
                toolCalls: [
                    {
                        id,
                        name: "bash",
                        toolResult: { content: payload, id, name: "bash" },
                    },
                ],
            };
            history.push(toolMessage);
            diagnostics.push({
                key: `tool:${id}`,
                message: toolMessage,
                sequence: index + 1,
            });
        }
        history.push(message("assistant", "answer"));
        const session: ChatSessionRuntimeState = {
            lastSequence: toolCount + 1,
            runs: {
                "run-long": {
                    aliases: [],
                    assistant: message("assistant", "answer", "run-long"),
                    diagnostics,
                    lastSequence: toolCount + 1,
                    phase: "completed",
                    runId: "run-long",
                    sessionKey: SESSION,
                    startedAt: NOW,
                    terminalAt: NOW,
                    terminalSequence: toolCount + 1,
                    updatedAt: NOW,
                    userMessages: [],
                },
            },
            sessionKey: SESSION,
        };

        const reconciled = reconcileChatMessages(history, session);

        expect(reconciled.filter((item) => item.toolCalls?.length)).toHaveLength(
            toolCount
        );
        expect(reconciled.at(-1)?.text).toBe("answer");
    });

    it("does not append stale activity after a status-only run final", () => {
        const history = [
            { ...message("user", "question"), timestamp: "2026-07-16T12:00:00.000Z" },
            { ...message("assistant", "answer"), timestamp: "2026-07-16T12:00:41.000Z" },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:40.000Z", {
                kind: "status",
                runId: "status-only-run",
                text: "Thinking",
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
            "answer",
        ]);
        expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
        expect(projection.activeRuns).toEqual([]);
    });

    it.each([
        {
            answer: {
                attachments: [{ fileName: "answer.txt", id: "answer", kind: "text" }],
                content: "",
                role: "assistant",
                text: "",
            } satisfies ChatHistoryMessage,
            label: "attachment-only",
        },
        {
            answer: {
                content: "",
                images: [{ data: "image-data", type: "image" }],
                role: "assistant",
                text: "",
            } satisfies ChatHistoryMessage,
            label: "image-only",
        },
        {
            answer: {
                attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
                content: "",
                isFinal: true,
                role: "assistant",
                text: "",
                toolCalls: [{ id: "call-1", name: "write" }],
            } satisfies ChatHistoryMessage,
            label: "final tool-bearing",
        },
    ])("adopts an unscoped $label history final", ({ answer }) => {
        const history = [
            { ...message("user", "question"), timestamp: "2026-07-16T12:00:00.000Z" },
            { ...answer, timestamp: "2026-07-16T12:00:41.000Z" },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:40.000Z", {
                kind: "status",
                runId: "status-only-run",
                text: "Thinking",
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

        expect(projection.rows.at(-1)).toMatchObject({ kind: "message" });
        expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
        expect(projection.activeRuns).toEqual([]);
    });

    it("keeps a newer active turn visible beside an older unscoped final", () => {
        const history = [
            {
                ...message("user", "question one"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message("user", "question two"),
                timestamp: "2026-07-16T12:01:00.000Z",
            },
            {
                ...message("assistant", "late answer one"),
                timestamp: "2026-07-16T12:02:00.000Z",
            },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:01:30.000Z", {
                kind: "status",
                runId: "active-second-run",
                text: "Thinking",
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

        expect(projection.activeRuns.map((run) => run.runId)).toEqual([
            "active-second-run",
        ]);
        expect(projection.rows.at(-1)).toMatchObject({
            kind: "typing",
            message: { text: "Thinking" },
        });
    });

    it.each([
        {
            label: "media-only",
            previousAnswer: {
                attachments: [{ fileName: "answer.txt", id: "answer", kind: "text" }],
                content: "",
                role: "assistant",
                text: "",
            } satisfies ChatHistoryMessage,
        },
        {
            label: "final tool-bearing",
            previousAnswer: {
                content: "first answer",
                isFinal: true,
                role: "assistant",
                text: "first answer",
                toolCalls: [{ id: "call-1", name: "read" }],
            } satisfies ChatHistoryMessage,
        },
    ])(
        "recognizes a $label prior answer before adopting a later unscoped final",
        ({ previousAnswer }) => {
            const history: ChatHistoryMessage[] = [
                {
                    ...message("user", "question one"),
                    timestamp: "2026-07-16T12:00:00.000Z",
                },
                {
                    ...previousAnswer,
                    timestamp: "2026-07-16T12:00:30.000Z",
                },
                {
                    ...message("user", "question two"),
                    timestamp: "2026-07-16T12:01:00.000Z",
                },
                {
                    ...message("assistant", "second answer"),
                    timestamp: "2026-07-16T12:01:31.000Z",
                },
            ];
            const runtime = reduceChatRuntime(createChatRuntimeState(), [
                eventAt(16, "2026-07-16T12:01:30.000Z", {
                    kind: "status",
                    runId: "active-second-run",
                    text: "Thinking",
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

            expect(projection.rows.at(-1)).toMatchObject({
                kind: "message",
                message: { text: "second answer" },
            });
            expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
            expect(projection.activeRuns).toEqual([]);
        }
    );

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

    it("replaces stale exact-id history output with the current runtime result", () => {
        const historyTool: ChatHistoryMessage = {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    id: "call-1",
                    name: "exec",
                    toolResult: {
                        content: "stale",
                        id: "call-1",
                        name: "exec",
                    },
                },
            ],
            toolResult: { content: "stale", id: "call-1", name: "exec" },
        };
        const runtimeTool: ChatHistoryMessage = {
            ...historyTool,
            toolCalls: [
                {
                    id: "call-1",
                    name: "exec",
                    toolResult: {
                        content: "current",
                        id: "call-1",
                        name: "exec",
                    },
                },
            ],
            toolResult: { content: "current", id: "call-1", name: "exec" },
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: runtimeTool,
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

        const reconciled = reconcileChatMessages(
            [message("user", "question"), historyTool, message("assistant", "answer")],
            runtime.sessions[SESSION]
        );
        const tools = reconciled.filter((item) => item.toolCalls?.[0]?.id === "call-1");

        expect(tools).toHaveLength(1);
        expect(tools[0]?.toolCalls?.[0]?.toolResult?.content).toBe("current");
        expect(tools[0]?.toolResult?.content).toBe("current");
    });

    it("keeps canonical output when runtime has only completion metadata", () => {
        const historyTool: ChatHistoryMessage = {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    id: "call-1",
                    name: "bash",
                    toolResult: {
                        content: "actual command output",
                        id: "call-1",
                        name: "bash",
                    },
                },
            ],
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "bash",
                            toolResult: {
                                content:
                                    '{"durationMs":12,"exitCode":0,"status":"completed"}',
                                id: "call-1",
                                isPlaceholder: true,
                                name: "bash",
                            },
                        },
                    ],
                },
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

        const reconciled = reconcileChatMessages(
            [message("user", "question"), historyTool, message("assistant", "answer")],
            runtime.sessions[SESSION]
        );
        const tools = reconciled.filter((item) => item.toolCalls?.[0]?.id === "call-1");

        expect(tools).toHaveLength(1);
        expect(tools[0]?.toolCalls?.[0]?.toolResult?.content).toBe(
            "actual command output"
        );
    });

    it("merges failed placeholder state without replacing canonical output", () => {
        const historyTool: ChatHistoryMessage = {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    id: "call-1",
                    name: "bash",
                    toolResult: {
                        content: "actual command output",
                        id: "call-1",
                        name: "bash",
                    },
                },
            ],
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "bash",
                            toolResult: {
                                content:
                                    '{"durationMs":12,"exitCode":1,"status":"failed"}',
                                id: "call-1",
                                isError: true,
                                isPlaceholder: true,
                                name: "bash",
                            },
                        },
                    ],
                },
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
            event(32, {
                error: "Bash failed",
                kind: "finish",
                outcome: "error",
                runId: "run-1",
                toolFailure: true,
            }),
        ]);

        const reconciled = reconcileChatMessages(
            [message("user", "question"), historyTool],
            runtime.sessions[SESSION]
        );
        const toolResult = reconciled.find((item) => item.toolCalls?.[0]?.id === "call-1")
            ?.toolCalls?.[0]?.toolResult;

        expect(toolResult).toMatchObject({
            content: "actual command output",
            isError: true,
        });
        expect(toolResult?.isPlaceholder).toBeUndefined();
        expect(runtime.sessions[SESSION]?.runs["run-1"]?.error).toBeUndefined();
    });

    it("recognizes a merged runtime tool when history stores call and result separately", () => {
        const runtimeTool: ChatHistoryMessage = {
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
            {
                content: "",
                role: "assistant",
                text: "",
                toolCalls: [{ arguments: { path: "a" }, id: "call-1", name: "read" }],
            },
            {
                content: "done",
                role: "tool",
                text: "done",
                toolResult: { content: "done", id: "call-1", name: "read" },
            },
            message("assistant", "answer", "run-1"),
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: runtimeTool,
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
            reconciled.filter(
                (item) => item.toolCalls?.length || item.toolResult?.id === "call-1"
            )
        ).toHaveLength(2);
        expect(
            reconciled
                .filter(
                    (item) => item.toolCalls?.length || item.toolResult?.id === "call-1"
                )
                .every((item) => item.runId === "run-1")
        ).toBe(true);
    });

    it("keeps a persisted user deletion hidden after runtime adds its run id", () => {
        const historyPrompt: ChatHistoryMessage = {
            ...message("user", "question"),
            timestamp: NOW,
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "user",
                message: historyPrompt,
                runId: "run-1",
            }),
        ]);

        const projection = projectChat(
            [historyPrompt],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set([messageDeleteKey(historyPrompt)])
        );

        expect(projection.rows.some((row) => row.message.text === "question")).toBe(
            false
        );
    });

    it("keeps a persisted assistant deletion hidden after final reconciliation", () => {
        const historyAnswer: ChatHistoryMessage = {
            ...message("assistant", "answer"),
            timestamp: NOW,
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const projection = projectChat(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T11:59:59.000Z",
                },
                historyAnswer,
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set([messageDeleteKey(historyAnswer)])
        );

        expect(projection.rows.some((row) => row.message.text === "answer")).toBe(false);
    });

    it("keeps a persisted diagnostic deletion hidden after run scoping", () => {
        const historyTool: ChatHistoryMessage = {
            content: "",
            role: "assistant",
            text: "",
            timestamp: "2026-07-16T12:00:01.000Z",
            toolCalls: [{ id: "call-1", name: "read" }],
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:02.000Z", {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const projection = projectChat(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T11:59:59.000Z",
                },
                historyTool,
                {
                    ...message("assistant", "answer"),
                    timestamp: "2026-07-16T12:00:02.000Z",
                },
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set([messageDeleteKey(historyTool)])
        );

        expect(projection.rows.some((row) => row.message.toolCalls?.length)).toBe(false);
    });

    it("exposes both scoped and history delete keys before replay clears", () => {
        const historyAnswer: ChatHistoryMessage = {
            ...message("assistant", "answer"),
            timestamp: "2026-07-16T12:00:02.000Z",
        };
        const history = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T11:59:59.000Z",
            },
            historyAnswer,
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:02.000Z", {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const scoped = projectChat(
            history,
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const answerRow = scoped.rows.find((row) => row.message.text === "answer");

        expect(answerRow).toBeDefined();
        expect(answerRow!.deleteKeys).toEqual([
            answerRow!.key,
            messageDeleteKey(historyAnswer),
        ]);
        const afterReplayClear = projectChat(
            history,
            createChatRuntimeState(),
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set(answerRow!.deleteKeys)
        );
        expect(afterReplayClear.rows.some((row) => row.message.text === "answer")).toBe(
            false
        );
    });

    it("keeps a deleted runtime diagnostic hidden by its stable row key", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
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
        ]);
        const visible = projectChat(
            [message("user", "question")],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const toolRow = visible.rows.find((row) => row.message.toolCalls?.length);

        expect(toolRow?.key).toBe("diagnostic-run-1-tool-call-call-1");
        const hidden = projectChat(
            [message("user", "question")],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set([toolRow!.key])
        );
        expect(hidden.rows.some((row) => row.message.toolCalls?.length)).toBe(false);
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

    it("keeps compacted hidden tool media attached to its canonical final", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:02.000Z", {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const projection = projectChat(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T11:59:59.000Z",
                },
                {
                    attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
                    content: "",
                    role: "assistant",
                    text: "",
                    timestamp: "2026-07-16T12:00:01.000Z",
                    toolCalls: [{ id: "call-1", name: "write" }],
                },
                {
                    ...message("assistant", "answer"),
                    timestamp: "2026-07-16T12:00:02.000Z",
                },
            ],
            runtime,
            SESSION,
            createChatVisibility(true, false),
            true,
            new Set()
        );

        expect(projection.rows.map((row) => row.message.text)).toEqual([
            "question",
            "answer",
        ]);
        expect(projection.rows[1]?.message.attachments?.[0]?.fileName).toBe("report.txt");
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

    it("recognizes a final tool-bearing assistant row without reclassifying tool work", () => {
        const toolWork: ChatHistoryMessage = {
            content: "Checking",
            role: "assistant",
            runId: "run-1",
            text: "Checking",
            thinking: [{ text: "work reasoning" }],
            toolCalls: [
                {
                    id: "call-1",
                    name: "read",
                    toolResult: { content: "done", id: "call-1", name: "read" },
                },
            ],
        };
        const finalWithTool: ChatHistoryMessage = {
            ...toolWork,
            content: "All healthy",
            isFinal: true,
            text: "All healthy",
            thinking: [{ text: "final reasoning" }],
        };

        const unfinished = presentChatMessages(
            [message("user", "check"), toolWork],
            createChatVisibility(true, true),
            false
        );
        expect(unfinished.some((item) => item.thinking?.length)).toBe(true);

        const completed = presentChatMessages(
            [message("user", "check"), finalWithTool],
            createChatVisibility(true, true),
            false
        );
        expect(completed.some((item) => item.thinking?.length)).toBe(false);
        expect(completed.find((item) => item.text === "All healthy")?.toolCalls).toEqual(
            finalWithTool.toolCalls
        );
    });

    it("recognizes visible attachments as final tool-bearing answer content", () => {
        const finalWithAttachment: ChatHistoryMessage = {
            attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
            content: "",
            isFinal: true,
            role: "assistant",
            runId: "run-1",
            text: "",
            thinking: [{ text: "final reasoning" }],
            toolCalls: [
                {
                    id: "call-1",
                    name: "write",
                    toolResult: { content: "", id: "call-1", name: "write" },
                },
            ],
        };

        const completed = presentChatMessages(
            [message("user", "create report"), finalWithAttachment],
            createChatVisibility(true, true),
            false
        );

        expect(completed.some((item) => item.thinking?.length)).toBe(false);
        expect(completed.find((item) => item.attachments?.length)?.attachments).toEqual(
            finalWithAttachment.attachments
        );
    });

    it("extracts mixed unscoped thinking into one bubble before the final answer", () => {
        const raw: ChatHistoryMessage[] = [
            message("user", "heartbeat"),
            message("assistant", "Running scheduled check"),
            {
                content: [{ text: "first thought", type: "thinking" }],
                role: "assistant",
                text: "",
                thinking: [{ id: "thought-1", text: "first thought" }],
                toolCalls: [{ id: "call-1", name: "read" }],
            },
            {
                content: "first result",
                role: "tool",
                text: "first result",
                toolResult: { content: "first result", id: "call-1", name: "read" },
            },
            {
                content: [{ text: "second thought", type: "thinking" }],
                role: "assistant",
                text: "",
                thinking: [{ id: "thought-2", text: "second thought" }],
                toolCalls: [{ id: "call-2", name: "exec" }],
            },
            {
                content: "second result",
                role: "tool",
                text: "second result",
                toolResult: { content: "second result", id: "call-2", name: "exec" },
            },
            {
                content: [
                    { text: "final thought", type: "thinking" },
                    { text: "All healthy", type: "text" },
                ],
                role: "assistant",
                text: "All healthy",
                thinking: [{ id: "thought-3", text: "final thought" }],
            },
        ];

        const visible = presentChatMessages(raw, createChatVisibility(true, true), true);
        const thinkingRows = visible.filter((item) => item.thinking?.length);
        const lastToolIndex = visible.findLastIndex(
            (item) => item.toolCalls?.length || item.toolResult
        );
        const thinkingIndex = visible.findIndex((item) => item.thinking?.length);
        const finalIndex = visible.findIndex((item) => item.text === "All healthy");

        expect(thinkingRows).toHaveLength(1);
        expect(thinkingRows[0]?.thinking?.map((block) => block.text)).toEqual([
            "first thought",
            "second thought",
            "final thought",
        ]);
        expect(thinkingIndex).toBeGreaterThan(lastToolIndex);
        expect(thinkingIndex).toBeLessThan(finalIndex);
        expect(visible[finalIndex]?.thinking).toBeUndefined();
    });

    it("keeps canonical tools stable and before thinking after runtime tools compact", () => {
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T11:59:59.000Z",
            },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-16T12:00:01.000Z",
                toolCalls: [
                    {
                        arguments: { command: "date" },
                        id: "call-1",
                        name: "bash",
                        toolResult: {
                            content: "completed",
                            id: "call-1",
                            name: "bash",
                        },
                    },
                ],
            },
            {
                ...message("assistant", "answer"),
                timestamp: "2026-07-16T12:00:02.000Z",
            },
        ];
        const thinking = event(16, {
            kind: "thinking",
            message: {
                content: [{ text: "reasoning", type: "thinking" }],
                role: "assistant",
                text: "",
                thinking: [{ id: "thought-1", text: "reasoning" }],
            },
            runId: "run-1",
        });
        const finish = event(48, {
            kind: "finish",
            message: message("assistant", "answer", "run-1"),
            outcome: "completed",
            runId: "run-1",
        });
        const fullRuntime = reduceChatRuntime(createChatRuntimeState(), [
            thinking,
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            arguments: { command: "date" },
                            id: "call-1",
                            name: "bash",
                            toolResult: {
                                content: "completed",
                                id: "call-1",
                                name: "bash",
                            },
                        },
                    ],
                },
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
            finish,
        ]);
        const compactRuntime = reduceChatRuntime(createChatRuntimeState(), [
            thinking,
            finish,
        ]);
        const fullProjection = projectChat(
            history,
            fullRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const compactProjection = projectChat(
            history,
            compactRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const rowKinds = (projection: typeof fullProjection) =>
            projection.rows.map((row) =>
                row.message.toolCalls?.length
                    ? "tool"
                    : row.message.thinking?.length
                      ? "thinking"
                      : row.message.text
            );
        const toolKey = (projection: typeof fullProjection) =>
            projection.rows.find((row) => row.message.toolCalls?.length)?.key;

        expect(rowKinds(fullProjection)).toEqual([
            "question",
            "tool",
            "thinking",
            "answer",
        ]);
        expect(rowKinds(compactProjection)).toEqual(rowKinds(fullProjection));
        expect(toolKey(compactProjection)).toBe(toolKey(fullProjection));
        const compactFinal = compactProjection.rows.find(
            (row) => row.message.text === "answer"
        );
        expect(compactFinal?.message.isFinal).toBe(true);
        expect(compactFinal?.message.toolCalls).toBeUndefined();
    });

    it("keeps compacted tools before thinking for a media-only final", () => {
        const mediaFinal: ChatHistoryMessage = {
            attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
            content: "",
            role: "assistant",
            text: "",
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "reasoning", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "reasoning" }],
                },
                runId: "run-1",
            }),
            event(48, {
                kind: "finish",
                message: { ...mediaFinal, runId: "run-1" },
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const projection = projectChat(
            [
                message("user", "question"),
                {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "call-1", name: "read" }],
                },
                mediaFinal,
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(
            projection.rows.map((row) =>
                row.message.toolCalls?.length
                    ? "tool"
                    : row.message.thinking?.length
                      ? "thinking"
                      : row.message.attachments?.length
                        ? "final"
                        : row.message.text
            )
        ).toEqual(["question", "tool", "thinking", "final"]);
    });

    it("keeps a media-only final before a follow-up sent within the start skew", () => {
        const mediaFinal: ChatHistoryMessage = {
            attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
            content: "",
            role: "assistant",
            text: "",
            timestamp: "2026-07-16T12:00:02.000Z",
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:00.000Z", {
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
            eventAt(32, "2026-07-16T12:00:01.000Z", {
                kind: "thinking",
                message: thinkingMessage("run-1"),
                runId: "run-1",
            }),
            eventAt(48, "2026-07-16T12:00:02.000Z", {
                kind: "finish",
                message: { ...mediaFinal, runId: "run-1" },
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const projection = projectChat(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T11:59:59.900Z",
                },
                {
                    content: "",
                    role: "assistant",
                    text: "",
                    timestamp: "2026-07-16T12:00:00.200Z",
                    toolCalls: [{ id: "call-1", name: "read" }],
                },
                mediaFinal,
                {
                    ...message("user", "follow-up"),
                    timestamp: "2026-07-16T12:00:00.500Z",
                },
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(
            projection.rows.map((row) =>
                row.message.toolCalls?.length
                    ? "tool"
                    : row.message.thinking?.length
                      ? "thinking"
                      : row.message.attachments?.length
                        ? "final"
                        : row.message.text
            )
        ).toEqual(["question", "tool", "thinking", "final", "follow-up"]);
    });

    it("prefers an explicit run user over a later timestamp boundary", () => {
        const mediaFinal: ChatHistoryMessage = {
            attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
            content: "",
            role: "assistant",
            text: "",
            timestamp: "2026-07-16T12:00:02.000Z",
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:04.000Z", {
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
            eventAt(32, "2026-07-16T12:00:05.000Z", {
                kind: "finish",
                message: { ...mediaFinal, runId: "run-1" },
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const projection = projectChat(
            [
                {
                    ...message("user", "question", "run-1"),
                    timestamp: "2026-07-16T12:00:00.000Z",
                },
                {
                    content: "",
                    role: "assistant",
                    text: "",
                    timestamp: "2026-07-16T12:00:01.000Z",
                    toolCalls: [{ id: "call-1", name: "read" }],
                },
                mediaFinal,
                {
                    ...message("user", "follow-up"),
                    timestamp: "2026-07-16T12:00:03.000Z",
                },
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const finalRows = projection.rows.filter(
            (row) => row.message.attachments?.[0]?.id === "report"
        );
        const finalIndex = projection.rows.findIndex(
            (row) => row.message.attachments?.[0]?.id === "report"
        );
        const followUpIndex = projection.rows.findIndex(
            (row) => row.message.text === "follow-up"
        );

        expect(finalRows).toHaveLength(1);
        expect(finalRows[0]?.message.runId).toBe("run-1");
        expect(finalIndex).toBeLessThan(followUpIndex);
    });

    it("does not scope a later text answer to a media-only final", () => {
        const mediaFinal: ChatHistoryMessage = {
            attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
            content: "",
            role: "assistant",
            text: "",
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: thinkingMessage("run-1"),
                runId: "run-1",
            }),
            event(48, {
                kind: "finish",
                message: { ...mediaFinal, runId: "run-1" },
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const projection = projectChat(
            [
                message("user", "question"),
                mediaFinal,
                message("assistant", "unrelated later answer"),
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(
            projection.rows.find((row) => row.message.text === "unrelated later answer")
                ?.message.runId
        ).toBeUndefined();
    });

    it("hides compacted thinking for each overlapping completed run", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(32, "2026-07-16T12:00:03.000Z", {
                kind: "finish",
                message: message("assistant", "newer answer", "run-new"),
                outcome: "completed",
                runId: "run-new",
            }),
            eventAt(48, "2026-07-16T12:00:01.000Z", {
                kind: "finish",
                message: message("assistant", "older answer", "run-old"),
                outcome: "completed",
                runId: "run-old",
            }),
        ]);
        const projection = projectChat(
            [
                {
                    ...message("user", "parallel"),
                    timestamp: "2026-07-16T11:59:59.000Z",
                },
                {
                    ...thinkingMessage(""),
                    runId: undefined,
                    timestamp: "2026-07-16T12:00:00.000Z",
                },
                {
                    ...message("assistant", "older answer"),
                    timestamp: "2026-07-16T12:00:01.000Z",
                },
                {
                    ...thinkingMessage(""),
                    runId: undefined,
                    timestamp: "2026-07-16T12:00:02.000Z",
                },
                {
                    ...message("assistant", "newer answer"),
                    timestamp: "2026-07-16T12:00:03.000Z",
                },
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            false,
            new Set()
        );

        expect(projection.rows.some((row) => row.message.thinking?.length)).toBe(false);
    });

    it("groups compacted diagnostic and final thinking into one bubble", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:02.000Z", {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const projection = projectChat(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T11:59:59.000Z",
                },
                {
                    content: [{ text: "first thought", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "first thought" }],
                    timestamp: "2026-07-16T12:00:01.000Z",
                    toolCalls: [{ id: "call-1", name: "read" }],
                },
                {
                    content: [
                        { text: "final thought", type: "thinking" },
                        { text: "answer", type: "text" },
                    ],
                    role: "assistant",
                    text: "answer",
                    thinking: [{ id: "thought-2", text: "final thought" }],
                    timestamp: "2026-07-16T12:00:02.000Z",
                },
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const thinkingRows = projection.rows.filter(
            (row) => row.message.thinking?.length
        );

        expect(thinkingRows).toHaveLength(1);
        expect(thinkingRows[0]?.message.thinking?.map((block) => block.text)).toEqual([
            "first thought",
            "final thought",
        ]);
    });

    it("keeps unfinished unscoped thinking inside its response segment", () => {
        const visible = presentChatMessages(
            [
                message("user", "first turn"),
                {
                    content: [{ text: "first thought", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ id: "thought-1", text: "first thought" }],
                },
                message("user", "second turn"),
            ],
            createChatVisibility(true, true),
            true
        );

        expect(visible.map((item) => item.text)).toEqual([
            "first turn",
            "",
            "second turn",
        ]);
        expect(visible[1]?.thinking?.[0]?.text).toBe("first thought");
    });

    it("uses runtime sequence for interleaved tools and steers across replay", () => {
        const runId = "run-1";
        const runtimeEvents: ChatRuntimeEvent[] = [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "working", type: "thinking" }],
                    role: "assistant",
                    runId,
                    text: "",
                    thinking: [{ id: "thought-1", text: "working" }],
                },
                runId,
            }),
            ...(
                [
                    [32, "call-1", "first-tool"],
                    [80, "call-2", "second-tool"],
                    [112, "call-3", "third-tool"],
                ] satisfies Array<[number, string, string]>
            ).map(([sequence, id, name]) =>
                event(sequence, {
                    kind: "tool",
                    message: {
                        content: "",
                        role: "assistant",
                        runId,
                        text: "",
                        toolCalls: [{ id, name }],
                    },
                    runId,
                    toolKey: `tool:${id}`,
                })
            ),
            event(48, {
                kind: "user",
                message: message("user", "question", runId),
                runId,
            }),
            event(64, {
                kind: "user",
                message: message("user", "first steer", runId),
                runId,
            }),
            event(96, {
                kind: "user",
                message: message("user", "second steer", runId),
                runId,
            }),
            event(128, { kind: "status", runId, text: "Working" }),
        ].toSorted((left, right) => left.sequence - right.sequence);
        const history = [{ ...message("user", "question"), timestamp: NOW }];
        const beforeReplay = reduceChatRuntime(
            createChatRuntimeState(),
            runtimeEvents.slice(0, 5)
        );
        const liveRuntime = reduceChatRuntime(
            structuredClone(beforeReplay),
            runtimeEvents.slice(5)
        );
        const replayedRuntime = reduceChatRuntime(
            createChatRuntimeState(),
            runtimeEvents
        );
        const labels = (runtime: ReturnType<typeof createChatRuntimeState>) =>
            projectChat(
                history,
                runtime,
                SESSION,
                createChatVisibility(true, true),
                true,
                new Set()
            ).rows.map((row) =>
                row.kind === "typing"
                    ? `status:${row.message.text}`
                    : row.message.toolCalls?.[0]?.name ||
                      (row.message.thinking?.length ? "thinking" : row.message.text)
            );
        const expectedActive = [
            "question",
            "first-tool",
            "first steer",
            "second-tool",
            "second steer",
            "third-tool",
            "thinking",
            "status:Working",
        ];

        expect(liveRuntime).toEqual(replayedRuntime);
        expect(labels(liveRuntime)).toEqual(expectedActive);
        expect(labels(replayedRuntime)).toEqual(expectedActive);

        const completedRuntime = reduceChatRuntime(replayedRuntime, [
            event(144, {
                kind: "finish",
                message: message("assistant", "done", runId),
                outcome: "completed",
                runId,
            }),
        ]);
        expect(labels(completedRuntime)).toEqual([
            ...expectedActive.slice(0, -1),
            "done",
        ]);
    });

    it("anchors the earliest runtime prompt ahead of a timestamp-skewed steer", () => {
        const runId = "runtime-only-skewed-users";
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:10.000Z", {
                kind: "user",
                message: message("user", "question", runId),
                runId,
            }),
            eventAt(32, "2026-07-16T12:00:05.000Z", {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    runId,
                    text: "",
                    toolCalls: [{ id: "call-skewed", name: "first-tool" }],
                },
                runId,
                toolKey: "tool:call-skewed",
            }),
            eventAt(48, "2026-07-16T12:00:00.000Z", {
                kind: "user",
                message: message("user", "steer", runId),
                runId,
            }),
            eventAt(64, "2026-07-16T12:00:06.000Z", {
                kind: "thinking",
                message: {
                    content: [{ text: "working", type: "thinking" }],
                    role: "assistant",
                    runId,
                    text: "",
                    thinking: [{ id: "thought-skewed", text: "working" }],
                },
                runId,
            }),
            eventAt(80, "2026-07-16T12:00:07.000Z", {
                kind: "status",
                runId,
                text: "Working",
            }),
        ]);

        const labels = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        ).rows.map((row) =>
            row.kind === "typing"
                ? `status:${row.message.text}`
                : row.message.toolCalls?.[0]?.name ||
                  (row.message.thinking?.length ? "thinking" : row.message.text)
        );

        expect(labels).toEqual([
            "question",
            "first-tool",
            "steer",
            "thinking",
            "status:Working",
        ]);
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

        expect(projection.compactionStatus).toMatchObject({
            phase: "active",
            text: "Compacting context",
        });
        expect(projection.rows).toEqual([]);
    });

    it("finishes a dedicated compaction run without ending the parent chat run", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "status",
                operation: "compact",
                operationPhase: "active",
                runId: "compaction:run-1",
                text: "Compacting context",
            }),
            event(32, {
                kind: "status",
                operation: "compact",
                operationPhase: "complete",
                runId: "compaction:run-1",
                text: "Context compacted",
            }),
            event(48, {
                kind: "status",
                runId: "run-1",
                text: "Thinking",
            }),
        ]);
        const projection = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(false, false),
            false,
            new Set()
        );

        expect(projection.activeRuns.map((run) => run.runId)).toEqual(["run-1"]);
        expect(projection.compactionStatus).toMatchObject({ phase: "complete" });
        expect(projection.rows.at(-1)?.message.text).toBe("Thinking");
    });

    it("completes retrying compaction when the lifecycle settles", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "status",
                operation: "compact",
                operationPhase: "active",
                runId: "compaction:run-1",
                text: "Compacting context",
            }),
            event(16, {
                kind: "status",
                operation: "compact",
                operationPhase: "retrying",
                runId: "compaction:run-1",
                text: "Compacting context",
            }),
            event(24, {
                kind: "finish",
                outcome: "completed",
                runId: "run-1",
                settlesCompactionRunId: "compaction:run-1",
            }),
        ]);
        const projection = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(projection.compactionStatus).toMatchObject({ phase: "complete" });
        expect(runtime.sessions[SESSION]?.runs["compaction:run-1"]).toMatchObject({
            operationPhase: "complete",
            phase: "completed",
        });
    });

    it("does not settle a retrying compaction from an unrelated lifecycle", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "status",
                operation: "compact",
                operationPhase: "retrying",
                runId: "compaction:run-2",
                text: "Compacting context",
            }),
            event(16, {
                kind: "finish",
                outcome: "completed",
                runId: "run-1",
                settlesCompactionRunId: "compaction:run-1",
            }),
        ]);

        expect(runtime.sessions[SESSION]?.runs["compaction:run-2"]).toMatchObject({
            operationPhase: "retrying",
            phase: "active",
        });
    });

    it("keeps a failed retrying compaction out of completed feedback", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "status",
                operation: "compact",
                operationPhase: "retrying",
                runId: "compaction:run-1",
                text: "Compacting context",
            }),
            event(16, {
                error: "Compaction failed",
                kind: "finish",
                outcome: "error",
                runId: "run-1",
                settlesCompactionRunId: "compaction:run-1",
            }),
        ]);
        const projection = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(projection.compactionStatus).toBeUndefined();
        expect(runtime.sessions[SESSION]?.runs["compaction:run-1"]).toMatchObject({
            error: "Compaction failed",
            operationPhase: "inactive",
            phase: "error",
        });
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
