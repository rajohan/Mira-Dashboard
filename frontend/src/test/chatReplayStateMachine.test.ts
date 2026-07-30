import { describe, expect, it } from "bun:test";

import type { ChatHistoryMessage, ChatRow } from "../components/features/chat/chatTypes";
import {
    createChatVisibility,
    hasPrimaryAnswerContent,
} from "../components/features/chat/domain/chatPresentation";
import { projectChat } from "../components/features/chat/domain/chatProjection";
import {
    type ChatRuntimeEvent,
    createChatRuntimeState,
    reduceChatRuntime,
} from "../components/features/chat/domain/chatState";
import { runChatReplayStateMachine } from "./support/chatReplayStateMachine";

const SESSION = "agent:main:main";
const BASE_TIME = Date.parse("2026-07-30T09:00:00.000Z");
const RUN_BEFORE_RESTART = "run-before-restart";
const RUN_AFTER_FIRST_RESTART = "run-after-first-restart";
const RUN_AFTER_SECOND_RESTART = "run-after-second-restart";
const COMPACTION_RUN = `compaction:${RUN_AFTER_FIRST_RESTART}`;

type EventDraft = ChatRuntimeEvent extends infer Event
    ? Event extends ChatRuntimeEvent
        ? Omit<Event, "sequence" | "sessionKey" | "timestamp">
        : never
    : never;

function timestamp(sequence: number): string {
    return new Date(BASE_TIME + sequence * 10).toISOString();
}

function message(
    role: string,
    text: string,
    runId: string,
    sequence: number
): ChatHistoryMessage {
    return {
        content: text,
        role,
        runId,
        text,
        timestamp: timestamp(sequence),
    };
}

function event(sequence: number, draft: EventDraft): ChatRuntimeEvent {
    return {
        ...draft,
        sequence,
        sessionKey: SESSION,
        timestamp: timestamp(sequence),
    };
}

function thinking(
    sequence: number,
    text: string,
    runId: string,
    runAliases?: string[]
): ChatRuntimeEvent {
    return event(sequence, {
        kind: "thinking",
        message: {
            content: [{ text, type: "thinking" }],
            role: "assistant",
            runId,
            text: "",
            thinking: [{ id: `thinking-${sequence}`, text }],
        },
        runAliases,
        runId,
    });
}

function replayScenario(): ChatRuntimeEvent[] {
    return [
        event(10, {
            kind: "user",
            message: message("user", "question", RUN_BEFORE_RESTART, 10),
            runId: RUN_BEFORE_RESTART,
        }),
        thinking(20, "before restart", RUN_BEFORE_RESTART),
        event(30, {
            kind: "user",
            message: message("user", "steer before restart", RUN_BEFORE_RESTART, 30),
            runId: RUN_BEFORE_RESTART,
        }),
        event(40, {
            kind: "tool",
            message: {
                content: "",
                role: "assistant",
                runId: RUN_BEFORE_RESTART,
                text: "",
                toolCalls: [
                    {
                        id: "tool-before-restart",
                        name: "functions.exec_command",
                        toolResult: {
                            content: "before-output",
                            id: "tool-before-restart",
                            name: "functions.exec_command",
                        },
                    },
                ],
            },
            runId: RUN_BEFORE_RESTART,
            toolKey: "tool:tool-before-restart",
        }),
        event(50, {
            kind: "identity",
            runAliases: [RUN_BEFORE_RESTART],
            runId: RUN_AFTER_FIRST_RESTART,
        }),
        event(60, {
            kind: "user",
            message: message(
                "user",
                "steer after first restart",
                RUN_AFTER_FIRST_RESTART,
                60
            ),
            runAliases: [RUN_BEFORE_RESTART],
            runId: RUN_AFTER_FIRST_RESTART,
        }),
        event(70, {
            kind: "status",
            operation: "compact",
            operationPhase: "active",
            runId: COMPACTION_RUN,
            text: "Compacting context",
        }),
        thinking(80, "during compaction", RUN_AFTER_FIRST_RESTART, [RUN_BEFORE_RESTART]),
        event(90, {
            kind: "status",
            operation: "compact",
            operationPhase: "complete",
            runId: COMPACTION_RUN,
            text: "Context compacted",
        }),
        event(100, {
            kind: "identity",
            runAliases: [RUN_AFTER_FIRST_RESTART],
            runId: RUN_AFTER_SECOND_RESTART,
        }),
        event(110, {
            kind: "user",
            message: message(
                "user",
                "steer after second restart",
                RUN_AFTER_SECOND_RESTART,
                110
            ),
            runAliases: [RUN_AFTER_FIRST_RESTART],
            runId: RUN_AFTER_SECOND_RESTART,
        }),
        thinking(120, "after compaction", RUN_AFTER_SECOND_RESTART),
        event(130, {
            kind: "finish",
            message: message("assistant", "final answer", RUN_AFTER_SECOND_RESTART, 130),
            outcome: "completed",
            runId: RUN_AFTER_SECOND_RESTART,
        }),
    ];
}

