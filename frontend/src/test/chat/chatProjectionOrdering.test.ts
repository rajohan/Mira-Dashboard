import { describe, expect, it } from "bun:test";

import { type ChatHistoryMessage } from "../../components/features/chat/chatTypes";
import { projectCanonicalChat } from "../../components/features/chat/domain/chatCanonicalProjection";
import {
    createChatVisibility,
    presentChatMessages,
} from "../../components/features/chat/domain/chatPresentation";
import type { ChatProjection } from "../../components/features/chat/domain/chatProjection";
import { reconcileChatMessages } from "../../components/features/chat/domain/chatProjection";
import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRuntimeEvent,
    createChatRuntimeState,
    reduceChatRuntime,
} from "../../components/features/chat/domain/chatState";
const SESSION = "agent:main:main";
const NOW = "2026-07-16T12:00:00.000Z";
type EventDraft = ChatRuntimeEvent extends infer Event
    ? Event extends ChatRuntimeEvent
        ? Omit<Event, "sequence" | "sessionKey" | "timestamp">
        : never
    : never;
function projectChat(
    ...parameters: Parameters<typeof projectCanonicalChat>
): ChatProjection {
    return projectCanonicalChat(...parameters).projection;
}
function projectedRowKind(row: ChatProjection["rows"][number]): string {
    if (row.message.toolCalls?.length) {
        return "tool";
    }
    if (row.message.thinking?.length) {
        return "thinking";
    }
    if (row.message.attachments?.length) {
        return "final";
    }
    return row.message.text;
}
function projectionRowKinds(projection: ChatProjection): string[] {
    return projection.rows.map((row) => projectedRowKind(row));
}
function projectionToolKey(projection: ChatProjection): string | undefined {
    return projection.rows.find((row) => row.message.toolCalls?.length)?.key;
}
function event(sequence: number, draft: EventDraft): ChatRuntimeEvent {
    return {
        ...draft,
        sequence,
        sessionKey: SESSION,
        timestamp: NOW,
    };
}
function eventAt(
    sequence: number,
    timestamp: string,
    draft: EventDraft
): ChatRuntimeEvent {
    return {
        ...event(sequence, draft),
        timestamp,
    };
}
function message(role: string, text: string, runId?: string): ChatHistoryMessage {
    return {
        content: text,
        role,
        runId,
        text,
    };
}
function controlMessage(controlId: string): ChatHistoryMessage {
    return {
        content: "Task progress: #389",
        controlId,
        intent: "control",
        role: "system",
        text: "Task progress: #389",
    };
}
function thinkingMessage(runId: string): ChatHistoryMessage {
    return {
        content: [
            {
                text: "same reasoning",
                type: "thinking",
            },
        ],
        role: "assistant",
        runId,
        text: "",
        thinking: [
            {
                text: "same reasoning",
            },
        ],
    };
}
function noIdToolCall(sequence: number): ChatRuntimeEvent {
    return event(sequence, {
        kind: "tool",
        message: {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    arguments: {
                        cmd: "date",
                    },
                    name: "exec",
                },
            ],
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
            toolResult: {
                content,
                name: "exec",
            },
        },
        runId: "run-1",
        toolKey: "tool:exec:undefined",
    });
}
describe("chat projection ordering and controls", () => {
    it("keeps a thinking row anchored while runtime output recovers into history", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "same reasoning",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "same reasoning",
                        },
                    ],
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
                    content: [
                        {
                            text: "working",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "working",
                        },
                    ],
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
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "read",
                        },
                    ],
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
    it("places a newly persisted tool before thinking on its first render", () => {
        const thinkingRuntime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "working",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "working",
                        },
                    ],
                },
                runId: "run-1",
            }),
        ]);
        const history = [
            message("user", "question"),
            {
                content: "",
                role: "assistant",
                text: "",
                toolCalls: [
                    {
                        id: "call-1",
                        name: "read",
                    },
                ],
            },
        ];
        const firstProjection = projectChat(
            history,
            thinkingRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const enrichedRuntime = reduceChatRuntime(thinkingRuntime, [
            event(32, {
                kind: "tool",
                message: history[1]!,
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
        ]);
        const enrichedProjection = projectChat(
            history,
            enrichedRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const firstKinds = projectionRowKinds(firstProjection);
        const enrichedKinds = projectionRowKinds(enrichedProjection);
        expect(firstKinds.indexOf("tool")).toBeLessThan(firstKinds.indexOf("thinking"));
        expect(enrichedKinds.indexOf("tool")).toBeLessThan(
            enrichedKinds.indexOf("thinking")
        );
        expect(projectionToolKey(enrichedProjection)).toBe(
            projectionToolKey(firstProjection)
        );
        expect(enrichedProjection.rows.find((row) => row.message.thinking)?.key).toBe(
            firstProjection.rows.find((row) => row.message.thinking)?.key
        );
    });
    it("keeps one tool row and key when the provider backfills its call id", () => {
        const firstEvent = event(16, {
            kind: "tool",
            message: {
                content: "",
                role: "assistant",
                text: "",
                toolCalls: [
                    {
                        arguments: {
                            path: "/tmp/a",
                        },
                        name: "read",
                    },
                ],
            },
            runId: "run-1",
            toolKey: 'tool:read:{"path":"/tmp/a"}',
        });
        const initialRuntime = reduceChatRuntime(createChatRuntimeState(), [firstEvent]);
        const initialProjection = projectChat(
            [message("user", "question")],
            initialRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const enrichedRuntime = reduceChatRuntime(initialRuntime, [
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            arguments: {
                                path: "/tmp/a",
                            },
                            id: "call-read-1",
                            name: "read",
                        },
                    ],
                },
                runId: "run-1",
                toolKey: "tool:call-read-1",
            }),
        ]);
        const enrichedProjection = projectChat(
            [message("user", "question")],
            enrichedRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        expect(
            enrichedRuntime.sessions[SESSION]?.runs["run-1"]?.diagnostics
        ).toHaveLength(1);
        expect(
            enrichedProjection.rows.filter((row) => row.message.toolCalls?.length)
        ).toHaveLength(1);
        expect(projectionToolKey(enrichedProjection)).toBe(
            projectionToolKey(initialProjection)
        );
    });
    it("folds commentary and reasoning into one stable thinking row", () => {
        const commentaryRuntime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:01.000Z", {
                kind: "commentary",
                message: {
                    content: "",
                    intent: "commentary",
                    role: "assistant",
                    runtimeKey: "commentary:preamble-1",
                    text: "Continuing the architectural repair.",
                },
                mode: "replace",
                runId: "run-1",
            }),
        ]);
        const firstProjection = projectChat(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T12:00:00.000Z",
                },
            ],
            commentaryRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const reasoningRuntime = reduceChatRuntime(commentaryRuntime, [
            eventAt(32, "2026-07-16T12:00:02.000Z", {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "Checking identity.",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "Checking identity.",
                        },
                    ],
                },
                runId: "run-1",
            }),
        ]);
        const enrichedProjection = projectChat(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T12:00:00.000Z",
                },
            ],
            reasoningRuntime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const firstThinkingRows = firstProjection.rows.filter(
            (row) => row.message.thinking?.length
        );
        const enrichedThinkingRows = enrichedProjection.rows.filter(
            (row) => row.message.thinking?.length
        );
        expect(firstThinkingRows).toHaveLength(1);
        expect(enrichedThinkingRows).toHaveLength(1);
        expect(
            enrichedThinkingRows[0]?.message.thinking?.map((block) => block.text)
        ).toEqual(["Continuing the architectural repair.", "Checking identity."]);
        expect(
            enrichedProjection.rows.some(
                (row) => row.message.text === "Continuing the architectural repair."
            )
        ).toBe(false);
        expect(enrichedThinkingRows[0]?.key).toBe(firstThinkingRows[0]?.key);
    });
    it("places controls like steers without creating or settling a response run", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:01.000Z", {
                kind: "thinking",
                message: thinkingMessage("run-1"),
                runId: "run-1",
            }),
            eventAt(32, "2026-07-16T12:00:02.000Z", {
                kind: "control",
                message: {
                    content: "Task progress: #389",
                    controlId: "message-1",
                    intent: "control",
                    role: "system",
                    text: "Task progress: #389",
                },
            }),
        ]);
        const projection = projectChat(
            [
                {
                    ...message("user", "question"),
                    timestamp: "2026-07-16T12:00:00.000Z",
                },
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const controlIndex = projection.rows.findIndex(
            (row) => row.message.intent === "control"
        );
        const thinkingIndex = projection.rows.findIndex(
            (row) => row.message.thinking?.length
        );
        expect(runtime.sessions[SESSION]?.controls).toHaveLength(1);
        expect(Object.keys(runtime.sessions[SESSION]?.runs || {})).toEqual(["run-1"]);
        expect(runtime.sessions[SESSION]?.runs["run-1"]?.phase).toBe("active");
        expect(projection.rows[controlIndex]).toMatchObject({
            key: "control-message-1",
            kind: "message",
            message: {
                intent: "control",
                role: "system",
                text: "Task progress: #389",
            },
        });
        expect(controlIndex).toBeGreaterThan(0);
        expect(controlIndex).toBeLessThan(thinkingIndex);
    });
    it("preserves same-text controls with distinct provider identities", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:01.000Z", {
                kind: "control",
                message: controlMessage("message-1"),
            }),
            eventAt(32, "2026-07-16T12:00:02.000Z", {
                kind: "control",
                message: controlMessage("message-2"),
            }),
        ]);
        const controls = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        ).rows.filter((row) => row.message.intent === "control");
        expect(controls.map((row) => row.key)).toEqual([
            "control-message-1",
            "control-message-2",
        ]);
    });
    it("keeps sibling tool call and result row keys distinct", () => {
        const projection = projectChat(
            [
                {
                    content: "",
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "exec",
                        },
                    ],
                },
                {
                    content: "done",
                    role: "tool",
                    runId: "run-1",
                    text: "done",
                    toolResult: {
                        content: "done",
                        id: "call-1",
                        name: "exec",
                    },
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
                    content: [
                        {
                            text: "first",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "first",
                        },
                    ],
                },
                runId: "provider-run",
            }),
            event(32, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "second",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-2",
                            text: "second",
                        },
                    ],
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
                content: [
                    {
                        text: "first",
                        type: "thinking",
                    },
                ],
                role: "assistant",
                runId: "dashboard-chat-original",
                text: "",
                thinking: [
                    {
                        text: "first",
                    },
                ],
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
                    content: [
                        {
                            text: "after steer",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "after steer",
                        },
                    ],
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
            message: {
                text: "Thinking",
            },
        });
    });
    it("moves thinking below a recovered unscoped steer before more work arrives", () => {
        const visible = presentChatMessages(
            [
                message("user", "question", "run-1"),
                {
                    content: [
                        {
                            thinking: "working",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    thinking: [
                        {
                            text: "working",
                        },
                    ],
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
                    content: [
                        {
                            text: "working",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "working",
                        },
                    ],
                },
                runId: "run-1",
            }),
            eventAt(24, "2026-07-16T12:00:20.000Z", {
                kind: "user",
                message: {
                    content: "steer",
                    role: "user",
                    text: "steer",
                },
            }),
            eventAt(32, "2026-07-16T12:00:30.000Z", {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "read",
                        },
                    ],
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
            expect(steerIndex).toBeLessThan(toolIndex);
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
                message: {
                    content: "repeat",
                    role: "user",
                    text: "repeat",
                },
                runId: "run-1",
            }),
            eventAt(24, "2026-07-16T12:00:12.000Z", {
                kind: "user",
                message: {
                    content: "repeat",
                    role: "user",
                    text: "repeat",
                },
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
                message: {
                    content: "steer",
                    role: "user",
                    text: "steer",
                },
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
                message: {
                    content: "repeat",
                    role: "user",
                    text: "repeat",
                },
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
                    attachments: [
                        {
                            ...attachment,
                            id: "inline-same.txt-0",
                        },
                    ],
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
            attachments: [
                expect.objectContaining({
                    fileName: "same.txt",
                }),
            ],
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
                    content: [
                        {
                            text: "working",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "working",
                        },
                    ],
                },
                runId: "run-1",
            }),
            event(24, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-recovered",
                            name: "read",
                        },
                    ],
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
                    toolCalls: [
                        {
                            id: "call-live",
                            name: "exec",
                        },
                    ],
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
                toolCalls: [
                    {
                        id: "call-recovered",
                        name: "read",
                    },
                ],
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
                message: {
                    content: "steer",
                    role: "user",
                    text: "steer",
                },
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
            message: {
                text: "Thinking",
            },
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
                    content: [
                        {
                            text: "compacting",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "compacting",
                        },
                    ],
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
                    content: [
                        {
                            text: "compacting",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            text: "compacting",
                        },
                    ],
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
});
