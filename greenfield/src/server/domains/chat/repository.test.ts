/* oxlint-disable typescript/require-await -- Async test doubles mirror production promise ports. */
import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";
import * as v from "valibot";

import {
    chatRuntimeInputSchema,
    chatSendInputSchema,
    type ChatSendInput,
} from "../../../contracts/chat.ts";
import {
    chatRunEventBytesMaximum,
    chatRunEventPayloadMaximumBytes,
    chatRuntimeDurableResponseMaximumBytes,
    chatRuntimeResponseMaximumBytes,
    chatSendInputMaximumBytes,
} from "../../../contracts/chatModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import {
    ChatAdmissionConflictError,
    ChatProviderSequenceConflictError,
    ChatProviderSequenceGapError,
    ChatTranscriptUnavailableError,
} from "./errors.ts";
import { chatTerminalRetentionMilliseconds, createChatRepository } from "./repository.ts";
import { createChatTranscriptLifecycleCoordinator } from "./transcriptLifecycle.ts";

const actor = {
    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
    kind: "user" as const,
};
const firstRunId = "019fe5a1-6cb9-7e51-ad2a-bf1f69861218";
const secondRunId = "019fe5a1-6cb9-7e51-ad2a-bf1f69861219";

function input(overrides: Partial<ChatSendInput> = {}): ChatSendInput {
    return {
        clientRunId: firstRunId,
        idempotencyKey: "A".repeat(32),
        message: "hello",
        sessionKey: "agent:main:main",
        ...overrides,
    };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
        return new Error("Expected promise rejection");
    } catch (error) {
        return error;
    }
}