function historyVariants(): ChatHistoryMessage[][] {
    const question = message("user", "question", RUN_BEFORE_RESTART, 10);
    const steerBefore = message("user", "steer before restart", RUN_BEFORE_RESTART, 30);
    const steerAfterFirst = message(
        "user",
        "steer after first restart",
        RUN_AFTER_FIRST_RESTART,
        60
    );
    const steerAfterSecond = message(
        "user",
        "steer after second restart",
        RUN_AFTER_SECOND_RESTART,
        110
    );
    const final = {
        ...message("assistant", "final answer", RUN_AFTER_SECOND_RESTART, 130),
        isFinal: true,
    };
    return [
        [],
        [question],
        [question, steerBefore, steerAfterFirst],
        [steerAfterSecond, final],
        [question, steerBefore, steerAfterFirst, steerAfterSecond, final],
        [
            question,
            { ...question },
            steerBefore,
            steerAfterFirst,
            { ...steerAfterFirst },
            steerAfterSecond,
            final,
            { ...final },
        ],
    ];
}

function rowSemantics(row: ChatRow): unknown {
    const toolResults = [
        row.message.toolResult?.content,
        ...(row.message.toolCalls || []).map((call) => call.toolResult?.content),
    ].filter((content): content is string => content !== undefined);
    return {
        role: row.message.role,
        text: row.message.text,
        thinking: (row.message.thinking || []).map((block) => block.text),
        tools: (row.message.toolCalls || []).map((call) => ({
            id: call.id,
            name: call.name,
        })),
        toolResults,
    };
}

function projectionFor(
    history: ChatHistoryMessage[],
    state: ReturnType<typeof createChatRuntimeState>
) {
    return projectChat(
        history,
        state,
        SESSION,
        createChatVisibility(true, true),
        true,
        new Set()
    );
}

const EVENTS = replayScenario();
const BASELINE_STATE = reduceChatRuntime(createChatRuntimeState(), EVENTS);
const BASELINE_PROJECTION = projectionFor([], BASELINE_STATE);
const BASELINE_ROWS = BASELINE_PROJECTION.rows.map(rowSemantics);
const SEEDS = Array.from({ length: 64 }, (_, index) => index + 1);

describe("chat replay state machine", () => {
    it.each(SEEDS)(
        "preserves canonical state and projection across generated faults (seed %d)",
        (seed) => {
            const result = runChatReplayStateMachine(EVENTS, seed);
            const history = historyVariants()[seed % historyVariants().length]!;
            const projection = projectionFor(history, result.state);
            const normalizedState = { ...result.state, generation: 0 };

            expect(normalizedState).toEqual(BASELINE_STATE);
            expect(projection.rows.map(rowSemantics)).toEqual(BASELINE_ROWS);
            expect(new Set(projection.rows.map((row) => row.key)).size).toBe(
                projection.rows.length
            );
            expect(projection.activeRuns).toEqual([]);
            expect(projection.compactionStatus).toMatchObject({ phase: "complete" });
            expect(result.steps.filter((step) => step.kind === "reconnect")).toHaveLength(
                2
            );
            expect(
                result.steps.some(
                    (step) => new Set(step.sequences).size < step.sequences.length
                )
            ).toBe(true);
            const checkpointSequences = result.checkpoints.map(
                (checkpoint) => checkpoint.sessions[SESSION]?.lastSequence ?? -1
            );
            expect(checkpointSequences[0]).toBe(checkpointSequences[1]);
            expect(checkpointSequences).toEqual(
                checkpointSequences.toSorted((left, right) => left - right)
            );
            expect(checkpointSequences.at(-1)).toBe(EVENTS.at(-1)?.sequence);
        }
    );

    it("keeps partial and duplicate history semantically equivalent", () => {
        for (const history of historyVariants()) {
            const projection = projectionFor(history, BASELINE_STATE);

            expect(projection.rows.map(rowSemantics)).toEqual(BASELINE_ROWS);
            expect(new Set(projection.rows.map((row) => row.key)).size).toBe(
                projection.rows.length
            );
        }
    });

    it("keeps one completed parent and a separate completed compaction run", () => {
        const runs = BASELINE_STATE.sessions[SESSION]?.runs || {};
        const parent = runs[RUN_AFTER_SECOND_RESTART];

        expect(Object.keys(runs).toSorted()).toEqual(
            [COMPACTION_RUN, RUN_AFTER_SECOND_RESTART].toSorted()
        );
        expect(parent?.aliases.toSorted()).toEqual(
            [
                RUN_AFTER_FIRST_RESTART,
                RUN_AFTER_SECOND_RESTART,
                RUN_BEFORE_RESTART,
            ].toSorted()
        );
        expect(parent?.phase).toBe("completed");
        expect(runs[COMPACTION_RUN]).toMatchObject({
            operation: "compact",
            operationPhase: "complete",
            phase: "completed",
        });
        expect(
            BASELINE_PROJECTION.rows.filter(
                (row) =>
                    row.message.role.toLowerCase() === "assistant" &&
                    hasPrimaryAnswerContent(row.message) &&
                    row.message.text === "final answer"
            )
        ).toHaveLength(1);
        for (const text of [
            "question",
            "steer before restart",
            "steer after first restart",
            "steer after second restart",
        ]) {
            expect(
                BASELINE_PROJECTION.rows.filter((row) => row.message.text === text)
            ).toHaveLength(1);
        }
    });
});
