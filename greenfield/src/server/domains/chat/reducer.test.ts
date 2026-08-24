import { describe, expect, test } from "bun:test";

import type {
    ChatRunSummary,
    ChatRuntimeEvent,
    ChatRuntimeSnapshot,
} from "../../../contracts/chatModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { chatRunStateAfterEvent, reduceChatRuntimeSnapshot } from "./reducer.ts";

const runId = "019fe5a1-6cb9-7e51-ad2a-bf1f69861218";

function run(overrides: Partial<ChatRunSummary> = {}): ChatRunSummary {
    return {
        admittedAtMs: 1000,
        id: runId,
        reconciliation: "runtime-authoritative",
        sessionKey: "agent:main:main",
        state: "active",
        stateVersion: 2,
        updatedAtMs: 1000,
        ...overrides,
    };
}

function event<TEvent extends ChatRuntimeEvent>(event: TEvent): TEvent {
    return event;
}

describe("chat runtime reducer", () => {
    test("degrades cumulative text without blocking terminal reconciliation", () => {
        let snapshot = reduceChatRuntimeSnapshot(
            undefined,
            event({
                idempotencyKey: "A".repeat(32),
                kind: "user",
                occurredAtMs: 1000,
                runId,
                sequence: 1,
                text: "hello",
            }),
            run({ state: "admitted" })
        );
        for (let sequence = 2; sequence <= 6; sequence += 1) {
            snapshot = reduceChatRuntimeSnapshot(
                snapshot,
                event({
                    kind: "assistant",
                    mode: "append",
                    occurredAtMs: 1000 + sequence,
                    runId,
                    sequence,
                    text: "a".repeat(64 * 1024),
                }),
                run({ updatedAtMs: 1000 + sequence })
            );
        }

        expect(snapshot.projectionTruncated).toBeTrue();
        expect(snapshot.parts).toEqual([
            {
                kind: "assistant",
                sequence: 6,
                text: "a".repeat(64 * 1024),
            },
        ]);
        const terminal = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                kind: "terminal",
                occurredAtMs: 1007,
                outcome: "completed",
                runId,
                sequence: 7,
            }),
            run({
                state: "completed",
                terminalAtMs: 1007,
                updatedAtMs: 1007,
            })
        );
        const reconciled = reduceChatRuntimeSnapshot(
            terminal,
            event({
                historyMessageId: "message-1",
                kind: "reconciled",
                occurredAtMs: 1008,
                runId,
                sequence: 8,
            }),
            run({
                reconciliation: "history-authoritative",
                reconciledAtMs: 1008,
                state: "completed",
                terminalAtMs: 1007,
                updatedAtMs: 1008,
            })
        );

        expect(reconciled).toMatchObject({
            projectionTruncated: true,
            throughSequence: 8,
            run: { reconciliation: "history-authoritative", state: "completed" },
        });
    });

    test("degrades a projection beyond 512 ordered parts", () => {
        let snapshot = reduceChatRuntimeSnapshot(
            undefined,
            event({
                idempotencyKey: "A".repeat(32),
                kind: "user",
                occurredAtMs: 1000,
                runId,
                sequence: 1,
                text: "hello",
            }),
            run({ state: "admitted" })
        );
        for (let sequence = 2; sequence <= 513; sequence += 1) {
            snapshot = reduceChatRuntimeSnapshot(
                snapshot,
                event({
                    itemId: `item-${sequence}`,
                    itemType: "fixture",
                    kind: "item",
                    occurredAtMs: 1000 + sequence,
                    runId,
                    sequence,
                }),
                run({ updatedAtMs: 1000 + sequence })
            );
        }

        expect(snapshot.projectionTruncated).toBeTrue();
        expect(snapshot.parts).toEqual([
            {
                id: "item-513",
                kind: "item",
                sequence: 513,
                type: "fixture",
            },
        ]);
        expect(snapshot.throughSequence).toBe(513);
    });

    test("degrades an encoded projection beyond the snapshot byte ceiling", () => {
        let snapshot = reduceChatRuntimeSnapshot(
            undefined,
            event({
                idempotencyKey: "A".repeat(32),
                kind: "user",
                occurredAtMs: 1000,
                runId,
                sequence: 1,
                text: "hello",
            }),
            run({ state: "admitted" })
        );
        for (let sequence = 2; sequence <= 18; sequence += 1) {
            snapshot = reduceChatRuntimeSnapshot(
                snapshot,
                event({
                    itemId: `large-item-${sequence}`,
                    itemType: "fixture",
                    kind: "item",
                    occurredAtMs: 1000 + sequence,
                    runId,
                    sequence,
                    text: "x".repeat(32 * 1024),
                }),
                run({ updatedAtMs: 1000 + sequence })
            );
        }

        expect(snapshot.projectionTruncated).toBeTrue();
        expect(snapshot.parts.length).toBeLessThanOrEqual(2);
        expect(snapshot.parts.at(-1)).toMatchObject({ id: "large-item-18" });
        expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(512 * 1024);
        expect(snapshot.throughSequence).toBe(18);
    });

    test("converges duplicate agent/chat text once before an aborted terminal", () => {
        let snapshot = reduceChatRuntimeSnapshot(
            undefined,
            event({
                idempotencyKey: "A".repeat(32),
                kind: "user",
                occurredAtMs: 1000,
                runId,
                sequence: 1,
                text: "cancel this",
            }),
            run({ state: "admitted" })
        );
        snapshot = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                kind: "assistant",
                mode: "append",
                occurredAtMs: 1001,
                providerSequenceEnd: 1,
                providerSequenceStart: 1,
                runId,
                sequence: 2,
                text: "Checking cancellation.",
            }),
            run({ updatedAtMs: 1001 })
        );
        snapshot = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                kind: "assistant",
                mode: "merge",
                occurredAtMs: 1002,
                providerSequenceEnd: 2,
                providerSequenceStart: 2,
                runId,
                sequence: 3,
                text: "Checking cancellation.",
            }),
            run({ updatedAtMs: 1002 })
        );
        snapshot = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                kind: "cancel",
                occurredAtMs: 1003,
                runId,
                sequence: 4,
                source: "operator",
            }),
            run({
                cancelRequestedAtMs: 1003,
                state: "cancel-requested",
                updatedAtMs: 1003,
            })
        );
        snapshot = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                kind: "terminal",
                occurredAtMs: 1004,
                outcome: "aborted",
                providerSequence: 3,
                runId,
                sequence: 5,
            }),
            run({
                cancelRequestedAtMs: 1003,
                state: "cancelled",
                terminalAtMs: 1004,
                updatedAtMs: 1004,
            })
        );

        expect(snapshot.parts).toEqual([
            { kind: "user", sequence: 1, text: "cancel this" },
            {
                kind: "assistant",
                sequence: 3,
                text: "Checking cancellation.",
            },
        ]);
        expect(snapshot.run.state).toBe("cancelled");
    });

    test("keeps later assistant text after a completed tool as a new ordered segment", () => {
        const runtimeEvents: ChatRuntimeEvent[] = [
            event({
                idempotencyKey: "A".repeat(32),
                kind: "user",
                occurredAtMs: 1000,
                runId,
                sequence: 1,
                text: "use the fixture",
            }),
            event({
                kind: "assistant",
                mode: "append",
                occurredAtMs: 1001,
                providerSequenceEnd: 1,
                providerSequenceStart: 1,
                runId,
                sequence: 2,
                text: "Running the fixture tool.",
            }),
            event({
                callId: "fixture-tool-1",
                isError: false,
                kind: "tool",
                name: "fixture.lookup",
                occurredAtMs: 1002,
                phase: "started",
                providerSequence: 2,
                runId,
                sequence: 3,
            }),
            event({
                callId: "fixture-tool-1",
                isError: false,
                kind: "tool",
                name: "fixture.lookup",
                occurredAtMs: 1003,
                output: "ok",
                phase: "succeeded",
                providerSequence: 3,
                runId,
                sequence: 4,
            }),
            event({
                kind: "assistant",
                mode: "merge",
                occurredAtMs: 1004,
                providerSequenceEnd: 4,
                providerSequenceStart: 4,
                runId,
                sequence: 5,
                text: "Fixture complete.",
            }),
            event({
                kind: "terminal",
                occurredAtMs: 1005,
                outcome: "completed",
                providerSequence: 5,
                runId,
                sequence: 6,
            }),
        ];
        let snapshot: ChatRuntimeSnapshot | undefined;
        for (const runtimeEvent of runtimeEvents) {
            const terminal = runtimeEvent.kind === "terminal";
            let state: ChatRunSummary["state"] = "active";
            if (runtimeEvent.sequence === 1) state = "admitted";
            if (terminal) state = "completed";
            snapshot = reduceChatRuntimeSnapshot(
                snapshot,
                runtimeEvent,
                run({
                    state,
                    ...(terminal ? { terminalAtMs: 1005 } : {}),
                    updatedAtMs: runtimeEvent.occurredAtMs,
                })
            );
        }

        expect(snapshot?.parts).toEqual([
            { kind: "user", sequence: 1, text: "use the fixture" },
            {
                kind: "assistant",
                sequence: 2,
                text: "Running the fixture tool.",
            },
            {
                callId: "fixture-tool-1",
                isError: false,
                kind: "tool",
                name: "fixture.lookup",
                output: "ok",
                phase: "succeeded",
                sequence: 3,
            },
            { kind: "assistant", sequence: 5, text: "Fixture complete." },
        ]);
        expect(snapshot?.run.state).toBe("completed");
    });

    test("advances through an ignored provider sequence without adding projection content", () => {
        const initial = reduceChatRuntimeSnapshot(
            undefined,
            event({
                idempotencyKey: "A".repeat(32),
                kind: "user",
                occurredAtMs: 1000,
                runId,
                sequence: 1,
                text: "hello",
            }),
            run({ state: "admitted" })
        );
        const watermarked = reduceChatRuntimeSnapshot(
            initial,
            event({
                kind: "provider-noop",
                occurredAtMs: 1001,
                providerSequence: 1,
                reason: "ignored",
                runId,
                sequence: 2,
            }),
            run({ updatedAtMs: 1001 })
        );

        expect(watermarked.parts).toEqual(initial.parts);
        expect(watermarked.throughSequence).toBe(2);
    });

    test("keeps ordered stream/tool/item rows and updates stable tool identity in place", () => {
        const user = event({
            idempotencyKey: "A".repeat(32),
            kind: "user",
            occurredAtMs: 1000,
            runId,
            sequence: 1,
            text: "hello",
        });
        let snapshot: ChatRuntimeSnapshot = reduceChatRuntimeSnapshot(
            undefined,
            user,
            run({ state: "admitted" })
        );
        snapshot = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                kind: "assistant",
                mode: "append",
                occurredAtMs: 1001,
                runId,
                sequence: 2,
                text: "hel",
            }),
            run({ updatedAtMs: 1001 })
        );
        snapshot = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                kind: "assistant",
                mode: "append",
                occurredAtMs: 1002,
                runId,
                sequence: 3,
                text: "lo",
            }),
            run({ updatedAtMs: 1002 })
        );
        snapshot = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                callId: "call-1",
                isError: false,
                kind: "tool",
                name: "search",
                occurredAtMs: 1003,
                phase: "started",
                runId,
                sequence: 4,
            }),
            run({ updatedAtMs: 1003 })
        );
        snapshot = reduceChatRuntimeSnapshot(
            snapshot,
            event({
                callId: "call-1",
                isError: false,
                kind: "tool",
                name: "search",
                occurredAtMs: 1004,
                output: "done",
                phase: "succeeded",
                runId,
                sequence: 5,
            }),
            run({ updatedAtMs: 1004 })
        );

        expect(snapshot.parts).toEqual([
            { kind: "user", sequence: 1, text: "hello" },
            { kind: "assistant", sequence: 3, text: "hello" },
            {
                callId: "call-1",
                isError: false,
                kind: "tool",
                name: "search",
                output: "done",
                phase: "succeeded",
                sequence: 4,
            },
        ]);
        expect(snapshot.throughSequence).toBe(5);
    });

    test("clears plans at terminal boundaries", () => {
        const initial = reduceChatRuntimeSnapshot(
            undefined,
            event({
                idempotencyKey: "A".repeat(32),
                kind: "user",
                occurredAtMs: 1000,
                runId,
                sequence: 1,
                text: "hello",
            }),
            run({ state: "admitted" })
        );
        const planned = reduceChatRuntimeSnapshot(
            initial,
            event({
                kind: "plan",
                occurredAtMs: 1001,
                phase: "update",
                runId,
                sequence: 2,
                steps: [{ status: "in_progress", text: "Work" }],
            }),
            run({ updatedAtMs: 1001 })
        );
        const terminal = reduceChatRuntimeSnapshot(
            planned,
            event({
                kind: "terminal",
                occurredAtMs: 1002,
                outcome: "completed",
                runId,
                sequence: 3,
            }),
            run({
                state: "completed",
                terminalAtMs: 1002,
                updatedAtMs: 1002,
            })
        );

        expect(planned.plan?.steps).toHaveLength(1);
        expect(terminal.plan).toBeUndefined();
    });

    test("allows cancellation to lose a race to completion or failure", () => {
        const completed = chatRunStateAfterEvent(
            "cancel-requested",
            event({
                kind: "terminal",
                occurredAtMs: 1002,
                outcome: "completed",
                runId,
                sequence: 3,
            })
        );
        const failed = chatRunStateAfterEvent(
            "cancel-requested",
            event({
                errorCode: "provider_error",
                errorMessage: "failed",
                kind: "terminal",
                occurredAtMs: 1002,
                outcome: "error",
                runId,
                sequence: 3,
            })
        );

        expect(completed).toBe("completed");
        expect(failed).toBe("failed");
    });
});