describe("durable chat repository", () => {
    test("persists the largest contract-valid send with bounded journal headroom", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const empty = input({ message: "" });
        const overhead = utf8ByteLength(JSON.stringify(empty));
        const maximum = v.parse(chatSendInputSchema, {
            ...empty,
            message: "a".repeat(chatSendInputMaximumBytes - overhead),
        });
        try {
            const admitted = await repository.admit(maximum, actor);
            const intent = repository.readIntent(firstRunId);

            expect(admitted.admission).toBe("created");
            expect(utf8ByteLength(JSON.stringify(intent?.request))).toBe(
                chatSendInputMaximumBytes
            );
            expect(intent?.run.state).toBe("admitted");
            const stored = database.sqlite
                .query<{ event_bytes: number; request_json: string }, [string]>(
                    "SELECT event_bytes, request_json FROM chat_runs WHERE id = ?"
                )
                .get(firstRunId);
            expect(utf8ByteLength(stored?.request_json ?? "")).toBe(
                chatSendInputMaximumBytes
            );
            expect(stored?.event_bytes).toBeLessThanOrEqual(
                chatRunEventPayloadMaximumBytes
            );
            expect(
                chatRunEventBytesMaximum - (stored?.event_bytes ?? 0)
            ).toBeGreaterThanOrEqual(
                chatRunEventBytesMaximum - chatRunEventPayloadMaximumBytes
            );
        } finally {
            database.sqlite.close(true);
        }
    });

    test("protects durable admission and snapshot authority while allowing parent cascade", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await repository.admit(input(), actor);
            await repository.beginDispatch(firstRunId);
            await repository.acknowledgeDispatch(firstRunId, "provider-run");
            await repository.appendEvents(firstRunId, [
                {
                    kind: "terminal",
                    occurredAtMs: 1100,
                    outcome: "completed",
                    providerRunId: "provider-run",
                    providerSequence: 1,
                },
            ]);
            await repository.appendEvents(firstRunId, [
                {
                    historyMessageId: "message-1",
                    kind: "reconciled",
                    occurredAtMs: 1200,
                },
            ]);

            expect(() =>
                database.sqlite.run(
                    "UPDATE chat_runs SET session_key = ?, state_version = state_version + 1 WHERE id = ?",
                    ["agent:main:other", firstRunId]
                )
            ).toThrow("chat_runs admission identity is immutable");
            expect(() =>
                database.sqlite.run(
                    "UPDATE chat_runs SET updated_at = updated_at WHERE id = ?",
                    [firstRunId]
                )
            ).toThrow("chat_runs version, time, and counters must advance monotonically");
            expect(() =>
                database.sqlite.run(
                    "UPDATE chat_runs SET event_count = event_count - 1, last_event_sequence = last_event_sequence - 1, state_version = state_version + 1 WHERE id = ?",
                    [firstRunId]
                )
            ).toThrow("chat_runs version, time, and counters must advance monotonically");
            expect(() =>
                database.sqlite.run(
                    "UPDATE chat_runs SET provider_run_id = 'different', state_version = state_version + 1 WHERE id = ?",
                    [firstRunId]
                )
            ).toThrow("chat_runs settled identities and timestamps are immutable");
            expect(() =>
                database.sqlite.run(
                    "INSERT OR REPLACE INTO chat_runs SELECT * FROM chat_runs WHERE id = ?",
                    [firstRunId]
                )
            ).toThrow("chat_runs admission identity is immutable");

            expect(() =>
                database.sqlite.run(
                    "UPDATE chat_runtime_snapshots SET through_sequence = through_sequence - 1 WHERE chat_run_id = ?",
                    [firstRunId]
                )
            ).toThrow("chat_runtime_snapshots progress must advance monotonically");
            expect(() =>
                database.sqlite.run(
                    "UPDATE chat_runtime_snapshots SET schema_version = schema_version WHERE chat_run_id = ?",
                    [firstRunId]
                )
            ).toThrow("chat_runtime_snapshots identity is immutable");
            expect(() =>
                database.sqlite.run(
                    "INSERT OR REPLACE INTO chat_runtime_snapshots SELECT * FROM chat_runtime_snapshots WHERE chat_run_id = ?",
                    [firstRunId]
                )
            ).toThrow("chat_runtime_snapshots identity is immutable");
            expect(() =>
                database.sqlite.run(
                    "DELETE FROM chat_runtime_snapshots WHERE chat_run_id = ?",
                    [firstRunId]
                )
            ).toThrow("chat_runtime_snapshots are parent-owned");

            database.sqlite.run("DELETE FROM chat_runs WHERE id = ?", [firstRunId]);
            expect(
                database.sqlite
                    .query<{ count: number }, [string]>(
                        "SELECT count(*) AS count FROM chat_run_events WHERE chat_run_id = ?"
                    )
                    .get(firstRunId)?.count
            ).toBe(0);
            expect(
                database.sqlite
                    .query<{ count: number }, [string]>(
                        "SELECT count(*) AS count FROM chat_runtime_snapshots WHERE chat_run_id = ?"
                    )
                    .get(firstRunId)?.count
            ).toBe(0);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("keeps the journal authoritative after projection truncation through reconciliation", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await repository.admit(input(), actor);
            const projected = await repository.appendEvents(
                firstRunId,
                Array.from({ length: 5 }, (_, index) => ({
                    kind: "assistant" as const,
                    mode: "append" as const,
                    occurredAtMs: 1001 + index,
                    text: "a".repeat(64 * 1024),
                }))
            );
            expect(projected.insertedCount).toBe(5);
            expect(projected.snapshot).toMatchObject({
                projectionTruncated: true,
                throughSequence: 6,
            });

            const terminal = await repository.appendEvents(firstRunId, [
                {
                    kind: "terminal",
                    occurredAtMs: 1007,
                    outcome: "completed",
                },
            ]);
            const reconciled = await repository.appendEvents(firstRunId, [
                {
                    historyMessageId: "message-1",
                    kind: "reconciled",
                    occurredAtMs: 1008,
                },
            ]);
            expect(terminal.run.state).toBe("completed");
            expect(reconciled).toMatchObject({
                run: { reconciliation: "history-authoritative" },
                snapshot: { projectionTruncated: true, throughSequence: 8 },
            });
            expect(
                database.sqlite
                    .query<{ count: number }, [string]>(
                        "SELECT count(*) AS count FROM chat_run_events WHERE chat_run_id = ?"
                    )
                    .get(firstRunId)?.count
            ).toBe(8);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("admits before dispatch and replays only the exact caller intent", async () => {
        const database = await openFreshMigratedDatabase();
        let wakes = 0;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000,
            async () => {
                wakes += 1;
                throw new Error("best-effort wake failed");
            }
        );
        try {
            const created = await repository.admit(input(), actor);
            const replayed = await repository.admit(input(), actor);
            const firstDispatch = await repository.beginDispatch(firstRunId);
            const duplicateDispatch = await repository.beginDispatch(firstRunId);
            const beforeAcknowledgement = repository.findByProviderCorrelation(
                "agent:main:main",
                "A".repeat(32)
            );
            const acknowledged = await repository.acknowledgeDispatch(
                firstRunId,
                "provider-alias-1"
            );
            const appended = await repository.appendEvents(firstRunId, [
                {
                    kind: "assistant",
                    mode: "append",
                    occurredAtMs: 1001,
                    providerSequenceEnd: 1,
                    providerSequenceStart: 1,
                    text: "provider output",
                },
            ]);

            expect(created.admission).toBe("created");
            expect(replayed.admission).toBe("replayed");
            expect(firstDispatch.shouldDispatch).toBeTrue();
            expect(duplicateDispatch.shouldDispatch).toBeFalse();
            expect(beforeAcknowledgement?.id).toBe(firstRunId);
            expect(acknowledged.providerRunId).toBe("provider-alias-1");
            expect(appended.insertedCount).toBe(1);
            expect(
                repository.findByProviderCorrelation(
                    "agent:main:main",
                    "provider-alias-1"
                )?.id
            ).toBe(firstRunId);
            expect(
                await rejectionOf(
                    repository.admit(input({ message: "different" }), actor)
                )
            ).toBeInstanceOf(ChatAdmissionConflictError);
            expect(wakes).toBe(6);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects a cross-actor collision on the upstream session idempotency lane", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await repository.admit(input(), actor);
            expect(
                await rejectionOf(
                    repository.admit(input({ clientRunId: secondRunId }), {
                        id: "automation-chat",
                        kind: "automation",
                    })
                )
            ).toBeInstanceOf(ChatAdmissionConflictError);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("deduplicates exact provider ranges and rejects changed or overlapping ranges", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await repository.admit(input(), actor);
            const tool = {
                callId: "call-1",
                isError: false,
                kind: "tool" as const,
                name: "search",
                occurredAtMs: 1001,
                phase: "started" as const,
                providerSequence: 1,
            };
            const insertedTool = await repository.appendEvents(firstRunId, [tool]);
            const replayedTool = await repository.appendEvents(firstRunId, [
                { ...tool, occurredAtMs: 1999 },
            ]);
            expect(insertedTool.insertedCount).toBe(1);
            expect(replayedTool.insertedCount).toBe(0);
            expect(
                await rejectionOf(
                    repository.appendEvents(firstRunId, [{ ...tool, name: "changed" }])
                )
            ).toBeInstanceOf(ChatProviderSequenceConflictError);

            const draft = {
                kind: "assistant" as const,
                mode: "merge" as const,
                occurredAtMs: 1001,
                providerSequenceEnd: 3,
                providerSequenceStart: 3,
                text: "abc",
            };
            expect(
                await rejectionOf(repository.appendEvents(firstRunId, [draft]))
            ).toBeInstanceOf(ChatProviderSequenceGapError);
            await repository.appendEvents(firstRunId, [
                {
                    kind: "provider-noop",
                    occurredAtMs: 1001,
                    providerSequenceEnd: 2,
                    providerSequenceStart: 2,
                    reason: "ignored",
                },
            ]);
            const inserted = await repository.appendEvents(firstRunId, [draft]);
            const replayed = await repository.appendEvents(firstRunId, [
                { ...draft, occurredAtMs: 2000 },
            ]);

            expect(inserted.insertedCount).toBe(1);
            expect(replayed.insertedCount).toBe(0);
            expect(replayed.snapshot.throughSequence).toBe(4);
            expect(
                await rejectionOf(
                    repository.appendEvents(firstRunId, [{ ...draft, text: "changed" }])
                )
            ).toBeInstanceOf(ChatProviderSequenceConflictError);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("hands a coalesced durable watermark to reconnect before projection", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const coalesced = {
            kind: "assistant" as const,
            mode: "append" as const,
            occurredAtMs: 1001,
            providerSequenceEnd: 2,
            providerSequenceStart: 1,
            text: "hello",
        };
        try {
            await repository.admit(input(), actor);
            await repository.beginDispatch(firstRunId);
            await repository.appendEvents(firstRunId, [coalesced]);

            expect(repository.listProviderRunWatermarks("agent:main:main")).toEqual([
                {
                    lastProviderSequence: 2,
                    providerRunId: "A".repeat(32),
                },
            ]);
            expect(
                await rejectionOf(
                    repository.appendEvents(firstRunId, [
                        {
                            ...coalesced,
                            providerSequenceEnd: 1,
                            text: "hel",
                        },
                    ])
                )
            ).toBeInstanceOf(ChatProviderSequenceConflictError);

            await repository.acknowledgeDispatch(firstRunId, "provider-alias-1");
            expect(repository.listProviderRunWatermarks("agent:main:main")).toEqual([
                {
                    lastProviderSequence: 2,
                    providerRunId: "provider-alias-1",
                },
            ]);
            const duplicateAppend = await repository.appendEvents(firstRunId, [
                coalesced,
            ]);
            expect(duplicateAppend.insertedCount).toBe(0);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("preserves cancellation evidence when completion or failure wins the race", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await repository.admit(input(), actor);
            await repository.requestCancellation(
                firstRunId,
                "agent:main:main",
                new Date(1100)
            );
            const terminal = {
                kind: "terminal" as const,
                occurredAtMs: 1200,
                outcome: "completed" as const,
                providerRunId: "provider-1",
                providerSequence: 1,
            };
            const completed = await repository.appendEvents(firstRunId, [terminal]);
            const replayedTerminal = await repository.appendEvents(firstRunId, [
                { ...terminal, occurredAtMs: 1300 },
            ]);
            const reconciled = await repository.appendEvents(firstRunId, [
                {
                    historyMessageId: "message-1",
                    kind: "reconciled",
                    occurredAtMs: 1400,
                },
            ]);
            const replayedReconciliation = await repository.appendEvents(firstRunId, [
                {
                    historyMessageId: "message-1",
                    kind: "reconciled",
                    occurredAtMs: 1500,
                },
            ]);

            await repository.admit(
                input({
                    clientRunId: secondRunId,
                    idempotencyKey: "B".repeat(32),
                }),
                actor,
                new Date(2000)
            );
            await repository.requestCancellation(
                secondRunId,
                "agent:main:main",
                new Date(2100)
            );
            const failed = await repository.appendEvents(secondRunId, [
                {
                    errorCode: "provider_error",
                    errorMessage: "Provider failed",
                    kind: "terminal",
                    occurredAtMs: 2200,
                    outcome: "error",
                    providerSequence: 1,
                },
            ]);

            expect(completed.run).toMatchObject({
                cancelRequestedAtMs: 1100,
                state: "completed",
                terminalAtMs: 1200,
            });
            expect(replayedTerminal.insertedCount).toBe(0);
            expect(replayedTerminal.run.terminalAtMs).toBe(1200);
            expect(reconciled.run).toMatchObject({
                reconciledAtMs: 1400,
                terminalAtMs: 1200,
            });
            expect(replayedReconciliation.insertedCount).toBe(0);
            expect(
                database.sqlite
                    .query<
                        { retention_expires_at: number; terminal_at: number },
                        [string]
                    >(
                        "SELECT retention_expires_at, terminal_at FROM chat_runs WHERE id = ?"
                    )
                    .get(firstRunId)
            ).toEqual({
                retention_expires_at: 1200 + chatTerminalRetentionMilliseconds,
                terminal_at: 1200,
            });
            expect(failed.run).toMatchObject({
                cancelRequestedAtMs: 2100,
                failureCode: "provider_error",
                state: "failed",
                terminalAtMs: 2200,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("treats global cursor holes as normal and resets an oversized same-session backlog", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await repository.admit(input(), actor);
            await repository.admit(
                input({
                    clientRunId: secondRunId,
                    idempotencyKey: "B".repeat(32),
                    sessionKey: "agent:main:other",
                }),
                actor
            );
            await repository.appendEvents(firstRunId, [
                {
                    kind: "status",
                    occurredAtMs: 1001,
                    phase: "starting-model",
                    providerSequence: 1,
                },
            ]);
            await repository.appendEvents(secondRunId, [
                {
                    kind: "status",
                    occurredAtMs: 1002,
                    phase: "starting-model",
                    providerSequence: 1,
                },
            ]);
            const ordinary = repository.readRuntime(
                v.parse(chatRuntimeInputSchema, {
                    afterTranscriptGeneration: 1,
                    sessionKey: "agent:main:main",
                })
            );

            expect(ordinary.events.map(({ cursor }) => cursor)).toEqual(["1", "3"]);
            expect(ordinary.cursor).toBe("4");
            expect(ordinary.resetRequired).toBeFalse();

            const backlog = Array.from({ length: 255 }, (_, index) => ({
                kind: "status" as const,
                occurredAtMs: 1100 + index,
                phase: "preparing-context" as const,
                providerSequence: index + 2,
            }));
            await repository.appendEvents(firstRunId, backlog.slice(0, 128));
            await repository.appendEvents(firstRunId, backlog.slice(128));
            const reset = repository.readRuntime(
                v.parse(chatRuntimeInputSchema, {
                    afterTranscriptGeneration: 1,
                    sessionKey: "agent:main:main",
                })
            );

            expect(reset.resetRequired).toBeTrue();
            expect(reset.hasMore).toBeFalse();
            expect(reset.events).toEqual([]);
            expect(reset.runs.map(({ run }) => run.id)).toEqual([firstRunId]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("blocks direct journal mutation but permits bounded whole-run retention", async () => {
        const database = await openFreshMigratedDatabase();
        let wakes = 0;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000,
            async () => {
                wakes += 1;
                throw new Error("best-effort wake failed");
            }
        );
        try {
            await repository.admit(input(), actor);
            await repository.appendEvents(firstRunId, [
                {
                    kind: "terminal",
                    occurredAtMs: 1200,
                    outcome: "completed",
                },
            ]);
            expect(() =>
                database.sqlite.run(
                    "UPDATE chat_run_events SET occurred_at = 9999 WHERE chat_run_id = ? AND sequence = 1",
                    [firstRunId]
                )
            ).toThrow("chat_run_events are append-only");
            expect(() =>
                database.sqlite.run(
                    "DELETE FROM chat_run_events WHERE chat_run_id = ? AND sequence = 1",
                    [firstRunId]
                )
            ).toThrow("chat_run_events are append-only");

            const markersBeforePrune = database.orm
                .select()
                .from(realtimeEvents)
                .where(eq(realtimeEvents.topic, "chat.runtime"))
                .all().length;
            expect(
                await repository.pruneExpired(
                    new Date(1200 + chatTerminalRetentionMilliseconds)
                )
            ).toBe(1);
            expect(repository.findRun(firstRunId)).toBeUndefined();
            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "chat.runtime"))
                    .all()
            ).toHaveLength(markersBeforePrune + 1);
            expect(wakes).toBe(3);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("authoritative resets retain every active run before bounded settled history", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Fixture identity is local to this retention case.
        const id = (value: number): string =>
            `019fe5a1-6cb9-7e51-ad2a-bf1f6986${value.toString(16).padStart(4, "0")}`;
        try {
            for (let index = 1; index <= 5; index += 1) {
                clock += 10;
                await repository.admit(
                    input({
                        clientRunId: id(index),
                        idempotencyKey: String.fromCodePoint(64 + index).repeat(32),
                    }),
                    actor
                );
                await repository.appendEvents(id(index), [
                    {
                        kind: "terminal",
                        occurredAtMs: clock + 1,
                        outcome: "completed",
                    },
                ]);
            }
            const activeIds: string[] = [];
            for (let index = 6; index <= 13; index += 1) {
                clock += 10;
                activeIds.push(id(index));
                await repository.admit(
                    input({
                        clientRunId: id(index),
                        idempotencyKey: `Z${String(index).padStart(2, "0")}`
                            .repeat(11)
                            .slice(0, 32),
                    }),
                    actor
                );
            }

            const reset = repository.readRuntime(
                v.parse(chatRuntimeInputSchema, {
                    afterCursor: String(Number.MAX_SAFE_INTEGER),
                    afterTranscriptGeneration: 1,
                    sessionKey: "agent:main:main",
                })
            );
            const returnedIds = new Set(reset.runs.map(({ run }) => run.id));
            expect(reset.resetRequired).toBeTrue();
            expect(reset.runs).toHaveLength(12);
            expect(activeIds.every((runId) => returnedIds.has(runId))).toBeTrue();
            expect(
                reset.runs.every(
                    ({ run }, index) =>
                        index === 0 ||
                        reset.runs[index - 1]!.run.admittedAtMs <= run.admittedAtMs
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("byte-budgets maximum deltas with cursor progress and compact active identities", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Fixture identity is local to this response-budget case.
        const runIdFor = (index: number): string =>
            `019fe5a1-6cb9-7e51-ad2a-bf1f6987${index.toString(16).padStart(4, "0")}`;
        const runIds = Array.from({ length: 4 }, (_, index) => runIdFor(index + 1));
        try {
            for (const [runIndex, runId] of runIds.entries()) {
                clock += 10;
                await repository.admit(
                    input({
                        clientRunId: runId,
                        idempotencyKey: `${String.fromCodePoint(65 + runIndex)}`.repeat(
                            32
                        ),
                    }),
                    actor
                );
                for (
                    let providerSequence = 1;
                    providerSequence <= 4;
                    providerSequence += 1
                ) {
                    clock += 1;
                    await repository.appendEvents(runId, [
                        {
                            kind: "assistant",
                            mode: "append",
                            occurredAtMs: clock,
                            providerSequenceEnd: providerSequence,
                            providerSequenceStart: providerSequence,
                            text: "x".repeat(64 * 1024),
                        },
                    ]);
                }
            }

            const first = repository.readRuntime(
                v.parse(chatRuntimeInputSchema, {
                    afterTranscriptGeneration: 1,
                    sessionKey: "agent:main:main",
                })
            );
            expect(first.events.length).toBeGreaterThan(0);
            expect(first.events.length).toBeLessThan(20);
            expect(first.hasMore).toBeTrue();
            expect(first.cursor).toBe(first.events.at(-1)!.cursor);
            expect(first.runs.map(({ run }) => run.id)).toEqual(runIds);
            expect(
                first.runs.some(({ projectionTruncated }) => projectionTruncated)
            ).toBeTrue();
            expect(utf8ByteLength(JSON.stringify(first))).toBeLessThanOrEqual(
                chatRuntimeDurableResponseMaximumBytes
            );

            const continuation = repository.readRuntime(
                v.parse(chatRuntimeInputSchema, {
                    afterCursor: first.cursor,
                    afterTranscriptGeneration: 1,
                    sessionKey: "agent:main:main",
                })
            );
            expect(continuation.events.length).toBeGreaterThan(0);
            expect(continuation.hasMore).toBeFalse();
            expect(Number(continuation.cursor)).toBeGreaterThan(Number(first.cursor));
            expect(utf8ByteLength(JSON.stringify(continuation))).toBeLessThanOrEqual(
                chatRuntimeResponseMaximumBytes
            );

            const reset = repository.readRuntime(
                v.parse(chatRuntimeInputSchema, {
                    afterCursor: String(Number.MAX_SAFE_INTEGER),
                    afterTranscriptGeneration: 1,
                    sessionKey: "agent:main:main",
                })
            );
            expect(reset.resetRequired).toBeTrue();
            expect(reset.events).toEqual([]);
            expect(reset.runs.map(({ run }) => run.id)).toEqual(runIds);
            expect(
                reset.runs.some(({ projectionTruncated }) => projectionTruncated)
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("settles unresolved dispatches honestly and makes them restart-safe and prunable", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await repository.admit(input(), actor);
            await repository.beginDispatch(firstRunId, new Date(1100));
            await repository.markOutcomeUnknown(firstRunId, new Date(1200));
            const settled = await repository.settleUnresolved(firstRunId, new Date(1300));

            expect(settled).toMatchObject({
                state: "unresolved",
                terminalAtMs: 1300,
            });
            expect("failureCode" in settled).toBeFalse();
            expect("failureMessage" in settled).toBeFalse();
            expect(repository.listRecoveryCandidates()).toEqual([]);
            expect(repository.listRecoverableRuns()).toEqual([]);
            expect(
                repository.readRuntime(
                    v.parse(chatRuntimeInputSchema, {
                        afterCursor: String(Number.MAX_SAFE_INTEGER),
                        afterTranscriptGeneration: 1,
                        sessionKey: "agent:main:main",
                    })
                ).runs[0]!.run.state
            ).toBe("unresolved");
            expect(
                await repository.pruneExpired(
                    new Date(1300 + chatTerminalRetentionMilliseconds - 1)
                )
            ).toBe(0);
            expect(
                await repository.pruneExpired(
                    new Date(1300 + chatTerminalRetentionMilliseconds)
                )
            ).toBe(1);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("holds reset controls until a strictly newer snapshot advances the durable transcript", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const lifecycle = createChatTranscriptLifecycleCoordinator(repository);
        const changes: number[] = [];
        lifecycle.subscribe(({ currentGeneration }) => {
            changes.push(currentGeneration);
        });
        try {
            await repository.admit(input(), actor);
            await repository.beginDispatch(firstRunId, new Date(1050));
            await lifecycle.beginControl({
                action: "reset",
                controlId: "reset-control",
                key: "agent:main:main",
                occurredAtMs: 1100,
            });
            expect(
                await rejectionOf(
                    repository.admit(
                        input({
                            clientRunId: secondRunId,
                            idempotencyKey: "B".repeat(32),
                        }),
                        actor,
                        new Date(1100)
                    )
                )
            ).toBeInstanceOf(ChatTranscriptUnavailableError);

            await lifecycle.observeSnapshot({
                observedAtMs: 1100,
                projectionTruncated: false,
                sessions: [
                    {
                        key: "agent:main:main",
                        sessionId: "provider-session",
                        updatedAtMs: 1100,
                    },
                ],
            });
            expect(repository.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 1,
                status: "control-pending",
            });
            expect(changes).toEqual([]);

            await lifecycle.observeSnapshot({
                observedAtMs: 1099,
                projectionTruncated: false,
                sessions: [],
            });
            expect(repository.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 1,
                status: "control-pending",
            });

            await lifecycle.observeSnapshot({
                observedAtMs: 1101,
                projectionTruncated: false,
                sessions: [
                    {
                        key: "agent:main:main",
                        sessionId: "provider-session",
                        updatedAtMs: 1101,
                    },
                ],
            });
            expect(repository.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 2,
                status: "ready",
            });
            expect(changes).toEqual([2]);
            expect(repository.findRun(firstRunId)).toBeUndefined();
            expect(
                repository.isRetiredProviderCorrelation("agent:main:main", "A".repeat(32))
            ).toBeTrue();
            expect(
                database.sqlite
                    .query<{ state: string }, [string]>(
                        "SELECT state FROM chat_runs WHERE id = ?"
                    )
                    .get(firstRunId)?.state
            ).toBe("unresolved");
            const reset = repository.readRuntime(
                v.parse(chatRuntimeInputSchema, {
                    afterTranscriptGeneration: 1,
                    sessionKey: "agent:main:main",
                })
            );
            expect(reset).toMatchObject({
                resetRequired: true,
                runs: [],
                transcriptGeneration: 2,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("reopens an unchanged compact without advancing or retiring the transcript", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const lifecycle = createChatTranscriptLifecycleCoordinator(repository);
        try {
            await repository.admit(input(), actor);
            await lifecycle.beginControl({
                action: "compact",
                controlId: "compact-control",
                key: "agent:main:main",
                occurredAtMs: 1100,
            });
            await lifecycle.settleUnchangedControl({
                action: "compact",
                controlId: "compact-control",
                key: "agent:main:main",
                occurredAtMs: 1101,
            });
            expect(repository.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 1,
                status: "ready",
            });
            const dispatch = await repository.beginDispatch(firstRunId);
            expect(dispatch.shouldDispatch).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("preserves represented active work across restart and retires unrepresented work", async () => {
        const database = await openFreshMigratedDatabase();
        const firstRepository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await firstRepository.admit(input(), actor);
            await firstRepository.beginDispatch(firstRunId);
            await firstRepository.markTranscriptTransportBoundary(1100);
            expect(firstRepository.readTranscriptState("agent:main:main").status).toBe(
                "reconciling"
            );

            const restarted = createChatRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission,
                "main",
                () => 1200
            );
            expect(
                restarted.listTranscriptRecoveryCandidates("agent:main:main")
            ).toHaveLength(1);
            await restarted.reconcileTranscript({
                providerSessionId: "provider-session",
                represented: true,
                sessionKey: "agent:main:main",
                observedAtMs: 1200,
            });
            expect(restarted.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 1,
                status: "ready",
            });
            expect(restarted.findRun(firstRunId)?.state).toBe("admitted");

            await restarted.markTranscriptTransportBoundary(1300);
            const changes = await restarted.reconcileTranscript({
                providerSessionId: "replacement-session",
                represented: false,
                sessionKey: "agent:main:main",
                observedAtMs: 1400,
            });
            expect(changes).toHaveLength(1);
            expect(restarted.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 2,
                providerSessionId: "replacement-session",
                status: "ready",
            });
            expect(restarted.findRun(firstRunId)).toBeUndefined();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("coalesces a transport boundary across every retained transcript into one realtime marker per topic", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const sessions = Array.from({ length: 22 }, (_, index) => ({
            key: `agent:main:retained-${index}`,
            sessionId: `provider-session-${index}`,
            updatedAtMs: 1000,
        }));
        const markerCount = (topic: "chat.runtime" | "chat.history") =>
            database.orm
                .select()
                .from(realtimeEvents)
                .where(eq(realtimeEvents.topic, topic))
                .all().length;
        try {
            await repository.observeTranscriptSnapshot({
                observedAtMs: 1000,
                projectionTruncated: false,
                sessions,
            });
            const runtimeBefore = markerCount("chat.runtime");
            const historyBefore = markerCount("chat.history");

            expect(await repository.markTranscriptTransportBoundary(1100)).toHaveLength(
                sessions.length
            );
            expect(markerCount("chat.runtime") - runtimeBefore).toBe(1);
            expect(markerCount("chat.history") - historyBefore).toBe(1);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("retires pre-restart work when the reset lifecycle event arrives during downtime", async () => {
        const database = await openFreshMigratedDatabase();
        const beforeRestart = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        try {
            await beforeRestart.admit(input(), actor);
            await beforeRestart.beginDispatch(firstRunId, new Date(1050));
            await beforeRestart.markTranscriptTransportBoundary(1100);

            const afterRestart = createChatRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission,
                "main",
                () => 1200
            );
            const lifecycle = createChatTranscriptLifecycleCoordinator(afterRestart);
            const changes = await lifecycle.observeLifecycleEvent({
                occurredAtMs: 1200,
                reason: "reset",
                sessionId: "provider-session",
                sessionKey: "agent:main:main",
                updatedAtMs: 1200,
            });

            expect(changes).toHaveLength(1);
            expect(afterRestart.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 2,
                providerSessionId: "provider-session",
                status: "ready",
            });
            expect(afterRestart.findRun(firstRunId)).toBeUndefined();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("does not replay an old provider lifecycle boundary across a transport restart", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const lifecycle = createChatTranscriptLifecycleCoordinator(repository);
        const resetEvent = {
            occurredAtMs: 1100,
            reason: "reset" as const,
            sessionId: "provider-session",
            sessionKey: "agent:main:main",
            updatedAtMs: 1100,
        };
        try {
            await repository.admit(input(), actor);
            await repository.beginDispatch(firstRunId, new Date(1050));
            await lifecycle.observeLifecycleEvent(resetEvent);
            await repository.admit(
                input({
                    clientRunId: secondRunId,
                    idempotencyKey: "B".repeat(32),
                }),
                actor,
                new Date(1150)
            );
            await repository.beginDispatch(secondRunId, new Date(1160));
            await lifecycle.markTransportBoundary(1200);

            expect(await lifecycle.observeLifecycleEvent(resetEvent)).toEqual([]);
            expect(repository.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 2,
                status: "reconciling",
            });
            expect(
                repository.listTranscriptRecoveryCandidates("agent:main:main")[0]?.run.id
            ).toBe(secondRunId);
            await lifecycle.reconcile({
                providerSessionId: "provider-session",
                represented: true,
                sessionKey: "agent:main:main",
                observedAtMs: 1300,
            });
            expect(repository.findRun(secondRunId)).toBeDefined();
        } finally {
            database.sqlite.close(true);
        }
    });
});
