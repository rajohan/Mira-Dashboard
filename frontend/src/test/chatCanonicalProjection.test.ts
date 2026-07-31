import { describe, expect, it } from "bun:test";

import { canonicalizeOpenClawHistoryPage } from "../../../contracts/chat/openClawHistoryPageAdapter";
import { withCanonicalOpenClawEvents } from "../../../contracts/chat/openClawRuntimeAdapter";
import {
    assembleCanonicalChatTurns,
    projectCanonicalChat,
} from "../components/features/chat/domain/chatCanonicalProjection";
import { createChatVisibility } from "../components/features/chat/domain/chatPresentation";
import { renderChatProjectionRows } from "../components/features/chat/domain/chatProjection";
import {
    createChatRuntimeState,
    reduceChatRuntime,
} from "../components/features/chat/domain/chatState";
import { OpenClawChatAdapter } from "../components/features/chat/transport/openClawChatAdapter";

const SESSION = "agent:main:canonical-turn-probe";
const RUN = "synthetic-turn-run";

function runtimeEnvelope(message: Record<string, unknown>, runtimeSequence: number) {
    const at = Date.parse(
        `2026-07-30T06:20:${String(runtimeSequence).padStart(2, "0")}.000Z`
    );
    return withCanonicalOpenClawEvents({
        event: "session.message",
        payload: {
            message,
            runId: RUN,
            sessionKey: SESSION,
            ts: at,
        },
        runtimeRecordedAt: at,
        runtimeSequence,
        type: "event",
    });
}

function provenanceBackfillMessage(id: string, sequence: number) {
    return {
        content: "repeat",
        provenance: {
            id,
            sequence,
            source: "openclaw-history" as const,
        },
        role: "user",
        text: "repeat",
    };
}

interface DefaultProjectionOptions {
    deletedMessageKeys?: ReadonlySet<string>;
    runtime?: ReturnType<typeof createChatRuntimeState>;
    sessionKey?: string;
    shouldKeepThinkingAfterFinal?: boolean;
    visibility?: ReturnType<typeof createChatVisibility>;
}

function projectDefault(
    history: Parameters<typeof projectCanonicalChat>[0],
    options: DefaultProjectionOptions = {}
) {
    return projectCanonicalChat(
        history,
        options.runtime ?? createChatRuntimeState(),
        options.sessionKey ?? SESSION,
        options.visibility ?? createChatVisibility(true, true),
        options.shouldKeepThinkingAfterFinal ?? true,
        options.deletedMessageKeys ?? new Set()
    );
}

