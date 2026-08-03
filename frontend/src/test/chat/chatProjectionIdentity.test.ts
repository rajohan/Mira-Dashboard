import { describe, expect, it } from "bun:test";

import { messageDeleteKey } from "../../components/features/chat/chatMessageIdentity";
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
describe("chat projection identity and text reconciliation", () => {
    it("retains the optimistic response identity after run acknowledgement", () => {
        const optimisticRunId = "dashboard-chat-unread";
        const providerRunId = "provider-unread";
        const optimisticRuntime = reduceChatRuntime(
            addOptimisticChatRun(createChatRuntimeState(), SESSION, optimisticRunId),
            [
                event(16, {
                    kind: "assistant",
                    message: message("assistant", "same answer", optimisticRunId),
                    mode: "merge",
                    runId: optimisticRunId,
                    source: "chat",
                }),
            ]
        );
        const acknowledgedRuntime = acknowledgeChatRun(
            optimisticRuntime,
            SESSION,
            optimisticRunId,
            providerRunId
        );
        const projectRuntime = (runtime: typeof optimisticRuntime) =>
            projectChat(
                [],
                runtime,
                SESSION,
                createChatVisibility(true, true),
                true,
                new Set()
            ).rows.find((row) => row.message.text === "same answer");
        const optimisticRow = projectRuntime(optimisticRuntime);
        const acknowledgedRow = projectRuntime(acknowledgedRuntime);
        expect(optimisticRow?.key).toBe(`response-${optimisticRunId}`);
        expect(acknowledgedRow?.key).toBe(`response-${providerRunId}`);
        expect(acknowledgedRow?.identityKeys).toContain(optimisticRow?.key);
    });
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
                    thinking: [
                        {
                            text: "terminal detail",
                        },
                    ],
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
                toolCalls: [
                    {
                        id: "call-old",
                        name: "bash",
                    },
                ],
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
                toolCalls: [
                    {
                        id: "call-new",
                        name: "bash",
                    },
                ],
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
                    toolCalls: [
                        {
                            id: "call-old",
                            name: "read",
                        },
                    ],
                },
                message("assistant", "same"),
                {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-new",
                            name: "read",
                        },
                    ],
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
                runId: "run-1",
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
            message: {
                text: "Working",
            },
        });
    });
    it("deduplicates repeated blocks in the first thinking message", () => {
        const visible = presentChatMessages(
            [
                {
                    content: [
                        {
                            id: "thought-1",
                            text: "first draft",
                            type: "thinking",
                        },
                        {
                            id: "thought-1",
                            text: "current draft",
                            type: "thinking",
                        },
                        {
                            text: "same text",
                            type: "thinking",
                        },
                        {
                            text: "same text",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "first draft",
                        },
                        {
                            id: "thought-1",
                            text: "current draft",
                        },
                        {
                            text: "same text",
                        },
                        {
                            text: "same text",
                        },
                    ],
                },
            ],
            createChatVisibility(true, true),
            true
        );
        expect(visible).toHaveLength(1);
        expect(visible[0]?.thinking).toEqual([
            {
                id: "thought-1",
                text: "current draft",
            },
            {
                text: "same text",
            },
        ]);
    });
    it("hides activity when the same run already has visible assistant text", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "status",
                runId: "run-1",
                text: "Working",
            }),
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
                message: expect.objectContaining({
                    text: "Streaming answer",
                }),
            })
        );
        expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
    });
    it("keeps activity visible when tool-use commentary is hidden", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "status",
                runId: "run-1",
                text: "Working",
            }),
        ]);
        const projection = projectChat(
            [
                message("user", "question", "run-1"),
                {
                    ...message("assistant", "Calling the tool.", "run-1"),
                    isToolUse: true,
                },
            ],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        expect(
            projection.rows.some((row) => row.message.text === "Calling the tool.")
        ).toBe(false);
        expect(projection.activeRuns.map((run) => run.runId)).toEqual(["run-1"]);
        expect(projection.rows.at(-1)).toMatchObject({
            kind: "typing",
            message: {
                text: "Working",
            },
        });
    });
    it("restores activity when tool work follows visible assistant text", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "status",
                runId: "run-1",
                text: "Working",
            }),
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
            message: {
                text: "Working",
            },
        });
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "I will inspect it.",
            "tool",
            "Working",
        ]);
    });
    it("keeps assistant text on both sides of a tool in provider order", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: message("assistant", "Before the tool.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
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
                message: message("assistant", "After the tool.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
            }),
            event(40, {
                kind: "finish",
                message: message("assistant", "Before the tool.After the tool.", "run-1"),
                outcome: "completed",
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
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "Before the tool.",
            "tool",
            "After the tool.",
        ]);
    });
    it("reconciles segmented runtime text with a canonical full history final", () => {
        const fullAnswer = "Before the tool.After the tool.";
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: message("assistant", "Before the tool.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
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
                message: message("assistant", "After the tool.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
            }),
            event(40, {
                kind: "finish",
                message: message("assistant", fullAnswer, "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        const projection = projectChat(
            [message("user", "question"), message("assistant", fullAnswer)],
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "Before the tool.",
            "tool",
            "After the tool.",
        ]);
    });
    it("strips a normalized sealed prefix from a final assistant snapshot", () => {
        const beforeTool = "Cafe\u0301 before   the tool.\n";
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: message("assistant", beforeTool, "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
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
                message: message("assistant", "After the tool.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
            }),
            event(40, {
                kind: "finish",
                message: message(
                    "assistant",
                    "Caf\u00E9 before the tool. After the tool.",
                    "run-1"
                ),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);
        expect(
            runtime.sessions[SESSION]?.runs["run-1"]?.assistantSegments?.map(
                (entry) => entry.message.text
            )
        ).toEqual([beforeTool, "After the tool."]);
    });
    it("keeps both assistant segments when commentary updates between them", () => {
        const commentary = {
            content: "",
            intent: "commentary" as const,
            role: "assistant",
            runtimeKey: "commentary:preamble",
        };
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(8, {
                kind: "commentary",
                message: {
                    ...commentary,
                    text: "Started reasoning.",
                },
                mode: "replace",
                runId: "run-1",
            }),
            event(16, {
                kind: "assistant",
                message: message("assistant", "Before thinking.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
            }),
            event(24, {
                kind: "commentary",
                message: {
                    ...commentary,
                    text: "Updated reasoning.",
                },
                mode: "replace",
                runId: "run-1",
            }),
            event(32, {
                kind: "assistant",
                message: message("assistant", "After thinking.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
            }),
            event(40, {
                kind: "finish",
                message: message("assistant", "Before thinking.After thinking.", "run-1"),
                outcome: "completed",
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
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "thinking",
            "Before thinking.",
            "After thinking.",
        ]);
    });
    it("keeps both assistant segments around a thinking event", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: message("assistant", "Before thinking.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
            }),
            event(24, {
                kind: "thinking",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            text: "Working through the result.",
                        },
                    ],
                },
                runId: "run-1",
            }),
            event(32, {
                kind: "assistant",
                message: message("assistant", "After thinking.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
            }),
            event(40, {
                kind: "finish",
                message: message("assistant", "Before thinking.After thinking.", "run-1"),
                outcome: "completed",
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
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "thinking",
            "Before thinking.",
            "After thinking.",
        ]);
    });
    it("does not move pre-tool text when the final only repeats that text", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: message("assistant", "Before the tool.", "run-1"),
                mode: "append",
                runId: "run-1",
                source: "runtime",
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
                kind: "finish",
                message: message("assistant", "Before the tool.", "run-1"),
                outcome: "completed",
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
        expect(projectionRowKinds(projection)).toEqual([
            "question",
            "Before the tool.",
            "tool",
        ]);
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
            ...message("user", "steer", "dashboard-chat-steer"),
            timestamp: "2026-07-16T12:00:03.000Z",
        };
        expect(
            projectChat(
                [recoveredHistoryMessage],
                createChatRuntimeState(),
                SESSION,
                createChatVisibility(true, true),
                true,
                new Set(optimisticUserRow.deleteKeys)
            ).rows
        ).toEqual([]);
    });
    it("scopes an optimistic user deletion through acknowledged run aliases", () => {
        const optimisticRunId = "dashboard-chat-delete";
        const providerRunId = "provider-delete";
        const optimisticMessage = {
            ...message("user", "repeatable prompt", optimisticRunId),
            local: true,
            timestamp: NOW,
        };
        const optimisticRow = projectChat(
            [optimisticMessage],
            createChatRuntimeState(),
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        ).rows[0]!;
        const acknowledged = acknowledgeChatRun(
            addOptimisticChatRun(createChatRuntimeState(), SESSION, optimisticRunId),
            SESSION,
            optimisticRunId,
            providerRunId
        );
        const recovered = projectChat(
            [
                {
                    ...message("user", "repeatable prompt", providerRunId),
                    timestamp: "2026-07-16T12:00:03.000Z",
                },
            ],
            acknowledged,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set(optimisticRow.deleteKeys)
        );
        const laterUnrelated = projectChat(
            [
                {
                    ...message("user", "repeatable prompt", "provider-later"),
                    timestamp: "2026-07-16T13:00:00.000Z",
                },
            ],
            acknowledged,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set(optimisticRow.deleteKeys)
        );
        expect(
            recovered.rows.some((row) => row.message.role.toLowerCase() === "user")
        ).toBe(false);
        expect(
            laterUnrelated.rows
                .filter((row) => row.message.role.toLowerCase() === "user")
                .map((row) => row.message.text)
        ).toEqual(["repeatable prompt"]);
    });
});
