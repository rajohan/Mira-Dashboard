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
            differenceKinds: ["canonical-error"],
            matches: false,
            schemaVersion: 1,
        });
    });
});
