import { describe, expect, it } from "bun:test";

import { messageDeleteKey } from "../../components/features/chat/chatMessageIdentity";
import { type ChatHistoryMessage } from "../../components/features/chat/chatTypes";
import { projectCanonicalChat } from "../../components/features/chat/domain/chatCanonicalProjection";
import {
    createChatVisibility,
    presentChatMessages,
} from "../../components/features/chat/domain/chatPresentation";
import type { ChatProjection } from "../../components/features/chat/domain/chatProjection";
import {
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
describe("chat projection visibility and media", () => {
    it("keeps a persisted diagnostic deletion hidden after run scoping", () => {
        const historyTool: ChatHistoryMessage = {
            content: "",
            role: "assistant",
            text: "",
            timestamp: "2026-07-16T12:00:01.000Z",
            toolCalls: [
                {
                    id: "call-1",
                    name: "read",
                },
            ],
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
            attachments: [
                {
                    fileName: "report.txt",
                    id: "report",
                    kind: "text",
                },
            ],
            content: "",
            role: "tool",
            runId: "run-1",
            text: "",
            toolResult: {
                content: "",
                id: "call-1",
                name: "write",
            },
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
                    attachments: [
                        {
                            fileName: "report.txt",
                            id: "report",
                            kind: "text",
                        },
                    ],
                    content: "",
                    role: "tool",
                    runId: "run-1",
                    text: "",
                    toolResult: {
                        content: "",
                        name: "write",
                    },
                },
                message("assistant", "done", "run-1"),
            ],
            createChatVisibility(true, false)
        );
        expect(visible).toHaveLength(1);
        expect(visible[0]?.attachments?.[0]?.fileName).toBe("report.txt");
    });
    it("keeps hidden tool media on a system answer instead of its thinking bubble", () => {
        const visible = presentChatMessages(
            [
                {
                    attachments: [
                        {
                            fileName: "report.txt",
                            id: "report",
                            kind: "text",
                        },
                    ],
                    content: "",
                    images: [
                        {
                            data: "tool-image",
                            type: "image",
                        },
                    ],
                    role: "tool",
                    runId: "run-1",
                    text: "",
                    toolResult: {
                        content: "",
                        name: "write",
                    },
                },
                {
                    content: [
                        {
                            text: "system thought",
                            type: "thinking",
                        },
                        {
                            text: "system answer",
                            type: "text",
                        },
                    ],
                    isFinal: true,
                    role: "system",
                    runId: "run-1",
                    text: "system answer",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "system thought",
                        },
                    ],
                },
            ],
            createChatVisibility(true, false)
        );
        expect(visible).toHaveLength(2);
        expect(visible[0]?.thinking?.[0]?.text).toBe("system thought");
        expect(visible[0]?.attachments).toBeUndefined();
        expect(visible[0]?.images).toBeUndefined();
        expect(visible[1]?.text).toBe("system answer");
        expect(visible[1]?.attachments?.[0]?.fileName).toBe("report.txt");
        expect(visible[1]?.images?.[0]?.data).toBe("tool-image");
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
                    attachments: [
                        {
                            fileName: "report.txt",
                            id: "report",
                            kind: "text",
                        },
                    ],
                    content: "",
                    role: "assistant",
                    text: "",
                    timestamp: "2026-07-16T12:00:01.000Z",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "write",
                        },
                    ],
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
                        {
                            fileName: "generated.txt",
                            id: "generated",
                            kind: "text",
                        },
                    ],
                    content: "",
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "write",
                            toolResult: {
                                content: "",
                                id: "call-1",
                                name: "write",
                            },
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
            images: [
                {
                    data: "top-level",
                    type: "image",
                },
            ],
            role: "tool",
            runId: "run-1",
            text: "",
            toolResult: {
                content: "",
                images: [
                    {
                        data: "nested",
                        type: "image",
                    },
                ],
                name: "generate",
            },
            toolCalls: [
                {
                    name: "generate",
                    toolResult: {
                        content: "",
                        images: [
                            {
                                data: "nested-call",
                                type: "image",
                            },
                        ],
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
                content: [
                    {
                        text: "reasoning",
                        type: "thinking",
                    },
                ],
                role: "assistant",
                runId: "run-1",
                text: "",
                thinking: [
                    {
                        text: "reasoning",
                    },
                ],
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
            thinking: [
                {
                    text: "work reasoning",
                },
            ],
            toolCalls: [
                {
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
        const finalWithTool: ChatHistoryMessage = {
            ...toolWork,
            content: "All healthy",
            isFinal: true,
            text: "All healthy",
            thinking: [
                {
                    text: "final reasoning",
                },
            ],
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
            attachments: [
                {
                    fileName: "report.txt",
                    id: "report",
                    kind: "text",
                },
            ],
            content: "",
            isFinal: true,
            role: "assistant",
            runId: "run-1",
            text: "",
            thinking: [
                {
                    text: "final reasoning",
                },
            ],
            toolCalls: [
                {
                    id: "call-1",
                    name: "write",
                    toolResult: {
                        content: "",
                        id: "call-1",
                        name: "write",
                    },
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
                content: [
                    {
                        text: "first thought",
                        type: "thinking",
                    },
                ],
                role: "assistant",
                text: "",
                thinking: [
                    {
                        id: "thought-1",
                        text: "first thought",
                    },
                ],
                toolCalls: [
                    {
                        id: "call-1",
                        name: "read",
                    },
                ],
            },
            {
                content: "first result",
                role: "tool",
                text: "first result",
                toolResult: {
                    content: "first result",
                    id: "call-1",
                    name: "read",
                },
            },
            {
                content: [
                    {
                        text: "second thought",
                        type: "thinking",
                    },
                ],
                role: "assistant",
                text: "",
                thinking: [
                    {
                        id: "thought-2",
                        text: "second thought",
                    },
                ],
                toolCalls: [
                    {
                        id: "call-2",
                        name: "exec",
                    },
                ],
            },
            {
                content: "second result",
                role: "tool",
                text: "second result",
                toolResult: {
                    content: "second result",
                    id: "call-2",
                    name: "exec",
                },
            },
            {
                content: [
                    {
                        text: "final thought",
                        type: "thinking",
                    },
                    {
                        text: "All healthy",
                        type: "text",
                    },
                ],
                role: "assistant",
                text: "All healthy",
                thinking: [
                    {
                        id: "thought-3",
                        text: "final thought",
                    },
                ],
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
    it("keeps an active assistant stream below its thinking", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "commentary",
                message: {
                    content: "reasoning",
                    role: "assistant",
                    text: "reasoning",
                },
                mode: "replace",
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
                            id: "call-1",
                            name: "read",
                        },
                    ],
                },
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
            event(32, {
                kind: "assistant",
                message: message("assistant", "answer in progress", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
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
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "tool",
            "thinking",
            "answer in progress",
        ]);
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
                        arguments: {
                            command: "date",
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
                timestamp: "2026-07-16T12:00:02.000Z",
            },
        ];
        const thinking = event(16, {
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
                        id: "thought-1",
                        text: "reasoning",
                    },
                ],
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
                            arguments: {
                                command: "date",
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
        expect(projectionRowKinds(fullProjection)).toEqual([
            "question",
            "tool",
            "thinking",
            "answer",
        ]);
        expect(projectionRowKinds(compactProjection)).toEqual(
            projectionRowKinds(fullProjection)
        );
        expect(projectionToolKey(compactProjection)).toBe(
            projectionToolKey(fullProjection)
        );
        const compactFinal = compactProjection.rows.find(
            (row) => row.message.text === "answer"
        );
        expect(compactFinal?.message.isFinal).toBe(true);
        expect(compactFinal?.message.toolCalls).toBeUndefined();
    });
    it("keeps compacted tools before thinking for a media-only final", () => {
        const mediaFinal: ChatHistoryMessage = {
            attachments: [
                {
                    fileName: "report.txt",
                    id: "report",
                    kind: "text",
                },
            ],
            content: "",
            role: "assistant",
            text: "",
        };
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
                            id: "thought-1",
                            text: "reasoning",
                        },
                    ],
                },
                runId: "run-1",
            }),
            event(48, {
                kind: "finish",
                message: {
                    ...mediaFinal,
                    runId: "run-1",
                },
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
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "read",
                        },
                    ],
                },
                mediaFinal,
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "tool",
            "thinking",
            "final",
        ]);
    });
    it("keeps a media-only final before a follow-up sent within the start skew", () => {
        const mediaFinal: ChatHistoryMessage = {
            attachments: [
                {
                    fileName: "report.txt",
                    id: "report",
                    kind: "text",
                },
            ],
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
            eventAt(32, "2026-07-16T12:00:01.000Z", {
                kind: "thinking",
                message: thinkingMessage("run-1"),
                runId: "run-1",
            }),
            eventAt(48, "2026-07-16T12:00:02.000Z", {
                kind: "finish",
                message: {
                    ...mediaFinal,
                    runId: "run-1",
                },
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
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "read",
                        },
                    ],
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
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "tool",
            "thinking",
            "final",
            "follow-up",
        ]);
    });
    it("prefers an explicit run user over a later timestamp boundary", () => {
        const mediaFinal: ChatHistoryMessage = {
            attachments: [
                {
                    fileName: "report.txt",
                    id: "report",
                    kind: "text",
                },
            ],
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
            eventAt(32, "2026-07-16T12:00:05.000Z", {
                kind: "finish",
                message: {
                    ...mediaFinal,
                    runId: "run-1",
                },
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
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "read",
                        },
                    ],
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
            attachments: [
                {
                    fileName: "report.txt",
                    id: "report",
                    kind: "text",
                },
            ],
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
                message: {
                    ...mediaFinal,
                    runId: "run-1",
                },
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
                    content: [
                        {
                            text: "first thought",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "first thought",
                        },
                    ],
                    timestamp: "2026-07-16T12:00:01.000Z",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "read",
                        },
                    ],
                },
                {
                    content: [
                        {
                            text: "final thought",
                            type: "thinking",
                        },
                        {
                            text: "answer",
                            type: "text",
                        },
                    ],
                    role: "assistant",
                    text: "answer",
                    thinking: [
                        {
                            id: "thought-2",
                            text: "final thought",
                        },
                    ],
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
    it("keeps Synthetic session tools before a mixed thinking final", () => {
        const runId = "synthetic-heartbeat";
        const history: ChatHistoryMessage[] = [
            {
                content: [
                    {
                        text: "first thought",
                        type: "thinking",
                    },
                ],
                role: "assistant",
                text: "",
                thinking: [
                    {
                        id: "thought-1",
                        text: "first thought",
                    },
                ],
                toolCalls: [
                    {
                        id: "call-1",
                        name: "first-tool",
                        toolResult: {
                            content: "first result",
                            id: "call-1",
                            name: "first-tool",
                        },
                    },
                ],
            },
            {
                content: [
                    {
                        text: "second thought",
                        type: "thinking",
                    },
                ],
                role: "assistant",
                text: "",
                thinking: [
                    {
                        id: "thought-2",
                        text: "second thought",
                    },
                ],
                toolCalls: [
                    {
                        id: "call-2",
                        name: "second-tool",
                        toolResult: {
                            content: "second result",
                            id: "call-2",
                            name: "second-tool",
                        },
                    },
                ],
            },
            {
                content: [
                    {
                        text: "final thought",
                        type: "thinking",
                    },
                    {
                        text: "HEARTBEAT_OK",
                        type: "text",
                    },
                ],
                role: "assistant",
                text: "HEARTBEAT_OK",
                thinking: [
                    {
                        id: "thought-3",
                        text: "final thought",
                    },
                ],
            },
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "first thought",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "first thought",
                        },
                    ],
                },
                runId,
            }),
            event(17, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "first-tool",
                        },
                    ],
                },
                runId,
                toolKey: "tool:call-1",
            }),
            event(32, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "second thought",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-2",
                            text: "second thought",
                        },
                    ],
                },
                runId,
            }),
            event(33, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-2",
                            name: "second-tool",
                        },
                    ],
                },
                runId,
                toolKey: "tool:call-2",
            }),
            event(48, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "final thought",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-3",
                            text: "final thought",
                        },
                    ],
                },
                runId,
            }),
            event(49, {
                kind: "assistant",
                message: message("assistant", "HEARTBEAT_OK", runId),
                mode: "replace",
                runId,
                source: "session",
            }),
            event(50, {
                kind: "finish",
                outcome: "completed",
                runId,
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
            projection.rows.map(
                (row) =>
                    row.message.toolCalls?.[0]?.name ||
                    (row.message.thinking?.length ? "thinking" : row.message.text)
            )
        ).toEqual(["first-tool", "second-tool", "thinking", "HEARTBEAT_OK"]);
        expect(
            projection.rows.filter((row) => row.message.thinking?.length)
        ).toHaveLength(1);
    });
});
