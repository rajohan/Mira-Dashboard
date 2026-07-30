import { describe, expect, it } from "bun:test";

import { canonicalizeOpenClawHistoryPage } from "../../../contracts/chat/openClawHistoryPageAdapter";
import { withCanonicalOpenClawEvents } from "../../../contracts/chat/openClawRuntimeAdapter";
import {
    assembleCanonicalChatTurns,
    projectChatWithCanonicalShadow,
} from "../components/features/chat/domain/chatCanonicalProjection";
import { createChatVisibility } from "../components/features/chat/domain/chatPresentation";
import {
    createChatRuntimeState,
    reduceChatRuntime,
} from "../components/features/chat/domain/chatState";
import { OpenClawChatAdapter } from "../components/features/chat/transport/openClawChatAdapter";

const SESSION = "agent:main:canonical-turn-probe";
const RUN = "synthetic-turn-run";

function runtimeEnvelope(message: Record<string, unknown>, runtimeSequence: number) {
    return withCanonicalOpenClawEvents({
        event: "session.message",
        payload: {
            message,
            runId: RUN,
            sessionKey: SESSION,
            ts: Date.parse(`2026-07-30T06:20:0${runtimeSequence}.000Z`),
        },
        runtimeRecordedAt: Date.parse(`2026-07-30T06:20:0${runtimeSequence}.000Z`),
        runtimeSequence,
        type: "event",
    });
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
        const result = projectChatWithCanonicalShadow(
            [
                {
                    content: "Completed after analysis.",
                    isFinal: true,
                    role: "system",
                    text: "Completed after analysis.",
                    thinking: [{ text: "private analysis" }],
                },
            ],
            createChatRuntimeState(),
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(result.comparison).toMatchObject({
            differenceKinds: [],
            matches: true,
            turnCount: 1,
        });
        expect(result.canonical?.turns[0]?.entries.map((entry) => entry.kind)).toEqual([
            "thinking",
            "assistant",
        ]);
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

        const first = projectChatWithCanonicalShadow(
            history,
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const replay = projectChatWithCanonicalShadow(
            history,
            runtime,
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );
        const hiddenDiagnostics = projectChatWithCanonicalShadow(
            history,
            runtime,
            SESSION,
            createChatVisibility(false, false),
            false,
            new Set()
        );
        const turn = first.canonical?.turns[0];

        expect(first.comparison).toMatchObject({
            differenceKinds: [],
            matches: true,
            schemaVersion: 1,
            turnCount: 1,
        });
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
            "openclaw-runtime",
        ]);
        expect(turn?.entries.map((entry) => entry.origin)).toEqual([
            undefined,
            "openclaw-session",
            "openclaw-session",
            "openclaw-session",
            "openclaw-session",
        ]);
        expect(turn?.entries.map((entry) => entry.kind)).toEqual([
            "user",
            "tool",
            "thinking",
            "assistant",
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
        expect(replay.canonical?.turns.map((candidate) => candidate.id)).toEqual(
            first.canonical?.turns.map((candidate) => candidate.id)
        );
        expect(hiddenDiagnostics.canonical?.turns).toEqual(first.canonical?.turns);
        expect(hiddenDiagnostics.comparison.matches).toBe(true);
        expect(
            replay.canonical?.turns.flatMap((candidate) =>
                candidate.entries.map((entry) => entry.id)
            )
        ).toEqual(
            first.canonical?.turns.flatMap((candidate) =>
                candidate.entries.map((entry) => entry.id)
            )
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

    it("treats an unselected idle chat as an empty matching projection", () => {
        const result = projectChatWithCanonicalShadow(
            [],
            createChatRuntimeState(),
            "",
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(result.canonical?.turns).toEqual([]);
        expect(result.comparison).toMatchObject({
            differenceKinds: [],
            matches: true,
            turnCount: 0,
        });
    });

    it("keeps full media in turns while using bounded shadow identity", () => {
        const imageData = "a".repeat(200_000);
        const result = projectChatWithCanonicalShadow(
            [
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
            ],
            createChatRuntimeState(),
            SESSION,
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(result.comparison.matches).toBe(true);
        expect(result.canonical?.turns[0]?.entries[0]?.message.images?.[0]?.data).toBe(
            imageData
        );
    });

    it("fails open to the legacy projection when canonical validation fails", () => {
        const result = projectChatWithCanonicalShadow(
            [{ content: "orphan", role: "user", text: "orphan" }],
            createChatRuntimeState(),
            "",
            createChatVisibility(true, true),
            true,
            new Set()
        );

        expect(result.legacy.rows).toHaveLength(1);
        expect(result.canonical).toBeUndefined();
        expect(result.comparison).toMatchObject({
            canonicalError: {
                message: "Canonical chat projection invariant failed: session",
                name: "Error",
            },
            differenceKinds: ["canonical-error"],
            matches: false,
            schemaVersion: 1,
        });
    });
});
