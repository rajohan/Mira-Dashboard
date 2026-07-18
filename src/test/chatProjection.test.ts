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

    it("moves thinking below an optimistic steer before provider acknowledgement", () => {
        const visible = presentChatMessages(
            [
                message("user", "question", "run-1"),
                {
                    content: [{ text: "working", type: "thinking" }],
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    thinking: [{ id: "thought-1", text: "working" }],
                },
                message("user", "steer now", "dashboard-chat-steer"),
                {
                    content: "",
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    toolCalls: [{ id: "call-1", name: "read" }],
                },
                message("assistant", "done", "run-1"),
            ],
            createChatVisibility(true, true),
            true
        );
        const steerIndex = visible.findIndex((item) => item.text === "steer now");
        const toolIndex = visible.findIndex((item) => item.toolCalls?.length);
        const thinkingIndex = visible.findIndex((item) => item.thinking?.length);
        const finalIndex = visible.findIndex((item) => item.text === "done");

        expect(thinkingIndex).toBeGreaterThan(steerIndex);
        expect(thinkingIndex).toBeGreaterThan(toolIndex);
        expect(thinkingIndex).toBeLessThan(finalIndex);
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
                settlesCompaction: true,
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
                settlesCompaction: true,
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
