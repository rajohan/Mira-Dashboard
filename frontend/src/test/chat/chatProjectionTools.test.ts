import { describe, expect, it } from "bun:test";

import {
    messageDeleteKey,
    stableChatStringify,
} from "../../components/features/chat/chatMessageIdentity";
import { type ChatHistoryMessage } from "../../components/features/chat/chatTypes";
import { projectCanonicalChat } from "../../components/features/chat/domain/chatCanonicalProjection";
import { createChatVisibility } from "../../components/features/chat/domain/chatPresentation";
import type { ChatProjection } from "../../components/features/chat/domain/chatProjection";
import { reconcileChatMessages } from "../../components/features/chat/domain/chatProjection";
import {
    type ChatRuntimeEvent,
    type ChatSessionRuntimeState,
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
function recoveredNoIdTool(timestamp: string): ChatHistoryMessage {
    return {
        content: "",
        role: "assistant",
        text: "",
        timestamp,
        toolCalls: [
            {
                arguments: {
                    cmd: "date",
                },
                name: "exec",
                toolResult: {
                    content: "same",
                    name: "exec",
                },
            },
        ],
    };
}
describe("chat projection tools", () => {
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
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-2",
                            name: "write",
                        },
                    ],
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
                    {
                        id: "call-1",
                        name: "read",
                    },
                    {
                        id: "call-2",
                        name: "write",
                    },
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
                            arguments: {
                                options: {
                                    alpha: 1,
                                    beta: 2,
                                },
                            },
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
                            arguments: {
                                options: {
                                    beta: 2,
                                    alpha: 1,
                                },
                            },
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
        expect(
            stableChatStringify({
                ä: 1,
                z: 2,
            })
        ).toBe('["object","Object",[["z",["number",2]],["ä",["number",1]]]]');
    });
    it("keeps text-bearing tool work separate from the final answer", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: {
                    content: "working",
                    role: "assistant",
                    text: "working",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "exec",
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
            [
                message("user", "question"),
                {
                    content: "working",
                    role: "assistant",
                    runId: "run-1",
                    text: "working",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "exec",
                        },
                    ],
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
                    content: [
                        {
                            text: "reasoning",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            text: "reasoning",
                        },
                    ],
                },
                runId: "run-1",
            }),
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
                    content: [
                        {
                            text: "reasoning",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            text: "reasoning",
                        },
                    ],
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
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message("assistant", "answer"),
                timestamp: "2026-07-16T12:02:41.000Z",
            },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:02:40.000Z", {
                kind: "tool",
                message: {
                    content: "done",
                    role: "tool",
                    text: "done",
                    toolResult: {
                        content: "done",
                        id: "call-1",
                        name: "exec",
                    },
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
            "",
            "answer",
        ]);
        expect(projection.rows[1]).toMatchObject({
            message: {
                role: "assistant",
                toolCalls: [
                    {
                        id: "call-1",
                        name: "exec",
                        toolResult: {
                            content: "done",
                        },
                    },
                ],
            },
        });
        expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
        expect(projection.activeRuns).toEqual([]);
    });
    it("projects a nameless orphan result once without changing its canonical key", () => {
        const orphanResult: ChatHistoryMessage = {
            content: "done",
            role: "tool",
            text: "done",
            toolResult: {
                content: "done",
            },
        };
        const projection = projectChat(
            [message("user", "question"), orphanResult],
            createChatRuntimeState(),
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const toolRow = projection.rows[1];
        expect(toolRow).toMatchObject({
            deleteKeys: [messageDeleteKey(orphanResult)],
            key: messageDeleteKey(orphanResult),
            message: {
                role: "assistant",
                text: "",
                toolCalls: [
                    {
                        name: "tool",
                        toolResult: {
                            content: "done",
                            name: "tool",
                        },
                    },
                ],
                toolResult: undefined,
            },
        });
    });
    it("reconciles a late runtime copy of a history tool before the final answer", () => {
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-18T16:35:30.000Z",
            },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-18T16:35:31.998Z",
                toolCalls: [
                    {
                        arguments: {
                            command: "gh api graphql",
                        },
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
                            arguments: {
                                cmd: "gh api graphql",
                            },
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
            message: {
                text: "answer",
            },
        });
        expect(projection.activeRuns).toEqual([]);
    });
    it("folds a live runtime call into its exact history-only tool result", () => {
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-18T16:35:30.000Z",
            },
            {
                ...message("assistant", "running command"),
                isToolUse: true,
                timestamp: "2026-07-18T16:35:31.000Z",
            },
            {
                content: "completed",
                role: "tool",
                text: "completed",
                timestamp: "2026-07-18T16:35:32.000Z",
                toolResult: {
                    content: "completed",
                    id: "functions.exec:1",
                    name: "exec",
                },
            },
            {
                ...message("assistant", "answer"),
                timestamp: "2026-07-18T16:35:33.000Z",
            },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-18T16:35:31.500Z", {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            arguments: {
                                cmd: "printf completed",
                            },
                            id: "functions.exec:1",
                            name: "exec",
                        },
                    ],
                },
                runId: "run-1",
                toolKey: "tool-call:functions.exec:1",
            }),
            eventAt(32, "2026-07-18T16:35:32.000Z", {
                kind: "tool",
                message: {
                    content: "completed",
                    role: "tool",
                    text: "completed",
                    toolResult: {
                        content: "completed",
                        id: "functions.exec:1",
                        name: "exec",
                    },
                },
                runId: "run-1",
                toolKey: "tool-result:functions.exec:1",
            }),
            eventAt(48, "2026-07-18T16:35:33.000Z", {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
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
        const toolRows = projection.rows.filter(
            (row) => row.message.toolCalls?.length || row.message.toolResult
        );
        expect(toolRows).toHaveLength(1);
        expect(toolRows[0]?.message.toolCalls?.[0]).toMatchObject({
            arguments: {
                cmd: "printf completed",
            },
            id: "functions.exec:1",
            toolResult: {
                content: "completed",
            },
        });
        expect(projection.rows.map((row) => row.message.text)).toEqual([
            "question",
            "",
            "answer",
        ]);
    });
    it("keeps reused exact tool ids isolated across later user boundaries", () => {
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-18T16:35:30.000Z",
            },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-18T16:35:31.000Z",
                toolCalls: [
                    {
                        arguments: {
                            command: "date",
                        },
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
                            arguments: {
                                cmd: "date",
                            },
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
            attachments: [
                {
                    fileName: "first.txt",
                    id: "first",
                    kind: "text",
                },
            ],
            content: "",
            role: "assistant",
            text: "",
            timestamp: "2026-07-18T16:35:32.000Z",
        };
        const laterFinal: ChatHistoryMessage = {
            attachments: [
                {
                    fileName: "later.txt",
                    id: "later",
                    kind: "text",
                },
            ],
            content: "",
            role: "assistant",
            text: "",
            timestamp: "2026-07-18T16:36:02.000Z",
        };
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "first"),
                timestamp: "2026-07-18T16:35:29.000Z",
            },
            {
                content: "",
                role: "assistant",
                text: "",
                timestamp: "2026-07-18T16:35:31.000Z",
                toolCalls: [
                    {
                        id: "functions.exec:0",
                        name: "exec",
                    },
                ],
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
                toolCalls: [
                    {
                        id: "functions.exec:0",
                        name: "exec",
                    },
                ],
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
                    toolCalls: [
                        {
                            id: "functions.exec:0",
                            name: "exec",
                        },
                    ],
                },
                runId: "delayed-run",
                toolKey: "tool:functions.exec:0",
            }),
            eventAt(48, "2026-07-18T16:36:03.000Z", {
                kind: "finish",
                message: {
                    ...firstFinal,
                    runId: "delayed-run",
                },
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
                        toolResult: {
                            content: payload,
                            id,
                            name: "bash",
                        },
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
            controls: [],
            lastSequence: toolCount + 1,
            runs: {
                "run-long": {
                    aliases: [],
                    assistant: message("assistant", "answer", "run-long"),
                    commentary: [],
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
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message("assistant", "answer"),
                timestamp: "2026-07-16T12:00:41.000Z",
            },
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
            message: {
                text: "Thinking",
            },
        });
    });
    it("does not replay completed tool diagnostics already present in history", () => {
        const toolDiagnostic: ChatHistoryMessage = {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    arguments: {
                        path: "a",
                    },
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
            toolResult: {
                content: "stale",
                id: "call-1",
                name: "exec",
            },
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
            toolResult: {
                content: "current",
                id: "call-1",
                name: "exec",
            },
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
                    arguments: {
                        path: "a",
                    },
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
                toolCalls: [
                    {
                        arguments: {
                            path: "a",
                        },
                        id: "call-1",
                        name: "read",
                    },
                ],
            },
            {
                content: "done",
                role: "tool",
                text: "done",
                toolResult: {
                    content: "done",
                    id: "call-1",
                    name: "read",
                },
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
});
