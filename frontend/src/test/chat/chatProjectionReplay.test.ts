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
    addOptimisticChatRun,
    type ChatRuntimeEvent,
    clearChatRun,
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
function timestampedToolMessage(
    id: string,
    name: string,
    timestamp: string
): ChatHistoryMessage {
    return {
        content: "",
        role: "assistant",
        text: "",
        thinking: [
            {
                text: `thinking-${id}`,
            },
        ],
        timestamp,
        toolCalls: [
            {
                id,
                name,
            },
        ],
    };
}
function runtimeToolEvent(
    sequence: number,
    runId: string,
    id: string,
    name: string,
    timestamp: string
): ChatRuntimeEvent {
    return eventAt(sequence, timestamp, {
        kind: "tool",
        message: timestampedToolMessage(id, name, timestamp),
        runId,
        toolKey: `tool:${id}`,
    });
}
function runtimeThinkingEvent(
    sequence: number,
    runId: string,
    timestamp: string
): ChatRuntimeEvent {
    return eventAt(sequence, timestamp, {
        kind: "thinking",
        message: thinkingMessage(runId),
        runId,
    });
}
function projectionLabels(
    history: ChatHistoryMessage[],
    runtime: ReturnType<typeof createChatRuntimeState>
): string[] {
    return projectChat(
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
}
describe("chat projection replay and compaction", () => {
    it.each([
        {
            answer: {
                attachments: [
                    {
                        fileName: "answer.txt",
                        id: "answer",
                        kind: "text",
                    },
                ],
                content: "",
                role: "assistant",
                text: "",
            } satisfies ChatHistoryMessage,
            label: "attachment-only",
        },
        {
            answer: {
                content: "",
                images: [
                    {
                        data: "image-data",
                        type: "image",
                    },
                ],
                role: "assistant",
                text: "",
            } satisfies ChatHistoryMessage,
            label: "image-only",
        },
        {
            answer: {
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
                text: "",
                toolCalls: [
                    {
                        id: "call-1",
                        name: "write",
                    },
                ],
            } satisfies ChatHistoryMessage,
            label: "final tool-bearing",
        },
    ])("adopts an unscoped $label history final", ({ answer }) => {
        const history = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...answer,
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
        expect(projection.rows.at(-1)).toMatchObject({
            kind: "message",
        });
        expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
        expect(projection.activeRuns).toEqual([]);
    });
    it.each([
        {
            label: "media-only",
            previousAnswer: {
                attachments: [
                    {
                        fileName: "answer.txt",
                        id: "answer",
                        kind: "text",
                    },
                ],
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
                toolCalls: [
                    {
                        id: "call-1",
                        name: "read",
                    },
                ],
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
                message: {
                    text: "second answer",
                },
            });
            expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
            expect(projection.activeRuns).toEqual([]);
        }
    );
    it("hides unfinished unscoped thinking after the next turn starts", () => {
        const visible = presentChatMessages(
            [
                message("user", "first turn"),
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
                },
                message("user", "second turn"),
            ],
            createChatVisibility(true, true),
            true
        );
        expect(visible.map((item) => item.text)).toEqual(["first turn", "second turn"]);
        expect(visible.some((item) => item.thinking?.length)).toBe(false);
    });
    it("hides unscoped thinking from an abandoned response", () => {
        const visible = presentChatMessages(
            [
                message("user", "first turn"),
                {
                    content: [
                        {
                            text: "old thought",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            text: "old thought",
                        },
                    ],
                },
                message("user", "second turn"),
                {
                    content: [
                        {
                            text: "new thought",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            text: "new thought",
                        },
                    ],
                },
                message("assistant", "done"),
            ],
            createChatVisibility(true, true),
            true
        );
        expect(
            visible.map((item) => item.thinking?.map((block) => block.text) || item.text)
        ).toEqual(["first turn", "second turn", ["new thought"], "done"]);
    });
    it("keeps thinking anchored to a settled system answer", () => {
        const visible = presentChatMessages(
            [
                message("user", "first turn"),
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
                    role: "system",
                    text: "system answer",
                    thinking: [
                        {
                            text: "system thought",
                        },
                    ],
                },
                message("user", "second turn"),
            ],
            createChatVisibility(true, true),
            true
        );
        expect(
            visible.map((item) => item.thinking?.map((block) => block.text) || item.text)
        ).toEqual(["first turn", ["system thought"], "system answer", "second turn"]);
    });
    it("keeps prior system thinking out of a later completed response", () => {
        const visible = presentChatMessages(
            [
                message("user", "first turn"),
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
                    content: "first system answer",
                    role: "system",
                    text: "first system answer",
                },
                message("user", "second turn"),
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
                            text: "second thought",
                        },
                    ],
                },
                {
                    content: "second answer",
                    isFinal: true,
                    role: "assistant",
                    text: "second answer",
                },
            ],
            createChatVisibility(true, true),
            true
        );
        expect(
            visible.map(
                (item) =>
                    item.thinking?.map((block) => block.text) ||
                    (item.toolCalls?.length ? "tool" : item.text)
            )
        ).toEqual([
            "first turn",
            "tool",
            ["first thought"],
            "first system answer",
            "second turn",
            ["second thought"],
            "second answer",
        ]);
    });
    it("uses runtime sequence for interleaved tools and steers across replay", () => {
        const runId = "run-1";
        const runtimeEvents: ChatRuntimeEvent[] = [
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
                    runId,
                    text: "",
                    thinking: [
                        {
                            id: "thought-1",
                            text: "working",
                        },
                    ],
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
                        toolCalls: [
                            {
                                id,
                                name,
                            },
                        ],
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
            event(88, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "after restart",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    runId,
                    text: "",
                    thinking: [
                        {
                            id: "thought-2",
                            text: "after restart",
                        },
                    ],
                },
                runId,
            }),
            event(96, {
                kind: "user",
                message: message("user", "second steer", runId),
                runId,
            }),
            event(128, {
                kind: "status",
                runId,
                text: "Working",
            }),
        ].toSorted((left, right) => left.sequence - right.sequence);
        const history = [
            {
                ...message("user", "question"),
                timestamp: NOW,
            },
        ];
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
        const projectedRows = (runtime: ReturnType<typeof createChatRuntimeState>) =>
            projectChat(
                history,
                runtime,
                SESSION,
                createChatVisibility(true, true),
                true,
                new Set()
            ).rows;
        const labels = (runtime: ReturnType<typeof createChatRuntimeState>) =>
            projectedRows(runtime).map((row) =>
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
        const thinkingRows = projectedRows(replayedRuntime).filter(
            (row) => row.message.thinking?.length
        );
        expect(thinkingRows).toHaveLength(1);
        expect(thinkingRows[0]?.message.thinking?.map((block) => block.text)).toEqual([
            "working",
            "after restart",
        ]);
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
    it("interleaves transcript-only restart steers for active and completed replay", () => {
        const runId = "restart-transcript-users";
        const activeRuntime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId,
                text: "Working",
            }),
            runtimeToolEvent(
                32,
                runId,
                "call-1",
                "first-tool",
                "2026-07-16T12:00:01.000Z"
            ),
            runtimeThinkingEvent(48, runId, "2026-07-16T12:00:02.000Z"),
            runtimeToolEvent(
                64,
                runId,
                "call-2",
                "second-tool",
                "2026-07-16T12:00:04.000Z"
            ),
            runtimeToolEvent(
                80,
                runId,
                "call-3",
                "third-tool",
                "2026-07-16T12:00:07.000Z"
            ),
            runtimeThinkingEvent(88, runId, "2026-07-16T12:00:08.500Z"),
            eventAt(96, "2026-07-16T12:00:09.000Z", {
                kind: "status",
                runId,
                text: "Working",
            }),
        ]);
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T11:59:59.900Z",
            },
            {
                ...message(
                    "user",
                    "[System] Your previous turn was interrupted by a gateway restart."
                ),
                timestamp: "2026-07-16T12:00:03.000Z",
            },
            {
                ...message("user", "first steer", "dashboard-chat-first-steer"),
                timestamp: "2026-07-16T12:00:05.000Z",
            },
            {
                ...message("user", "second steer", "dashboard-chat-second-steer"),
                timestamp: "2026-07-16T12:00:08.000Z",
            },
            {
                ...timestampedToolMessage(
                    "call-1",
                    "first-tool",
                    "2026-07-16T12:00:01.000Z"
                ),
                runId,
            },
            {
                ...timestampedToolMessage(
                    "call-2",
                    "second-tool",
                    "2026-07-16T12:00:04.000Z"
                ),
                runId,
            },
            {
                ...timestampedToolMessage(
                    "call-3",
                    "third-tool",
                    "2026-07-16T12:00:07.000Z"
                ),
                runId,
            },
        ];
        const expectedActivity = [
            "question",
            "first-tool",
            "[System] Your previous turn was interrupted by a gateway restart.",
            "second-tool",
            "first steer",
            "third-tool",
            "second steer",
            "thinking",
        ];
        expect(projectionLabels(history, activeRuntime)).toEqual([
            ...expectedActivity,
            "status:Working",
        ]);
        const final = {
            ...message("assistant", "done"),
            timestamp: "2026-07-16T12:00:10.000Z",
        };
        const completedRuntime = reduceChatRuntime(activeRuntime, [
            eventAt(112, "2026-07-16T12:00:10.000Z", {
                kind: "finish",
                message: {
                    ...final,
                    runId,
                },
                outcome: "completed",
                runId,
            }),
        ]);
        expect(projectionLabels([...history, final], completedRuntime)).toEqual([
            ...expectedActivity,
            "done",
        ]);
    });
    it("interleaves a live optimistic steer before its history echo", () => {
        const runId = "active-provider-run";
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId,
                text: "Working",
            }),
            runtimeToolEvent(
                32,
                runId,
                "call-live-1",
                "first-tool",
                "2026-07-16T12:00:01.000Z"
            ),
            runtimeToolEvent(
                48,
                runId,
                "call-live-2",
                "second-tool",
                "2026-07-16T12:00:03.000Z"
            ),
            runtimeToolEvent(
                64,
                runId,
                "call-live-3",
                "third-tool",
                "2026-07-16T12:00:05.000Z"
            ),
            runtimeThinkingEvent(80, runId, "2026-07-16T12:00:06.000Z"),
        ]);
        const optimisticRunId = "dashboard-chat-live-steer";
        const optimisticRuntime = addOptimisticChatRun(runtime, SESSION, optimisticRunId);
        const acknowledgedRuntime = clearChatRun(
            optimisticRuntime,
            SESSION,
            optimisticRunId
        );
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message("user", "live steer", optimisticRunId),
                local: true,
                timestamp: "2026-07-16T12:00:04.000Z",
            },
        ];
        const expected = [
            "question",
            "first-tool",
            "second-tool",
            "live steer",
            "third-tool",
            "thinking",
            "status:Working",
        ];
        expect(projectionLabels(history, optimisticRuntime)).toEqual(expected);
        expect(projectionLabels(history, acknowledgedRuntime)).toEqual(expected);
    });
    it("interleaves completed live steer runs with later active-run tools", () => {
        const runId = "active-provider-run";
        const firstSteerRunId = "dashboard-chat-first-steer";
        const secondSteerRunId = "dashboard-chat-second-steer";
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(16, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId,
                text: "Working",
            }),
            runtimeToolEvent(
                32,
                runId,
                "call-live-1",
                "first-tool",
                "2026-07-16T12:00:01.000Z"
            ),
            eventAt(48, "2026-07-16T12:00:03.500Z", {
                kind: "finish",
                outcome: "completed",
                runId: firstSteerRunId,
            }),
            eventAt(64, "2026-07-16T12:00:03.600Z", {
                kind: "user",
                message: message("user", "first steer", firstSteerRunId),
                runId: firstSteerRunId,
            }),
            runtimeToolEvent(
                80,
                runId,
                "call-live-2",
                "second-tool",
                "2026-07-16T12:00:04.000Z"
            ),
            eventAt(96, "2026-07-16T12:00:06.500Z", {
                kind: "finish",
                outcome: "completed",
                runId: secondSteerRunId,
            }),
            eventAt(112, "2026-07-16T12:00:06.600Z", {
                kind: "user",
                message: message("user", "second steer", secondSteerRunId),
                runId: secondSteerRunId,
            }),
            runtimeToolEvent(
                128,
                runId,
                "call-live-3",
                "third-tool",
                "2026-07-16T12:00:07.000Z"
            ),
            runtimeThinkingEvent(144, runId, "2026-07-16T12:00:08.000Z"),
        ]);
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question", "dashboard-chat-question"),
                timestamp: "2026-07-16T11:59:00.000Z",
            },
            {
                ...message("user", "first steer", firstSteerRunId),
                timestamp: "2026-07-16T12:00:03.000Z",
            },
            {
                ...message("user", "second steer", secondSteerRunId),
                timestamp: "2026-07-16T12:00:06.000Z",
            },
        ];
        expect(projectionLabels(history, runtime)).toEqual([
            "question",
            "first-tool",
            "first steer",
            "second-tool",
            "second steer",
            "third-tool",
            "thinking",
            "status:Working",
        ]);
    });
    it("interleaves steers in a completed history-only turn", () => {
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message(
                    "user",
                    "[System] Your previous turn was interrupted by a gateway restart."
                ),
                timestamp: "2026-07-16T12:00:02.000Z",
            },
            {
                ...message("user", "steer", "dashboard-chat-completed-steer"),
                timestamp: "2026-07-16T12:00:04.000Z",
            },
            timestampedToolMessage(
                "call-completed-1",
                "first-tool",
                "2026-07-16T12:00:01.000Z"
            ),
            timestampedToolMessage(
                "call-completed-2",
                "second-tool",
                "2026-07-16T12:00:03.000Z"
            ),
            timestampedToolMessage(
                "call-completed-3",
                "third-tool",
                "2026-07-16T12:00:05.000Z"
            ),
            {
                ...thinkingMessage("completed-thinking"),
                runId: undefined,
                timestamp: "2026-07-16T12:00:06.000Z",
            },
            {
                ...message("assistant", "done"),
                isFinal: true,
                timestamp: "2026-07-16T12:00:07.000Z",
            },
        ];
        expect(projectionLabels(history, createChatRuntimeState())).toEqual([
            "question",
            "first-tool",
            "[System] Your previous turn was interrupted by a gateway restart.",
            "second-tool",
            "steer",
            "third-tool",
            "thinking",
            "done",
        ]);
    });
    it("keeps intermediate assistant commentary inside a history-only turn", () => {
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...message(
                    "user",
                    "[System] Your previous turn was interrupted by a gateway restart."
                ),
                timestamp: "2026-07-16T12:00:02.500Z",
            },
            {
                ...message("user", "steer", "dashboard-chat-history-steer"),
                timestamp: "2026-07-16T12:00:04.500Z",
            },
            timestampedToolMessage(
                "call-history-1",
                "first-tool",
                "2026-07-16T12:00:01.000Z"
            ),
            {
                ...message("assistant", "still working"),
                timestamp: "2026-07-16T12:00:02.000Z",
            },
            timestampedToolMessage(
                "call-history-2",
                "second-tool",
                "2026-07-16T12:00:03.000Z"
            ),
            timestampedToolMessage(
                "call-history-3",
                "third-tool",
                "2026-07-16T12:00:05.000Z"
            ),
            {
                ...thinkingMessage("completed-history-thinking"),
                runId: undefined,
                timestamp: "2026-07-16T12:00:06.000Z",
            },
            {
                ...message("assistant", "done"),
                isFinal: true,
                timestamp: "2026-07-16T12:00:07.000Z",
            },
        ];
        expect(projectionLabels(history, createChatRuntimeState())).toEqual([
            "question",
            "first-tool",
            "still working",
            "[System] Your previous turn was interrupted by a gateway restart.",
            "second-tool",
            "steer",
            "third-tool",
            "thinking",
            "done",
        ]);
    });
    it("keeps an unmarked completed answer separate from a later final", () => {
        const visible = presentChatMessages(
            [
                {
                    ...message("user", "first question"),
                    timestamp: "2026-07-16T12:00:00.000Z",
                },
                timestampedToolMessage(
                    "call-first-turn",
                    "first-tool",
                    "2026-07-16T12:00:01.000Z"
                ),
                {
                    ...message("assistant", "first answer"),
                    timestamp: "2026-07-16T12:00:02.000Z",
                },
                {
                    ...message("user", "second question"),
                    timestamp: "2026-07-16T12:00:03.000Z",
                },
                timestampedToolMessage(
                    "call-second-turn",
                    "second-tool",
                    "2026-07-16T12:00:04.000Z"
                ),
                {
                    ...message("assistant", "second answer"),
                    isFinal: true,
                    timestamp: "2026-07-16T12:00:05.000Z",
                },
            ],
            createChatVisibility(true, true),
            true
        );
        expect(
            visible.map((item) =>
                item.thinking?.length
                    ? item.thinking[0]!.text
                    : item.toolCalls?.[0]?.name || item.text
            )
        ).toEqual([
            "first question",
            "first-tool",
            "thinking-call-first-turn",
            "first answer",
            "second question",
            "second-tool",
            "thinking-call-second-turn",
            "second answer",
        ]);
    });
    it("uses a recovered history final to settle an active restart replay", () => {
        const runId = "dashboard-chat-recovered-restart";
        const systemContinuation =
            "[System] Your previous turn was interrupted by a gateway restart.";
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(1, "2026-07-16T12:00:00.000Z", {
                kind: "user",
                message: {
                    ...message("user", "question", runId),
                    timestamp: "2026-07-16T12:00:00.000Z",
                },
                runId,
            }),
            runtimeToolEvent(
                2,
                runId,
                "call-recovered-1",
                "first-tool",
                "2026-07-16T12:00:01.000Z"
            ),
            eventAt(3, "2026-07-16T12:00:02.500Z", {
                kind: "assistant",
                message: message("assistant", "running final tool", runId),
                mode: "replace",
                runId,
                source: "session",
            }),
            runtimeToolEvent(
                4,
                runId,
                "call-recovered-2",
                "second-tool",
                "2026-07-16T12:00:03.000Z"
            ),
            runtimeThinkingEvent(5, runId, "2026-07-16T12:00:05.000Z"),
            eventAt(6, "2026-07-16T12:00:05.500Z", {
                kind: "status",
                runId,
                text: "Exec: completed",
            }),
        ]);
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            timestampedToolMessage(
                "call-recovered-1",
                "first-tool",
                "2026-07-16T12:00:01.000Z"
            ),
            {
                ...message("assistant", "running final tool"),
                timestamp: "2026-07-16T12:00:02.500Z",
            },
            {
                ...message("user", systemContinuation),
                timestamp: "2026-07-16T12:00:04.000Z",
            },
            timestampedToolMessage(
                "call-recovered-2",
                "second-tool",
                "2026-07-16T12:00:03.000Z"
            ),
            timestampedToolMessage(
                "call-history-only",
                "history-only-tool",
                "2026-07-16T12:00:04.000Z"
            ),
            {
                ...thinkingMessage("history-final-thinking"),
                content: [
                    {
                        text: "complete recovered reasoning",
                        type: "thinking",
                    },
                    {
                        text: "done",
                        type: "text",
                    },
                ],
                isFinal: true,
                role: "assistant",
                runId: undefined,
                text: "done",
                thinking: [
                    {
                        text: "complete recovered reasoning",
                    },
                ],
                timestamp: "2026-07-16T12:00:06.000Z",
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
        expect(projection.activeRuns).toEqual([]);
        expect(
            projection.rows.filter((row) => row.message.thinking?.length)
        ).toHaveLength(1);
        expect(
            projection.rows
                .find((row) => row.message.thinking?.length)
                ?.message.thinking?.map((block) => block.text)
        ).toEqual(
            expect.arrayContaining(["complete recovered reasoning", "same reasoning"])
        );
        expect(projection.rows.some((row) => row.kind === "typing")).toBe(false);
        expect(
            projection.rows.map(
                (row) => row.message.toolCalls?.[0]?.name || row.message.text
            )
        ).toEqual([
            "question",
            "first-tool",
            "running final tool",
            "second-tool",
            systemContinuation,
            "history-only-tool",
            "",
            "done",
        ]);
    });
    it("hides an abandoned turn's thinking before a sequenced restart prompt", () => {
        const runId = "dashboard-chat-sequenced-restart";
        const raw: ChatHistoryMessage[] = [
            {
                ...message("user", "older question"),
                timestamp: "2026-07-16T11:59:00.000Z",
            },
            timestampedToolMessage(
                "call-older",
                "older-tool",
                "2026-07-16T11:59:01.000Z"
            ),
            {
                ...message("user", "restart question", runId),
                runtimeSequence: 1,
                timestamp: "2026-07-16T12:00:00.000Z",
            },
            {
                ...timestampedToolMessage(
                    "call-current",
                    "current-tool",
                    "2026-07-16T12:00:01.000Z"
                ),
                runId,
                runtimeSequence: 2,
            },
            {
                ...message("user", "[System] Continue after restart.", runId),
                timestamp: "2026-07-16T12:00:02.000Z",
            },
            {
                ...thinkingMessage(runId),
                content: [
                    {
                        text: "current final reasoning",
                        type: "thinking",
                    },
                    {
                        text: "done",
                        type: "text",
                    },
                ],
                isFinal: true,
                text: "done",
                thinking: [
                    {
                        text: "current final reasoning",
                    },
                ],
                timestamp: "2026-07-16T12:00:03.000Z",
            },
        ];
        const visible = presentChatMessages(raw, createChatVisibility(true, true), true);
        const thinkingRows = visible.filter((item) => item.thinking?.length);
        const olderThinkingIndex = visible.findIndex((item) =>
            item.thinking?.some(({ text }) => text === "thinking-call-older")
        );
        const restartPromptIndex = visible.findIndex(
            (item) => item.text === "restart question"
        );
        expect(thinkingRows).toHaveLength(1);
        expect(thinkingRows.filter((item) => item.runId === runId)).toHaveLength(1);
        expect(olderThinkingIndex).toBe(-1);
        expect(restartPromptIndex).toBeGreaterThan(-1);
    });
    it("replaces a live restart run before projecting steers and thinking", () => {
        const beforeRestart = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "user",
                message: message("user", "question", "run-before-restart"),
                runId: "run-before-restart",
            }),
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "tool-before",
                            name: "first-tool",
                        },
                    ],
                },
                runId: "run-before-restart",
                toolKey: "tool:tool-before",
            }),
            event(48, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "before",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "before",
                            text: "before",
                        },
                    ],
                },
                runId: "run-before-restart",
            }),
        ]);
        const liveAfterRestart = reduceChatRuntime(beforeRestart, [
            event(64, {
                kind: "user",
                message: message("user", "steer", "run-after-restart"),
                runAliases: ["run-before-restart"],
                runId: "run-after-restart",
            }),
            event(80, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "tool-after",
                            name: "second-tool",
                        },
                    ],
                },
                runId: "run-after-restart",
                toolKey: "tool:tool-after",
            }),
            event(96, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "after",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "after",
                            text: "after",
                        },
                    ],
                },
                runId: "run-after-restart",
            }),
            event(112, {
                kind: "status",
                runId: "run-after-restart",
                text: "Working",
            }),
        ]);
        const rows = projectChat(
            [],
            liveAfterRestart,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        ).rows;
        const labels = rows.map((row) =>
            row.kind === "typing"
                ? `status:${row.message.text}`
                : row.message.toolCalls?.[0]?.name ||
                  (row.message.thinking?.length ? "thinking" : row.message.text)
        );
        expect(Object.keys(liveAfterRestart.sessions[SESSION]?.runs || {})).toEqual([
            "run-after-restart",
        ]);
        expect(labels).toEqual([
            "question",
            "first-tool",
            "steer",
            "second-tool",
            "thinking",
            "status:Working",
        ]);
        const thinkingRows = rows.filter((row) => row.message.thinking?.length);
        expect(thinkingRows).toHaveLength(1);
        expect(thinkingRows[0]?.message.thinking?.map((block) => block.text)).toEqual([
            "before",
            "after",
        ]);
    });
    it("keeps one parent run through a second restart and mid-run compaction", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "user",
                message: message("user", "question", "run-before-restart"),
                runId: "run-before-restart",
            }),
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "tool-before",
                            name: "first-tool",
                        },
                    ],
                },
                runId: "run-before-restart",
                toolKey: "tool:tool-before",
            }),
            event(48, {
                kind: "user",
                message: message(
                    "user",
                    "steer after first restart",
                    "run-after-first-restart"
                ),
                runAliases: ["run-before-restart"],
                runId: "run-after-first-restart",
            }),
            event(64, {
                kind: "status",
                operation: "compact",
                operationPhase: "active",
                runId: "compaction:run-after-first-restart",
                text: "Compacting context",
            }),
            event(80, {
                kind: "status",
                operation: "compact",
                operationPhase: "complete",
                runId: "compaction:run-after-first-restart",
                text: "Context compacted",
            }),
            event(96, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        {
                            id: "tool-after",
                            name: "second-tool",
                        },
                    ],
                },
                runAliases: ["run-after-first-restart"],
                runId: "run-after-second-restart",
                toolKey: "tool:tool-after",
            }),
            event(112, {
                kind: "user",
                message: message(
                    "user",
                    "steer after second restart",
                    "run-after-second-restart"
                ),
                runId: "run-after-second-restart",
            }),
            event(128, {
                kind: "thinking",
                message: {
                    content: [
                        {
                            text: "after compaction",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    text: "",
                    thinking: [
                        {
                            id: "after-compaction",
                            text: "after compaction",
                        },
                    ],
                },
                runId: "run-after-second-restart",
            }),
            event(144, {
                kind: "finish",
                message: message("assistant", "done", "run-after-second-restart"),
                outcome: "completed",
                runId: "run-after-second-restart",
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
        const labels = projection.rows.map(
            (row) =>
                row.message.toolCalls?.[0]?.name ||
                (row.message.thinking?.length ? "thinking" : row.message.text)
        );
        expect(Object.keys(runtime.sessions[SESSION]?.runs || {}).toSorted()).toEqual(
            ["compaction:run-after-first-restart", "run-after-second-restart"].toSorted()
        );
        expect(projection.activeRuns).toEqual([]);
        expect(projection.compactionStatus).toMatchObject({
            phase: "complete",
        });
        expect(labels).toEqual([
            "question",
            "first-tool",
            "steer after first restart",
            "second-tool",
            "steer after second restart",
            "thinking",
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
                    toolCalls: [
                        {
                            id: "call-skewed",
                            name: "first-tool",
                        },
                    ],
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
                    content: [
                        {
                            text: "working",
                            type: "thinking",
                        },
                    ],
                    role: "assistant",
                    runId,
                    text: "",
                    thinking: [
                        {
                            id: "thought-skewed",
                            text: "working",
                        },
                    ],
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
    it("recovers pre-steer thinking when runtime only echoes a late steer", () => {
        const runId = "reconstructed-late-steer";
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            eventAt(8, "2026-07-16T12:00:00.000Z", {
                kind: "status",
                runId,
                text: "Thinking",
            }),
            eventAt(16, "2026-07-16T12:00:00.500Z", {
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
                            id: "thought-recovered",
                            text: "working",
                        },
                    ],
                },
                runId,
            }),
            eventAt(32, "2026-07-16T12:00:05.000Z", {
                kind: "user",
                message: message("user", "steer", runId),
                runId,
            }),
        ]);
        const history: ChatHistoryMessage[] = [
            {
                ...message("user", "question"),
                timestamp: "2026-07-16T11:59:59.500Z",
            },
            {
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
                        id: "thought-recovered",
                        text: "working",
                    },
                ],
                timestamp: "2026-07-16T12:00:00.500Z",
            },
        ];
        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
        const thinking = reconciled.filter((item) => item.thinking?.length);
        expect(thinking).toHaveLength(1);
        expect(thinking[0]?.runId).toBe(runId);
        expect(
            projectChat(
                history,
                runtime,
                SESSION,
                createChatVisibility(true, true),
                true,
                new Set()
            ).rows.map((row) =>
                row.message.thinking?.length ? "thinking" : row.message.text
            )
        ).toEqual(["question", "steer", "thinking", "Thinking"]);
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
        expect(projection.compactionStatus).toMatchObject({
            phase: "complete",
        });
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
        expect(projection.compactionStatus).toMatchObject({
            phase: "complete",
        });
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
        };
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