describe("canonical chat turn projection", () => {
    it("classifies system finals with answer and tool metadata as assistant output", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: [{ text: "Completed with tool context.", type: "text" }],
                    isFinal: true,
                    role: "system",
                    text: "Completed with tool context.",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "functions.exec_command",
                            toolResult: {
                                content: "/workspace",
                                id: "call-1",
                                name: "functions.exec_command",
                            },
                        },
                    ],
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(1);
        expect(turns[0]?.entries).toHaveLength(1);
        expect(turns[0]?.entries[0]).toMatchObject({
            kind: "assistant",
            message: { text: "Completed with tool context." },
        });
    });

    it("normalizes thinking from system finals before canonical validation", () => {
        const result = projectDefault([
            {
                content: "Completed after analysis.",
                isFinal: true,
                role: "system",
                text: "Completed after analysis.",
                thinking: [{ text: "private analysis" }],
            },
        ]);

        expect(result.turns[0]?.entries.map((entry) => entry.kind)).toEqual([
            "thinking",
            "assistant",
        ]);

        const withoutSettledThinking = projectDefault(
            [
                {
                    content: "Completed after analysis.",
                    isFinal: true,
                    role: "system",
                    text: "Completed after analysis.",
                    thinking: [{ text: "private analysis" }],
                },
            ],
            { shouldKeepThinkingAfterFinal: false }
        );
        expect(
            withoutSettledThinking.projection.rows.map((row) => row.message.text)
        ).toEqual(["Completed after analysis."]);
    });

    it("omits stripped thinking placeholders from canonical turns", () => {
        const result = projectDefault([
            {
                content: [{ text: "Inspecting state", type: "thinking" }],
                role: "assistant",
                text: "",
                thinking: [{ text: "Inspecting state" }],
            },
        ]);

        expect(result.turns).toHaveLength(1);
        expect(result.turns[0]?.entries.map((entry) => entry.kind)).toEqual(["thinking"]);
    });

    it("retains stable source, sequence, lifecycle, and provider metadata", () => {
        const adapter = new OpenClawChatAdapter();
        const historyPage = canonicalizeOpenClawHistoryPage(
            {
                hasMore: false,
                messages: [
                    {
                        __openclaw: { id: "synthetic-user-1", seq: 1 },
                        content: "Inspect the repository",
                        role: "user",
                        runId: RUN,
                        timestamp: "2026-07-30T06:20:01.000Z",
                    },
                ],
                offset: 0,
                sessionId: "synthetic-session",
                totalMessages: 1,
            },
            { offset: 0, sessionKey: SESSION }
        );
        const history = adapter.history(historyPage.messages);
        const runtimeEvents = [
            ...adapter.event(
                runtimeEnvelope(
                    {
                        content: [
                            {
                                thinking: "Inspect current state.",
                                type: "thinking",
                            },
                            {
                                arguments: { command: "pwd" },
                                id: "synthetic-tool-1",
                                name: "functions.exec_command",
                                type: "toolCall",
                            },
                        ],
                        model: "syn:large:text",
                        provider: "synthetic",
                        role: "assistant",
                        stopReason: "toolUse",
                    },
                    2
                )
            ),
            ...adapter.event(
                runtimeEnvelope(
                    {
                        content: [{ text: "/workspace", type: "text" }],
                        model: "syn:large:text",
                        provider: "synthetic",
                        role: "toolResult",
                        toolCallId: "synthetic-tool-1",
                        toolName: "functions.exec_command",
                    },
                    3
                )
            ),
            ...adapter.event(
                runtimeEnvelope(
                    {
                        content: [
                            {
                                text: "Repository inspection complete.",
                                type: "text",
                            },
                        ],
                        model: "syn:large:text",
                        provider: "synthetic",
                        role: "assistant",
                        stopReason: "stop",
                    },
                    4
                )
            ),
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), runtimeEvents);

        const first = projectDefault(history, { runtime });
        const replay = projectDefault(history, { runtime });
        const hiddenDiagnostics = projectDefault(history, {
            runtime,
            shouldKeepThinkingAfterFinal: false,
            visibility: createChatVisibility(false, false),
        });
        const turn = first.turns[0];

        expect(turn).toMatchObject({
            lifecycle: "completed",
            providers: expect.arrayContaining([
                expect.objectContaining({
                    eventName: "chat.history",
                    format: "openclaw-history",
                }),
                expect.objectContaining({
                    eventName: "session.message",
                    format: "openclaw-session-message",
                    model: "syn:large:text",
                    provider: "synthetic",
                }),
            ]),
            runId: RUN,
            schemaVersion: 1,
            sessionKey: SESSION,
        });
        expect(turn?.entries.map((entry) => entry.source)).toEqual([
            "openclaw-history",
            "openclaw-runtime",
            "openclaw-runtime",
            "openclaw-runtime",
        ]);
        expect(turn?.entries.map((entry) => entry.origin)).toEqual([
            undefined,
            "openclaw-session",
            "openclaw-session",
            "openclaw-session",
        ]);
        expect(turn?.entries.map((entry) => entry.kind)).toEqual([
            "user",
            "tool",
            "thinking",
            "assistant",
        ]);
        const toolEventSequences = runtimeEvents.flatMap((event) =>
            event.kind === "tool" ? [event.sequence] : []
        );
        expect(toolEventSequences.length).toBeGreaterThan(1);
        expect(turn?.entries.find((entry) => entry.kind === "tool")?.sequence).toBe(
            Math.min(...toolEventSequences)
        );
        expect(turn?.sequenceStart).toBe(1);
        expect(turn?.sequenceEnd).toBeGreaterThan(turn?.sequenceStart ?? 0);
        expect(replay.turns.map((candidate) => candidate.id)).toEqual(
            first.turns.map((candidate) => candidate.id)
        );
        expect(hiddenDiagnostics.turns).toEqual(first.turns);
        expect(
            replay.turns.flatMap((candidate) =>
                candidate.entries.map((entry) => entry.id)
            )
        ).toEqual(
            first.turns.flatMap((candidate) => candidate.entries.map((entry) => entry.id))
        );
    });

    it("builds stable history-only turns without inventing lifecycle evidence", () => {
        const messages = [
            {
                content: "first question",
                role: "user",
                text: "first question",
                timestamp: "2026-07-30T06:30:00.000Z",
            },
            {
                content: "first answer",
                role: "assistant",
                text: "first answer",
                timestamp: "2026-07-30T06:30:01.000Z",
            },
            {
                content: "second question",
                role: "user",
                text: "second question",
                timestamp: "2026-07-30T06:31:00.000Z",
            },
            {
                content: "second answer",
                role: "assistant",
                text: "second answer",
                timestamp: "2026-07-30T06:31:01.000Z",
            },
        ];

        const first = assembleCanonicalChatTurns(messages, [], SESSION);
        const replay = assembleCanonicalChatTurns(messages, [], SESSION);

        expect(first).toHaveLength(2);
        expect(first.map((turn) => turn.lifecycle)).toEqual(["unknown", "unknown"]);
        expect(replay.map((turn) => turn.id)).toEqual(first.map((turn) => turn.id));
    });

    it("splits consecutive runless prompts without continuation evidence", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "abandoned question",
                    role: "user",
                    text: "abandoned question",
                },
                {
                    content: "replacement question",
                    role: "user",
                    text: "replacement question",
                },
                {
                    content: "replacement answer",
                    role: "assistant",
                    text: "replacement answer",
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(2);
        expect(turns.map((turn) => turn.entries.map((entry) => entry.kind))).toEqual([
            ["user"],
            ["user", "assistant"],
        ]);
    });

    it("keeps a runless steer with an in-progress tool response", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "initial question",
                    role: "user",
                    text: "initial question",
                },
                {
                    content: "tool output",
                    role: "toolResult",
                    text: "tool output",
                    toolResult: {
                        content: "tool output",
                        id: "tool-1",
                        name: "search",
                    },
                },
                {
                    content: "steer the response",
                    role: "user",
                    text: "steer the response",
                },
                {
                    content: "final answer",
                    role: "assistant",
                    text: "final answer",
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(1);
        expect(turns[0]?.entries.map((entry) => entry.kind)).toEqual([
            "user",
            "tool",
            "user",
            "assistant",
        ]);
    });

    it("keeps a runless steer with a thinking-only response", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "initial question",
                    role: "user",
                    text: "initial question",
                },
                {
                    content: [{ text: "working through it", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "working through it" }],
                },
                {
                    content: "steer the response",
                    role: "user",
                    text: "steer the response",
                },
                {
                    content: "final answer",
                    role: "assistant",
                    text: "final answer",
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(1);
        expect(turns[0]?.entries.map((entry) => entry.kind)).toEqual([
            "user",
            "thinking",
            "user",
            "assistant",
        ]);
    });

    it("preserves a thinking-only runless steer through production structuring", () => {
        const result = projectCanonicalChat(
            [
                {
                    content: "initial question",
                    role: "user",
                    text: "initial question",
                },
                {
                    content: [{ text: "working through it", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "working through it" }],
                },
                {
                    content: "steer",
                    role: "user",
                    text: "steer",
                },
                {
                    content: "done",
                    isFinal: true,
                    role: "assistant",
                    text: "done",
                },
            ],
            createChatRuntimeState(),
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(result.turns).toHaveLength(1);
        expect(result.turns[0]?.entries.map((entry) => entry.kind)).toEqual([
            "user",
            "user",
            "thinking",
            "assistant",
        ]);
        expect(result.projection.rows.map((row) => row.message.text)).toEqual([
            "initial question",
            "steer",
            "",
            "done",
        ]);
    });

    it("keeps a runless steer with tool-use commentary", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "initial question",
                    role: "user",
                    text: "initial question",
                },
                {
                    content: "Calling the tool.",
                    isToolUse: true,
                    role: "assistant",
                    text: "Calling the tool.",
                },
                {
                    content: "steer the response",
                    role: "user",
                    text: "steer the response",
                },
                {
                    content: "final answer",
                    role: "assistant",
                    text: "final answer",
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(1);
        expect(turns[0]?.entries.map((entry) => entry.kind)).toEqual([
            "user",
            "tool",
            "user",
            "assistant",
        ]);
    });

    it("preserves provider run identity on history-only turns", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "question",
                    role: "user",
                    runId: "history-provider-run",
                    text: "question",
                },
                {
                    content: "answer",
                    role: "assistant",
                    runId: "history-provider-run",
                    text: "answer",
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            lifecycle: "unknown",
            runId: "history-provider-run",
        });
    });

    it("keeps the primary history sequence after runtime reconciliation", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "reconciled question",
                    provenance: {
                        id: "history-question",
                        sequence: 2,
                        source: "openclaw-history",
                    },
                    role: "user",
                    runId: "provider-run",
                    runtimeSequence: 9,
                    text: "reconciled question",
                },
            ],
            [],
            SESSION
        );

        expect(turns[0]).toMatchObject({
            sequenceEnd: 2,
            sequenceStart: 2,
        });
        expect(turns[0]?.entries[0]).toMatchObject({
            sequence: 2,
            source: "openclaw-history",
        });
    });

    it("splits a new provider run after a diagnostic-only history turn", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "",
                    role: "assistant",
                    runId: "failed-provider-run",
                    text: "",
                    thinking: [{ text: "partial diagnostic" }],
                },
                {
                    content: "retry",
                    role: "user",
                    runId: "retry-provider-run",
                    text: "retry",
                },
                {
                    content: "recovered",
                    role: "assistant",
                    runId: "retry-provider-run",
                    text: "recovered",
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(2);
        expect(turns.map((turn) => turn.runId)).toEqual([
            "failed-provider-run",
            "retry-provider-run",
        ]);
        expect(turns.map((turn) => turn.entries.map((entry) => entry.kind))).toEqual([
            ["thinking"],
            ["user", "assistant"],
        ]);
    });

    it("starts run-backed output after an answered runless history turn", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "question",
                    role: "user",
                    text: "question",
                },
                {
                    content: "answer",
                    role: "assistant",
                    text: "answer",
                },
                {
                    content: "",
                    role: "assistant",
                    runId: "runtime-run",
                    text: "",
                    thinking: [{ text: "new runtime work" }],
                },
            ],
            [
                {
                    aliases: [],
                    diagnostics: [],
                    lastSequence: 3,
                    phase: "active",
                    runId: "runtime-run",
                    sessionKey: SESSION,
                    startedAt: "2026-07-30T06:32:00.000Z",
                    updatedAt: "2026-07-30T06:32:00.000Z",
                    userMessages: [],
                },
            ],
            SESSION
        );

        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({
            lifecycle: "unknown",
            runId: undefined,
        });
        expect(turns[1]).toMatchObject({
            lifecycle: "active",
            runId: "runtime-run",
        });
        expect(turns.map((turn) => turn.entries.map((entry) => entry.kind))).toEqual([
            ["user", "assistant"],
            ["thinking"],
        ]);
    });

    it("starts provider output after an answered runless turn without runtime state", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "question",
                    role: "user",
                    text: "question",
                },
                {
                    content: "first answer",
                    role: "assistant",
                    text: "first answer",
                },
                {
                    content: "new provider output",
                    role: "assistant",
                    runId: "provider-run-without-runtime",
                    text: "new provider output",
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(2);
        expect(turns.map((turn) => turn.runId)).toEqual([
            undefined,
            "provider-run-without-runtime",
        ]);
        expect(
            turns.map((turn) => turn.entries.map((entry) => entry.message.text))
        ).toEqual([["question", "first answer"], ["new provider output"]]);
    });

    it("starts a new turn after a final tool-bearing assistant answer", () => {
        const turns = assembleCanonicalChatTurns(
            [
                {
                    content: "first question",
                    role: "user",
                    text: "first question",
                },
                {
                    content: "first answer",
                    isFinal: true,
                    role: "assistant",
                    text: "first answer",
                    toolCalls: [
                        {
                            arguments: { query: "first" },
                            id: "call-1",
                            name: "search",
                            toolResult: {
                                content: "result",
                                id: "call-1",
                                name: "search",
                            },
                        },
                    ],
                },
                {
                    content: "second question",
                    role: "user",
                    text: "second question",
                },
                {
                    content: "second answer",
                    role: "assistant",
                    text: "second answer",
                },
            ],
            [],
            SESSION
        );

        expect(turns).toHaveLength(2);
        expect(turns[0]?.entries.map((entry) => entry.kind)).toEqual([
            "user",
            "assistant",
        ]);
        expect(turns[1]?.entries.map((entry) => entry.kind)).toEqual([
            "user",
            "assistant",
        ]);
    });

    it("carries folded history tool-result provenance into turn ranges", () => {
        const adapter = new OpenClawChatAdapter();
        const page = canonicalizeOpenClawHistoryPage(
            {
                hasMore: false,
                messages: [
                    {
                        __openclaw: { id: "history-call", seq: 2 },
                        content: [
                            {
                                arguments: { command: "pwd" },
                                id: "call-1",
                                name: "functions.exec_command",
                                type: "toolCall",
                            },
                        ],
                        provider: "openai",
                        role: "assistant",
                        runId: "history-run",
                    },
                    {
                        __openclaw: { id: "history-result", seq: 3 },
                        content: [{ text: "/workspace", type: "text" }],
                        provider: "openai",
                        role: "toolResult",
                        runId: "history-run",
                        toolCallId: "call-1",
                        toolName: "functions.exec_command",
                    },
                ],
                offset: 0,
                totalMessages: 2,
            },
            { offset: 0, sessionKey: SESSION }
        );
        const history = adapter.history(page.messages);
        const turns = assembleCanonicalChatTurns(history, [], SESSION);

        expect(history).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            runId: "history-run",
            sequenceEnd: 3,
            sequenceStart: 2,
        });
        expect(turns[0]?.entries[0]?.relatedSources).toEqual([
            expect.objectContaining({
                id: expect.stringContaining("history-result"),
                sequence: 3,
                source: "openclaw-history",
            }),
        ]);
    });

    it("carries every folded thinking source into the canonical entry", () => {
        const provider = {
            eventName: "chat.history",
            format: "openclaw-history" as const,
        };
        const result = projectDefault([
            {
                content: "question",
                role: "user",
                text: "question",
            },
            {
                content: [{ text: "first thought", type: "thinking" }],
                provenance: {
                    id: "thinking-source-1",
                    provider,
                    sequence: 2,
                    source: "openclaw-history",
                },
                role: "assistant",
                text: "",
                thinking: [{ text: "first thought" }],
            },
            {
                content: [{ text: "second thought", type: "thinking" }],
                provenance: {
                    id: "thinking-source-2",
                    provider,
                    sequence: 3,
                    source: "openclaw-history",
                },
                role: "assistant",
                text: "",
                thinking: [{ text: "second thought" }],
            },
            {
                content: "answer",
                isFinal: true,
                role: "assistant",
                text: "answer",
            },
        ]);
        const thinkingEntry = result.turns[0]?.entries.find(
            (entry) => entry.kind === "thinking"
        );

        expect(thinkingEntry?.sequence).toBe(3);
        expect(thinkingEntry?.relatedSources).toEqual([
            expect.objectContaining({
                id: "thinking-source-1",
                sequence: 2,
                source: "openclaw-history",
            }),
        ]);
    });

    it("treats an unselected idle chat as an empty canonical projection", () => {
        const result = projectDefault([], { sessionKey: "" });

        expect(result.turns).toEqual([]);
        expect(result.projection.rows).toEqual([]);
    });

    it("keeps full media in canonical turns", () => {
        const imageData = "a".repeat(200_000);
        const result = projectDefault([
            {
                content: [{ data: imageData, mimeType: "image/png", type: "image" }],
                images: [
                    {
                        data: imageData,
                        mimeType: "image/png",
                        type: "image",
                    },
                ],
                role: "user",
                text: "",
            },
        ]);

        expect(result.turns[0]?.entries[0]?.message.images?.[0]?.data).toBe(imageData);
    });

    it("renders repeated metadata-free prompts with stable unique row keys", () => {
        const history = [
            { content: "repeat", role: "user", text: "repeat" },
            { content: "first answer", role: "assistant", text: "first answer" },
            { content: "repeat", role: "user", text: "repeat" },
            { content: "second answer", role: "assistant", text: "second answer" },
        ];
        const first = projectDefault(history);
        const replay = projectDefault(history);
        const keys = first.projection.rows.map((row) => row.key);

        expect(first.projection.rows.map((row) => row.message.text)).toEqual([
            "repeat",
            "first answer",
            "repeat",
            "second answer",
        ]);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys[0]).toBe("user::no-time::no-run::repeat");
        expect(keys[2]).toStartWith("chat-row-occurrence:v1:");
        expect(keys[2]).not.toBe(keys[0]);
        expect(first.projection.rows[0]?.deleteKeys).toEqual([keys[0]]);
        expect(first.projection.rows[2]?.deleteKeys).toEqual([keys[2]]);
        expect(replay.projection.rows.map((row) => row.key)).toEqual(keys);

        const withoutFirstPrompt = projectDefault(history, {
            deletedMessageKeys: new Set(first.projection.rows[0]?.deleteKeys),
        });
        expect(withoutFirstPrompt.projection.rows.map((row) => row.message.text)).toEqual(
            ["first answer", "repeat", "second answer"]
        );

        const withoutSecondPrompt = projectDefault(history, {
            deletedMessageKeys: new Set(first.projection.rows[2]?.deleteKeys),
        });
        expect(
            withoutSecondPrompt.projection.rows.map((row) => row.message.text)
        ).toEqual(["repeat", "first answer", "second answer"]);
    });

    it("keeps provenance-backed delete keys stable across duplicate backfills", () => {
        const originalHistory = [
            provenanceBackfillMessage("history-2", 2),
            provenanceBackfillMessage("history-3", 3),
        ];
        const original = projectDefault(originalHistory).projection;
        const originalTarget = original.rows.find(
            (row) => row.message.provenance?.id === "history-2"
        );
        const backfilledHistory = [
            provenanceBackfillMessage("history-1", 1),
            ...originalHistory,
        ];
        const backfilled = projectDefault(backfilledHistory).projection;
        const backfilledTarget = backfilled.rows.find(
            (row) => row.message.provenance?.id === "history-2"
        );

        expect(originalTarget?.key).toStartWith("chat-message-source:v1:");
        expect(backfilledTarget?.deleteKeys).toEqual(originalTarget?.deleteKeys);

        const withoutTarget = projectDefault(backfilledHistory, {
            deletedMessageKeys: new Set(originalTarget?.deleteKeys),
        }).projection;
        expect(withoutTarget.rows.map((row) => row.message.provenance?.id)).toEqual([
            "history-1",
            "history-3",
        ]);
    });

    it("keeps an optimistic user delete hidden after provenance recovery", () => {
        const optimisticRunId = "dashboard-chat-delete";
        const optimistic = projectDefault([
            {
                content: "queued prompt",
                local: true,
                role: "user",
                runId: optimisticRunId,
                text: "queued prompt",
                timestamp: "2026-07-31T04:00:00.000Z",
            },
        ]).projection;
        const optimisticDeleteKeys = optimistic.rows[0]?.deleteKeys;
        const recovered = projectDefault(
            [
                {
                    content: "queued prompt",
                    provenance: {
                        id: "history-prompt",
                        sequence: 12,
                        source: "openclaw-history",
                    },
                    role: "user",
                    text: "queued prompt",
                    timestamp: "2026-07-31T04:00:02.000Z",
                },
            ],
            { deletedMessageKeys: new Set(optimisticDeleteKeys) }
        ).projection;

        expect(optimisticDeleteKeys?.slice(0, 2)).toEqual([
            "user::2026-07-31T04:00:00.000Z::no-run::queued prompt",
            "user::no-time::dashboard-chat-delete::queued prompt",
        ]);
        expect(
            optimisticDeleteKeys?.some((key) =>
                key.startsWith("chat-user-recovery:v1:time-")
            )
        ).toBe(true);
        expect(
            optimisticDeleteKeys?.some((key) =>
                key.startsWith("chat-user-recovery:v1:no-time:")
            )
        ).toBe(true);
        expect(recovered.rows).toEqual([]);

        const recoveredWithoutTimestamp = projectDefault(
            [
                {
                    content: "queued prompt",
                    provenance: {
                        id: "history-prompt-without-time",
                        sequence: 13,
                        source: "openclaw-history",
                    },
                    role: "user",
                    text: "queued prompt",
                },
            ],
            { deletedMessageKeys: new Set(optimisticDeleteKeys) }
        ).projection;
        expect(recoveredWithoutTimestamp.rows).toEqual([]);

        const recoveredWithProviderRun = projectDefault(
            [
                {
                    content: "queued prompt",
                    provenance: {
                        id: "history-provider-prompt",
                        sequence: 14,
                        source: "openclaw-history",
                    },
                    role: "user",
                    runId: "provider-run-after-reload",
                    text: "queued prompt",
                    timestamp: "2026-07-31T04:00:02.000Z",
                },
            ],
            { deletedMessageKeys: new Set(optimisticDeleteKeys) }
        ).projection;
        expect(recoveredWithProviderRun.rows).toEqual([]);

        const laterUnrelatedPrompt = projectDefault(
            [
                {
                    content: "queued prompt",
                    provenance: {
                        id: "later-history-prompt",
                        sequence: 30,
                        source: "openclaw-history",
                    },
                    role: "user",
                    runId: "provider-later",
                    text: "queued prompt",
                    timestamp: "2026-07-31T05:00:00.000Z",
                },
            ],
            { deletedMessageKeys: new Set(optimisticDeleteKeys) }
        ).projection;
        expect(laterUnrelatedPrompt.rows.map((row) => row.message.text)).toEqual([
            "queued prompt",
        ]);
    });

    it("keeps fallback history deletes hidden when page positions move", () => {
        const fallbackPrompt = {
            content: "position-independent prompt",
            role: "user",
            text: "position-independent prompt",
            timestamp: "2026-07-31T04:01:00.000Z",
        };
        const original = projectDefault([
            {
                ...fallbackPrompt,
                provenance: {
                    id: "openclaw-history:agent%3Amain%3Amain:position%3A0%3Afingerprint%3Aoriginal",
                    source: "openclaw-history" as const,
                },
            },
        ]).projection;
        const shiftedVisible = projectDefault([
            {
                ...fallbackPrompt,
                provenance: {
                    id: "openclaw-history:agent%3Amain%3Amain:position%3A1%3Afingerprint%3Aoriginal",
                    source: "openclaw-history" as const,
                },
            },
        ]).projection;
        const shifted = projectDefault(
            [
                {
                    ...fallbackPrompt,
                    provenance: {
                        id: "openclaw-history:agent%3Amain%3Amain:position%3A1%3Afingerprint%3Aoriginal",
                        source: "openclaw-history" as const,
                    },
                },
            ],
            { deletedMessageKeys: new Set(original.rows[0]?.deleteKeys) }
        ).projection;

        expect(shiftedVisible.rows[0]?.key).toBe(original.rows[0]?.key);
        expect(original.rows[0]?.deleteKeys).toContain(
            "user::2026-07-31T04:01:00.000Z::no-run::position-independent prompt"
        );
        expect(shifted.rows).toEqual([]);
    });

    it("keeps fallback assistant row keys stable when page positions move", () => {
        const fallbackAnswer = {
            content: "position-independent answer",
            role: "assistant",
            text: "position-independent answer",
            timestamp: "2026-07-31T04:02:00.000Z",
        };
        const original = projectDefault([
            {
                ...fallbackAnswer,
                provenance: {
                    id: "openclaw-history:agent%3Amain%3Amain:position%3A0%3Afingerprint%3Aanswer",
                    source: "openclaw-history" as const,
                },
            },
        ]).projection;
        const shifted = projectDefault([
            {
                ...fallbackAnswer,
                provenance: {
                    id: "openclaw-history:agent%3Amain%3Amain:position%3A1%3Afingerprint%3Aanswer",
                    source: "openclaw-history" as const,
                },
            },
        ]).projection;

        expect(shifted.rows[0]?.key).toBe(original.rows[0]?.key);
    });

    it("keeps a stream row key stable as runtime provenance grows", () => {
        const stream = {
            content: "partial answer",
            local: true,
            provenance: {
                id: "runtime-assistant-16",
                sequence: 16,
                source: "openclaw-runtime" as const,
            },
            role: "assistant",
            runId: RUN,
            runtimeKey: "assistant",
            text: "partial answer",
        };
        const initial = renderChatProjectionRows([stream], new Set(), []);
        const continued = renderChatProjectionRows(
            [
                {
                    ...stream,
                    provenance: {
                        ...stream.provenance,
                        relatedSources: [
                            {
                                id: "runtime-assistant-112",
                                sequence: 112,
                                source: "openclaw-runtime" as const,
                            },
                        ],
                    },
                },
            ],
            new Set(),
            []
        );

        expect(continued[0]?.key).toBe(initial[0]?.key);
    });

    it("fails closed when canonical validation detects an invalid session", () => {
        expect(() =>
            projectDefault([{ content: "orphan", role: "user", text: "orphan" }], {
                sessionKey: "",
            })
        ).toThrow("Canonical chat projection invariant failed: session");
    });
});
