/* oxlint-disable typescript/require-await -- Async test doubles mirror production promise ports. */
import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import type { ChatSendInput } from "../../../contracts/chat.ts";
import {
    chatDeltaCoalescingMilliseconds,
    chatExternalRunsPerProcessMaximum,
    chatRunEventMaximum,
    chatRuntimeProjectionPartsMaximum,
    chatRuntimeResponseMaximumBytes,
    chatRuntimeSnapshotMaximumBytes,
    type ChatRuntimeProjectionPart,
} from "../../../contracts/chatModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { chatRunEvents } from "../../database/schema/chatRunEvents.ts";
import { chatRuns } from "../../database/schema/chatRuns.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    type ChatAttachmentTicketReservation,
    ChatAttachmentTicketError,
    type ChatEventSubscriptionRequest,
    type ChatProvider,
    type ChatProviderHistoryRequest,
    ChatProviderCapacityError,
    ChatProviderConflictError,
    ChatProviderUnknownOutcomeError,
    ChatProviderUnavailableError,
} from "./provider.ts";
import { createChatRepository, type ChatRepository } from "./repository.ts";
import {
    createChatService,
    chatCompanionAskActorWindowMaximum,
    chatCompanionAskProcessMaximum,
    chatCompanionAskRateWindowMilliseconds,
    chatExternalRunStaleMilliseconds,
    type ChatRecoveryScheduler,
    ChatServiceError,
    normalizeExternalProjectionParts,
} from "./service.ts";
import { createChatTranscriptLifecycleCoordinator } from "./transcriptLifecycle.ts";

const runId = "019fe5a1-6cb9-7e51-ad2a-bf1f69861218";
const ticketId = "019fe633-9133-4ba0-8b80-809dd80dfb40";
const actor = {
    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
    kind: "user" as const,
};

function sendInput(overrides: Partial<ChatSendInput> = {}): ChatSendInput {
    return {
        clientRunId: runId,
        idempotencyKey: "A".repeat(32),
        message: "hello",
        sessionKey: "agent:main:main",
        ...overrides,
    };
}

function runtimeInput(sessionKey = "agent:main:main") {
    return {
        afterCursor: "0",
        afterTranscriptGeneration: 0,
        limit: 128,
        sessionKey,
    };
}

function unscopedHistoryUser(
    id: string,
    text: string,
    createdAtMs: number,
    sequence: number
) {
    return {
        content: {
            kind: "complete" as const,
            parts: [{ id: `${id}-part`, kind: "text" as const, text }],
        },
        createdAtMs,
        id,
        role: "user" as const,
        sequence,
        source: "gateway-history" as const,
    };
}

interface ProviderHarness {
    readonly closeCount: () => number;
    readonly provider: ChatProvider;
    readonly requests: ChatEventSubscriptionRequest[];
}

function providerHarness(overrides: Partial<ChatProvider> = {}): ProviderHarness {
    const requests: ChatEventSubscriptionRequest[] = [];
    let closes = 0;
    const provider: ChatProvider = {
        abort: async () => ({ aborted: false, ok: true, runIds: [] }),
        companionAsk: async () => ({ answer: "answer", timestampMs: 1000 }),
        companionReset: async () => ({ reset: true }),
        companionState: async () => ({ exchanges: [] }),
        getMessage: async () => ({ reason: "not-found", status: "unavailable" }),
        history: async () => ({ hasMore: false, messages: [] }),
        listModels: async () => ({ models: [] }),
        send: async () => ({
            runId: "provider-run",
            status: "started",
        }),
        subscribeChat: async (request) => {
            requests.push(request);
            return {
                close: async () => {
                    closes += 1;
                },
            };
        },
        updateSessionSettings: async (input) => ({
            ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }),
            ...(input.model === undefined ? {} : { model: input.model }),
            sessionKey: input.sessionKey,
            ...(input.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: input.thinkingLevel }),
        }),
        ...overrides,
    };
    return { closeCount: () => closes, provider, requests };
}

function schedulerHarness() {
    const entries: Array<{ callback: () => void; delayMs: number; handle: object }> = [];
    const scheduler: ChatRecoveryScheduler = {
        clear(handle) {
            const index = entries.findIndex((entry) => entry.handle === handle);
            if (index !== -1) entries.splice(index, 1);
        },
        schedule(callback, delayMs) {
            const handle = {};
            entries.push({ callback, delayMs, handle });
            return handle;
        },
    };
    return { entries, scheduler };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });
    return { promise, reject, resolve };
}

function inertAttachmentPreparer() {
    return {
        prepare: async () => {
            throw new Error("Attachment preparation is not used by this test");
        },
    };
}

async function flushAsync(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("ChatService", () => {
    test("normalizes projection count and lifetime sequence boundaries", () => {
        const exactLifetimePart: ChatRuntimeProjectionPart = {
            id: "exact-lifetime-limit",
            kind: "item",
            sequence: chatRunEventMaximum,
            type: "progress",
        };
        const exactLifetime = normalizeExternalProjectionParts([exactLifetimePart]);
        expect(exactLifetime).toEqual({
            parts: [exactLifetimePart],
            partsExceeded: false,
        });

        const lifetimeParts: readonly ChatRuntimeProjectionPart[] = [
            {
                id: "at-limit",
                kind: "item",
                sequence: chatRunEventMaximum,
                type: "progress",
            },
            {
                id: "past-limit",
                kind: "item",
                sequence: chatRunEventMaximum + 1,
                type: "progress",
            },
        ];
        const lifetime = normalizeExternalProjectionParts(lifetimeParts);
        expect(lifetime.partsExceeded).toBeFalse();
        expect(lifetime.parts.map(({ sequence }) => sequence)).toEqual([1, 2]);

        const exactCount = Array.from(
            { length: chatRuntimeProjectionPartsMaximum },
            (_, index): ChatRuntimeProjectionPart => ({
                id: `exact-${index + 1}`,
                kind: "item",
                sequence: index + 1,
                type: "progress",
            })
        );
        expect(normalizeExternalProjectionParts(exactCount)).toEqual({
            parts: exactCount,
            partsExceeded: false,
        });

        const overflow = normalizeExternalProjectionParts(
            Array.from(
                { length: chatRuntimeProjectionPartsMaximum + 1 },
                (_, index): ChatRuntimeProjectionPart => ({
                    id: `item-${index + 1}`,
                    kind: "item",
                    sequence: index + 1,
                    type: "progress",
                })
            )
        );
        expect(overflow.partsExceeded).toBeTrue();
        expect(overflow.parts).toHaveLength(chatRuntimeProjectionPartsMaximum);
        expect(overflow.parts.at(0)).toMatchObject({ id: "item-2", sequence: 1 });
        expect(overflow.parts.at(-1)).toMatchObject({
            id: `item-${chatRuntimeProjectionPartsMaximum + 1}`,
            sequence: chatRuntimeProjectionPartsMaximum,
        });
    });

    test("reserves after admission, dispatches once, and commits only after ACK", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const provider = providerHarness({
            send: async () => {
                expect(repository.readIntent(runId)?.dispatchAttempted).toBeTrue();
                return { runId: "provider-run", status: "started" };
            },
        });
        const calls: string[] = [];
        const reservation: ChatAttachmentTicketReservation = {
            attachments: [
                {
                    content: "data:text/plain;base64,aGVsbG8=",
                    fileName: "note.txt",
                    mimeType: "text/plain",
                    type: "file",
                },
            ],
            commit: async () => {
                calls.push("commit");
            },
            release: async () => {
                calls.push("release");
            },
        };
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    const intent = repository.readIntent(runId);
                    expect(intent?.dispatchAttempted).toBeFalse();
                    calls.push("reserve");
                    return reservation;
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            const input = sendInput({ attachmentTicketId: ticketId });
            expect(await service.send(input, actor)).toMatchObject({
                admission: "created",
                run: { providerRunId: "provider-run" },
            });
            expect(calls).toEqual(["reserve", "commit"]);
            expect(await service.send(input, actor)).toMatchObject({
                admission: "replayed",
            });
            expect(calls).toEqual(["reserve", "commit"]);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("reconciles a provider-independent final within its user admission boundary", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 2000
        );
        const input = sendInput();
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                messages: [
                    {
                        ...unscopedHistoryUser("history-user", input.message, 1000, 1),
                        idempotencyKey: input.idempotencyKey,
                    },
                    {
                        content: {
                            kind: "complete",
                            parts: [
                                {
                                    id: "history-thinking-part",
                                    kind: "thinking",
                                    text: "Inspecting",
                                },
                            ],
                        },
                        createdAtMs: 1100,
                        id: "history-thinking",
                        role: "assistant",
                        sequence: 2,
                        source: "gateway-history",
                    },
                    {
                        content: {
                            kind: "complete",
                            parts: [
                                {
                                    callId: "history-tool-call",
                                    id: "history-tool-part",
                                    isError: false,
                                    kind: "tool",
                                    name: "status",
                                    phase: "succeeded",
                                },
                            ],
                        },
                        createdAtMs: 1200,
                        id: "history-tool",
                        role: "assistant",
                        sequence: 3,
                        source: "gateway-history",
                    },
                    {
                        content: {
                            kind: "complete",
                            parts: [
                                {
                                    id: "history-final-part",
                                    kind: "text",
                                    text: "Finished once",
                                },
                            ],
                        },
                        createdAtMs: 1300,
                        id: "history-final",
                        role: "assistant",
                        sequence: 4,
                        source: "gateway-history",
                    },
                    unscopedHistoryUser("next-user", "Next turn", 1400, 5),
                    {
                        content: {
                            kind: "complete",
                            parts: [
                                {
                                    id: "next-final-part",
                                    kind: "text",
                                    text: "Must not reconcile the first run",
                                },
                            ],
                        },
                        createdAtMs: 1500,
                        id: "next-final",
                        role: "assistant",
                        sequence: 6,
                        source: "gateway-history",
                    },
                ],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => 2000,
            provider: provider.provider,
            repository,
        });
        try {
            await service.send(input, actor);
            await provider.requests[0]!.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "provider-run",
                providerSequence: 1,
                receivedAtMs: 1600,
                sessionKey: input.sessionKey,
            });
            await flushAsync();

            expect(repository.findRun(input.clientRunId)).toMatchObject({
                reconciliation: "history-authoritative",
                state: "completed",
            });
            expect(
                database.orm
                    .select({ historyMessageId: chatRuns.historyMessageId })
                    .from(chatRuns)
                    .where(eq(chatRuns.id, input.clientRunId))
                    .get()?.historyMessageId
            ).toBe("history-final");
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("steers the latest locally admitted provider run with its exact identity", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const sends: Parameters<ChatProvider["send"]>[0][] = [];
        const provider = providerHarness({
            send: async (request) => {
                sends.push(request);
                return { runId: request.idempotencyKey, status: "started" };
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            await service.send(sendInput(), actor);
            await service.send(
                sendInput({
                    clientRunId: "019fe5a1-6cb9-7e51-ad2a-bf1f69861219",
                    idempotencyKey: "B".repeat(32),
                    message: "steer",
                }),
                actor
            );

            expect(sends).toHaveLength(2);
            expect(sends[1]).toMatchObject({
                expectedRunId: "A".repeat(32),
                queueMode: "steer",
            });
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("releases definitive failures and consumes unknown-outcome tickets", async () => {
        for (const outcome of ["definitive", "unknown"] as const) {
            const database = await openFreshMigratedDatabase();
            const repository = createChatRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission,
                "main",
                () => 1000
            );
            let commits = 0;
            let releases = 0;
            const scheduler = schedulerHarness();
            const provider = providerHarness({
                history: async () => ({
                    hasMore: false,
                    inFlightRun: {
                        runId: "A".repeat(32),
                        text: "working",
                    },
                    messages: [],
                }),
                send: async () => {
                    throw outcome === "unknown"
                        ? new ChatProviderUnknownOutcomeError()
                        : new ChatProviderUnavailableError();
                },
            });
            const service = createChatService({
                attachmentConsumer: {
                    reserve: async () => ({
                        attachments: [],
                        commit: async () => {
                            commits += 1;
                        },
                        release: async () => {
                            releases += 1;
                        },
                    }),
                },
                attachmentPreparer: inertAttachmentPreparer(),
                nowMs: () => 1000,
                provider: provider.provider,
                recoveryScheduler: scheduler.scheduler,
                repository,
            });
            try {
                const error = await captureFailure(() =>
                    service.send(sendInput({ attachmentTicketId: ticketId }), actor)
                );
                expect(error).toBeInstanceOf(ChatServiceError);
                await flushAsync();
                expect(repository.findRun(runId)?.state).toBe(
                    outcome === "unknown" ? "outcome-unknown" : "failed"
                );
                expect(commits).toBe(outcome === "unknown" ? 1 : 0);
                expect(releases).toBe(outcome === "unknown" ? 0 : 1);
            } finally {
                await service.dispose();
                expect(releases).toBe(outcome === "unknown" ? 0 : 1);
                database.sqlite.close(true);
            }
        }
    });

    test("settles every post-dispatch ticket without the aborted caller signal", async () => {
        for (const outcome of ["begin-dispatch", "definitive", "unknown"] as const) {
            const database = await openFreshMigratedDatabase();
            const durable = createChatRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission,
                "main",
                () => 1000
            );
            const controller = new AbortController();
            const cleanupSignals: Array<AbortSignal | undefined> = [];
            let sendCalls = 0;
            const repository: ChatRepository =
                outcome === "begin-dispatch"
                    ? {
                          ...durable,
                          beginDispatch: async () => {
                              controller.abort();
                              throw new Error("begin dispatch failed");
                          },
                      }
                    : durable;
            const provider = providerHarness({
                history: async () => ({ hasMore: false, messages: [] }),
                send: async () => {
                    sendCalls += 1;
                    controller.abort();
                    throw outcome === "unknown"
                        ? new ChatProviderUnknownOutcomeError()
                        : new ChatProviderUnavailableError();
                },
            });
            const service = createChatService({
                attachmentConsumer: {
                    reserve: async () => ({
                        attachments: [],
                        commit: async (signal) => {
                            cleanupSignals.push(signal);
                        },
                        release: async (signal) => {
                            cleanupSignals.push(signal);
                        },
                    }),
                },
                attachmentPreparer: inertAttachmentPreparer(),
                nowMs: () => 1000,
                provider: provider.provider,
                repository,
            });
            try {
                expect(
                    await captureFailure(() =>
                        service.send(
                            sendInput({ attachmentTicketId: ticketId }),
                            actor,
                            controller.signal
                        )
                    )
                ).toBeInstanceOf(ChatServiceError);
                await flushAsync();
                expect(cleanupSignals).toEqual([undefined]);
                expect(sendCalls).toBe(outcome === "begin-dispatch" ? 0 : 1);
                if (outcome === "unknown") {
                    await service.recover();
                    expect(sendCalls).toBe(1);
                    expect(
                        await service.send(
                            sendInput({ attachmentTicketId: ticketId }),
                            actor
                        )
                    ).toMatchObject({ admission: "replayed" });
                    expect(sendCalls).toBe(1);
                }
            } finally {
                await service.dispose();
                database.sqlite.close(true);
            }
        }
    });

    test("binds abort single-flight to both run and session identity", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const abortGate = deferred<{
            aborted: boolean;
            ok: boolean;
            runIds: readonly string[];
        }>();
        let abortCalls = 0;
        const provider = providerHarness({
            abort: async () => {
                abortCalls += 1;
                return abortGate.promise;
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            await service.send(sendInput(), actor);
            const correct = service.abort({ runId, sessionKey: "agent:main:main" });
            await flushAsync();
            expect(abortCalls).toBe(1);

            const crossSession = (await captureFailure(() =>
                service.abort({ runId, sessionKey: "agent:main:other" })
            )) as ChatServiceError;
            expect(crossSession).toBeInstanceOf(ChatServiceError);
            expect(crossSession.reason).toBe("not-found");
            abortGate.resolve({ aborted: true, ok: true, runIds: ["provider-run"] });
            expect(await correct).toMatchObject({ aborted: true });
            expect(abortCalls).toBe(1);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("retries definitive abort rejection and reconciles either acknowledgement", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        let abortCalls = 0;
        let historyCalls = 0;
        const scheduler = schedulerHarness();
        const provider = providerHarness({
            abort: async () => {
                abortCalls += 1;
                if (abortCalls === 1) throw new ChatProviderUnavailableError();
                return { aborted: false, ok: true, runIds: [] };
            },
            history: async () => {
                historyCalls += 1;
                return { hasMore: false, messages: [] };
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => 1000,
            provider: provider.provider,
            recoveryScheduler: scheduler.scheduler,
            repository,
        });
        try {
            await service.send(sendInput(), actor);
            expect(
                await captureFailure(() =>
                    service.abort({ runId, sessionKey: "agent:main:main" })
                )
            ).toBeInstanceOf(ChatServiceError);
            await flushAsync();
            expect(repository.findRun(runId)?.state).toBe("cancel-requested");

            expect(
                await service.abort({ runId, sessionKey: "agent:main:main" })
            ).toMatchObject({ aborted: false });
            await flushAsync();
            expect(abortCalls).toBe(2);
            expect(historyCalls).toBeGreaterThan(0);
            await service.abort({ runId, sessionKey: "agent:main:main" });
            expect(abortCalls).toBe(2);

            await provider.requests[0]!.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "provider-run",
                providerSequence: 1,
                receivedAtMs: 1300,
                sessionKey: "agent:main:main",
            });
            expect(repository.findRun(runId)?.state).toBe("completed");
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("persists accepted external user messages before canonical history settles", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => 1000,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const accepted = {
                idempotencyKey: "00000000-0000-4000-8000-000000000001",
                providerRunId: "external-live-user",
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                text: "visible before history settles",
            };
            await provider.requests[0]!.onEvent({ kind: "user", ...accepted });
            await provider.requests[0]!.onEvent({ kind: "user", ...accepted });

            const runtime = await service.runtime(runtimeInput());
            expect(runtime.externalRuns).toHaveLength(1);
            expect(runtime.externalRuns[0]?.parts).toEqual([
                {
                    kind: "user",
                    messageId: accepted.idempotencyKey,
                    occurredAtMs: 1001,
                    sequence: 1,
                    text: accepted.text,
                },
            ]);
            expect(
                repository.listExternalRuntimeSnapshots()[0]?.payload.entries[0]?.run
                    .parts
            ).toEqual(runtime.externalRuns[0]?.parts);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("requires an explicit terminal event before history retires a live run", async () => {
        const database = await openFreshMigratedDatabase();
        let messages: Awaited<ReturnType<ChatProvider["history"]>>["messages"] = [];
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1004
        );
        const provider = providerHarness({
            history: async () => ({ hasMore: false, messages }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => 1004,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            await subscription.onEvent({
                idempotencyKey: "provider-internal-user-id",
                kind: "user",
                providerRunId: "external-run-with-unscoped-history",
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                text: "test",
            });
            await service.observeProviderUserMessage({
                messageId: "0123456789abcdef0123456789abcdef",
                providerRunIds: ["external-run-with-unscoped-history"],
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                text: "test",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-run-with-unscoped-history",
                providerSequence: 1,
                receivedAtMs: 1002,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "done",
            });
            const activeRuntime = await service.runtime(runtimeInput());
            expect(activeRuntime.externalRuns[0]).toMatchObject({
                lifecycle: "active",
            });

            messages = [
                {
                    ...unscopedHistoryUser("provider-internal-user-id", "test", 1001, 1),
                    idempotencyKey: "0123456789abcdef0123456789abcdef",
                    runId: "external-run-with-unscoped-history",
                },
                {
                    content: {
                        kind: "complete",
                        parts: [
                            { id: "history-assistant-part", kind: "text", text: "done" },
                        ],
                    },
                    createdAtMs: 1003,
                    id: "history-assistant",
                    role: "assistant",
                    sequence: 2,
                    source: "gateway-history",
                },
            ];
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const historyEchoRuntime = await service.runtime(runtimeInput());
            expect(historyEchoRuntime.externalRuns[0]).toMatchObject({
                lifecycle: "active",
                parts: [
                    {
                        kind: "user",
                        messageId: "0123456789abcdef0123456789abcdef",
                        text: "test",
                    },
                    { kind: "assistant", text: "done" },
                ],
            });
            await subscription.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "external-run-with-unscoped-history",
                providerSequence: 2,
                receivedAtMs: 1004,
                sessionKey: "agent:main:main",
            });
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const terminalRuntime = await service.runtime(runtimeInput());
            expect(terminalRuntime.externalRuns).toEqual([]);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("bounds external projections and signals history only for terminal activity", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const coalescerScheduler = schedulerHarness();
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            coalescerScheduler: coalescerScheduler.scheduler,
            nowMs: () => 1000,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            const oversizedMultibyteProjection = "界".repeat(
                Math.ceil(chatRuntimeSnapshotMaximumBytes / 3)
            );
            for (let runIndex = 0; runIndex < 9; runIndex += 1) {
                const usesLargeProjection = runIndex >= 7;
                await subscription.onEvent({
                    kind: "delta",
                    mode: "replace",
                    providerRunId: `external-${runIndex}`,
                    providerSequence: 1,
                    receivedAtMs: 1001 + runIndex * 10,
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                    streamId: "assistant",
                    text: usesLargeProjection
                        ? oversizedMultibyteProjection
                        : `External run ${runIndex}`,
                });
            }
            await service.abort({
                abortAttemptId: "bounded-projection-abort",
                providerRunId: "external-8",
                sessionKey: "agent:main:main",
            });
            const runtime = await service.runtime(runtimeInput());
            expect(runtime.externalRuns).toHaveLength(8);
            expect(
                runtime.externalRuns.map(({ providerRunId }) => providerRunId)
            ).not.toContain("external-0");
            expect(runtime.externalRunsTruncated).toBeTrue();
            expect(
                runtime.externalRuns.some(
                    ({ projectionTruncated }) => projectionTruncated
                )
            ).toBeTrue();
            for (const external of runtime.externalRuns) {
                expect(external.streamResets).toEqual([
                    {
                        resetId: `${external.providerRunId}:1`,
                        streamId: "assistant",
                    },
                ]);
            }
            expect(utf8ByteLength(JSON.stringify(runtime))).toBeLessThanOrEqual(
                chatRuntimeResponseMaximumBytes
            );
            expect(
                runtime.externalRuns.find(
                    ({ providerRunId }) => providerRunId === "external-8"
                )
            ).toMatchObject({
                abortBoundary: {
                    attemptId: "bounded-projection-abort",
                    baselineUpdatedAtMs: 1081,
                    settlement: "not-aborted",
                },
                projectionTruncated: true,
            });
            const olderBoundedExternal = runtime.externalRuns.find(
                ({ providerRunId }) => providerRunId === "external-7"
            );
            const newerBoundedExternal = runtime.externalRuns.find(
                ({ providerRunId }) => providerRunId === "external-8"
            );
            expect(newerBoundedExternal).toMatchObject({
                hasUnprojectedActivity: true,
                parts: [],
                projectionTruncated: true,
            });
            expect(
                utf8ByteLength(JSON.stringify(newerBoundedExternal))
            ).toBeLessThanOrEqual(chatRuntimeSnapshotMaximumBytes);
            expect(olderBoundedExternal?.text.endsWith("界")).toBeTrue();
            expect(newerBoundedExternal?.text.endsWith("界")).toBeTrue();
            expect(newerBoundedExternal!.text.length).toBeGreaterThan(
                olderBoundedExternal!.text.length
            );
            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "chat.history"))
                    .all()
            ).toHaveLength(0);

            await subscription.onEvent({
                kind: "delta",
                mode: "merge",
                providerRunId: "external-late-baseline",
                providerSequence: 5,
                receivedAtMs: 1900,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "partial",
            });
            const lateRuntime = await service.runtime(runtimeInput());
            const lateBaseline = lateRuntime.externalRuns.find(
                ({ providerRunId }) => providerRunId === "external-late-baseline"
            );
            expect(lateBaseline).toMatchObject({
                continuity: "interrupted",
                hasUnprojectedActivity: true,
            });

            await subscription.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "fast-never-projected",
                providerSequence: 1,
                receivedAtMs: 2000,
                sessionKey: "agent:main:main",
            });

            const projectedRuntime = await service.runtime(runtimeInput());
            for (const external of projectedRuntime.externalRuns) {
                const terminalSequence =
                    external.providerRunId === "external-late-baseline" ? 6 : 2;
                await subscription.onEvent({
                    kind: "terminal",
                    outcome: "completed",
                    providerRunId: external.providerRunId,
                    providerSequence: terminalSequence,
                    receivedAtMs: 2100,
                    sessionKey: "agent:main:main",
                });
            }
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const cleaned = await service.runtime(runtimeInput());
            expect(cleaned.externalRuns).toHaveLength(8);
            expect(
                cleaned.externalRuns.every(
                    ({ lifecycle }) => lifecycle === "terminal-pending-history"
                )
            ).toBeTrue();
            expect(cleaned.externalRunsTruncated).toBeTrue();

            const projectedSegments = 3;
            for (let sequence = 1; sequence <= projectedSegments; sequence += 1) {
                await subscription.onEvent({
                    kind: "delta",
                    mode: sequence === 1 ? "replace" : "merge",
                    providerRunId: "external-many-parts",
                    providerSequence: sequence,
                    receivedAtMs: 2300 + sequence,
                    segmentId: `agent:preamble:preamble-${sequence}`,
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                    streamId: "agent:preamble",
                    text: `Preamble ${sequence}`,
                });
            }
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-many-parts",
                providerSequence: projectedSegments + 1,
                receivedAtMs: 2300 + projectedSegments + 1,
                sessionKey: "agent:main:main",
                stream: "assistant",
                streamId: "assistant",
                text: "Final response",
            });
            const manyPartsRuntime = await service.runtime(runtimeInput());
            const manyParts = manyPartsRuntime.externalRuns.find(
                ({ providerRunId }) => providerRunId === "external-many-parts"
            );
            expect(manyParts?.parts?.map(({ sequence }) => sequence)).toEqual([
                1, 2, 3, 4,
            ]);
            expect(manyParts?.streamResets).toEqual([
                {
                    resetId: "external-many-parts:1",
                    streamId: "agent:preamble",
                },
            ]);
            expect(manyParts?.parts?.at(-1)).toMatchObject({
                kind: "assistant",
                segmentId: `external-many-parts:${projectedSegments + 1}`,
                text: "Final response",
            });
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    }, 10_000);

    test("aborts an exact observed provider run without fabricating a durable local run", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const abortRequests: unknown[] = [];
        const provider = providerHarness({
            abort: async (request) => {
                abortRequests.push(request);
                const aborted = request.providerRunId !== "external-not-aborted";
                return {
                    aborted,
                    ok: true,
                    runIds: aborted ? [request.providerRunId!] : [],
                };
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => 1000,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            await provider.requests[0]!.onEvent({
                kind: "delta",
                mode: "merge",
                providerRunId: "external-exact-stop",
                providerSequence: 1,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "Still running",
            });
            const beforeAbort = await service.runtime(runtimeInput());
            expect(beforeAbort.externalRuns).toHaveLength(1);

            expect(
                await service.abort({
                    abortAttemptId: "abort-external-exact-stop",
                    providerRunId: "external-exact-stop",
                    sessionKey: "agent:main:main",
                })
            ).toEqual({
                aborted: true,
                abortAttemptId: "abort-external-exact-stop",
                providerRunId: "external-exact-stop",
            });
            expect(abortRequests).toEqual([
                {
                    preserveSideRuns: false,
                    providerRunId: "external-exact-stop",
                    sessionKey: "agent:main:main",
                },
            ]);
            const afterAbort = await service.runtime(runtimeInput());
            expect(afterAbort.externalRuns).toEqual([]);
            expect(
                repository.findByProviderCorrelation(
                    "agent:main:main",
                    "external-exact-stop"
                )
            ).toBeUndefined();
            expect(repository.listExternalRuntimeSnapshots()).toEqual([]);

            await provider.requests[0]!.onEvent({
                kind: "delta",
                mode: "merge",
                providerRunId: "external-not-aborted",
                providerSequence: 1,
                receivedAtMs: 1002,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "Still running after false acknowledgement",
            });
            expect(
                await service.abort({
                    abortAttemptId: "abort-external-not-aborted",
                    providerRunId: "external-not-aborted",
                    sessionKey: "agent:main:main",
                })
            ).toEqual({
                aborted: false,
                abortAttemptId: "abort-external-not-aborted",
                providerRunId: "external-not-aborted",
            });
            const notAbortedRuntime = await service.runtime(runtimeInput());
            expect(
                notAbortedRuntime.externalRuns.map(({ providerRunId }) => providerRunId)
            ).toContain("external-not-aborted");
            const notAbortedRun = notAbortedRuntime.externalRuns.find(
                ({ providerRunId }) => providerRunId === "external-not-aborted"
            );
            const notAbortedSnapshot = repository.listExternalRuntimeSnapshots()[0];
            expect(notAbortedSnapshot?.payload.entries[0]?.run).toMatchObject({
                abortBoundary: {
                    attemptId: "abort-external-not-aborted",
                    settlement: "not-aborted",
                },
                providerRunId: "external-not-aborted",
                updatedAtMs: notAbortedRun?.updatedAtMs,
            });
            expect(notAbortedSnapshot?.updatedAtMs).toBe(notAbortedRun?.updatedAtMs);

            expect(
                await service.abort({
                    abortAttemptId: "abort-external-not-aborted",
                    providerRunId: "external-not-aborted",
                    sessionKey: "agent:main:main",
                })
            ).toMatchObject({ aborted: false });
            expect(abortRequests).toHaveLength(2);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("fences external abort retries to the server-owned provider baseline and exact attempt", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const firstAbort = deferred<{
            aborted: boolean;
            ok: boolean;
            runIds: readonly string[];
        }>();
        const firstAbortDispatched = deferred<void>();
        let abortCalls = 0;
        const provider = providerHarness({
            abort: async () => {
                abortCalls += 1;
                if (abortCalls === 1) firstAbortDispatched.resolve();
                if (abortCalls === 1) return firstAbort.promise;
                if (abortCalls === 3) throw new ChatProviderUnavailableError();
                return { aborted: false, ok: true, runIds: [] };
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => 1000,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            await subscription.onEvent({
                kind: "delta",
                mode: "merge",
                providerRunId: "external-abort-fence",
                providerSequence: 1,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "Browser-visible response",
            });
            // This event is already server-owned before the browser dispatches its
            // abort from the older T=1001 projection.
            await subscription.onEvent({
                kind: "delta",
                mode: "merge",
                providerRunId: "external-abort-fence",
                providerSequence: 2,
                receivedAtMs: 1002,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "Server-ahead response",
            });

            const firstAttempt = service.abort({
                abortAttemptId: "abort-attempt-one",
                providerRunId: "external-abort-fence",
                sessionKey: "agent:main:main",
            });
            await firstAbortDispatched.promise;
            expect(abortCalls).toBe(1);
            const pendingAbortRuntime = await service.runtime(runtimeInput());
            const pendingAbortRun = pendingAbortRuntime.externalRuns[0];
            expect(pendingAbortRuntime.externalRuns[0]).toMatchObject({
                abortBoundary: {
                    attemptId: "abort-attempt-one",
                    baselineObservationEpoch: 2,
                    baselineUpdatedAtMs: 1002,
                    settlement: "pending",
                },
            });
            expect(pendingAbortRun?.updatedAtMs).toBeGreaterThan(1002);
            const pendingSnapshot = repository.listExternalRuntimeSnapshots()[0];
            expect(pendingSnapshot?.payload.entries[0]?.run).toEqual(pendingAbortRun);
            expect(pendingSnapshot?.updatedAtMs).toBe(pendingAbortRun?.updatedAtMs);
            const abortObservationEpoch = pendingSnapshot?.observationEpoch;
            expect(
                service.abort({
                    abortAttemptId: "abort-attempt-one",
                    providerRunId: "external-abort-fence",
                    sessionKey: "agent:main:main",
                })
            ).toBe(firstAttempt);
            const concurrentFailure = (await captureFailure(() =>
                service.abort({
                    abortAttemptId: "abort-attempt-two",
                    providerRunId: "external-abort-fence",
                    sessionKey: "agent:main:main",
                })
            )) as ChatServiceError;
            expect(concurrentFailure.reason).toBe("conflict");

            firstAbort.reject(new ChatProviderUnknownOutcomeError());
            const firstFailure = (await captureFailure(
                () => firstAttempt
            )) as ChatServiceError;
            expect(firstFailure.reason).toBe("unknown-outcome");
            const unknownAbortRuntime = await service.runtime(runtimeInput());
            const unknownAbortRun = unknownAbortRuntime.externalRuns[0];
            expect(unknownAbortRuntime.externalRuns[0]).toMatchObject({
                abortBoundary: {
                    attemptId: "abort-attempt-one",
                    baselineObservationEpoch: 2,
                    baselineUpdatedAtMs: 1002,
                    settlement: "unknown",
                },
            });
            expect(unknownAbortRun?.updatedAtMs).toBeGreaterThan(
                pendingAbortRun?.updatedAtMs ?? 0
            );
            const unknownSnapshot = repository.listExternalRuntimeSnapshots()[0];
            expect(unknownSnapshot?.payload.entries[0]?.run).toEqual(unknownAbortRun);
            expect(unknownSnapshot?.updatedAtMs).toBe(unknownAbortRun?.updatedAtMs);
            expect(unknownSnapshot?.observationEpoch).toBe(abortObservationEpoch);
            const replayFailure = (await captureFailure(() =>
                service.abort({
                    abortAttemptId: "abort-attempt-one",
                    providerRunId: "external-abort-fence",
                    sessionKey: "agent:main:main",
                })
            )) as ChatServiceError;
            expect(replayFailure.reason).toBe("unknown-outcome");
            const earlyRetryFailure = (await captureFailure(() =>
                service.abort({
                    abortAttemptId: "abort-attempt-two",
                    providerRunId: "external-abort-fence",
                    sessionKey: "agent:main:main",
                })
            )) as ChatServiceError;
            expect(earlyRetryFailure.reason).toBe("conflict");
            expect(abortCalls).toBe(1);

            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-abort-fence",
                providerSequence: 3,
                receivedAtMs: 1003,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: " after abort",
            });
            const advancedAbortRuntime = await service.runtime(runtimeInput());
            const advancedAbortRun = advancedAbortRuntime.externalRuns[0];
            expect(advancedAbortRuntime.externalRuns[0]).toMatchObject({
                abortBoundary: {
                    attemptId: "abort-attempt-one",
                    baselineObservationEpoch: 2,
                    baselineUpdatedAtMs: 1002,
                    settlement: "unknown",
                },
            });
            expect(advancedAbortRun?.updatedAtMs).toBeGreaterThanOrEqual(
                unknownAbortRun?.updatedAtMs ?? 0
            );
            expect(advancedAbortRun?.observationEpoch).toBeGreaterThan(
                unknownAbortRun?.observationEpoch ?? 0
            );
            expect(
                await service.abort({
                    abortAttemptId: "abort-attempt-two",
                    providerRunId: "external-abort-fence",
                    sessionKey: "agent:main:main",
                })
            ).toEqual({
                aborted: false,
                abortAttemptId: "abort-attempt-two",
                providerRunId: "external-abort-fence",
            });
            expect(abortCalls).toBe(2);
            const rejectedAbortRuntime = await service.runtime(runtimeInput());
            expect(rejectedAbortRuntime.externalRuns[0]).toMatchObject({
                abortBoundary: {
                    attemptId: "abort-attempt-two",
                    baselineObservationEpoch: 3,
                    baselineUpdatedAtMs: advancedAbortRun?.updatedAtMs,
                    settlement: "not-aborted",
                },
            });
            const rejectedAbortRun = rejectedAbortRuntime.externalRuns[0];
            const rejectedSnapshot = repository.listExternalRuntimeSnapshots()[0];
            expect(rejectedSnapshot?.payload.entries[0]?.run).toEqual(rejectedAbortRun);
            expect(rejectedSnapshot?.updatedAtMs).toBe(rejectedAbortRun?.updatedAtMs);

            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-abort-fence",
                providerSequence: 2,
                receivedAtMs: 1004,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: " before definitive failure",
            });
            const beforeDefinitiveFailureRuntime = await service.runtime(runtimeInput());
            const beforeDefinitiveFailure =
                beforeDefinitiveFailureRuntime.externalRuns[0];
            const definitiveFailure = await captureFailure(() =>
                service.abort({
                    abortAttemptId: "abort-attempt-three",
                    providerRunId: "external-abort-fence",
                    sessionKey: "agent:main:main",
                })
            );
            expect(definitiveFailure).toBeInstanceOf(ChatServiceError);
            expect(abortCalls).toBe(3);
            const afterDefinitiveFailureRuntime = await service.runtime(runtimeInput());
            const afterDefinitiveFailure = afterDefinitiveFailureRuntime.externalRuns[0];
            expect(afterDefinitiveFailure?.abortBoundary).toBeUndefined();
            expect(afterDefinitiveFailure?.updatedAtMs).toBeGreaterThan(
                beforeDefinitiveFailure?.updatedAtMs ?? 0
            );
            const definitiveFailureSnapshot =
                repository.listExternalRuntimeSnapshots()[0];
            expect(definitiveFailureSnapshot?.payload.entries[0]?.run).toEqual(
                afterDefinitiveFailure
            );
            expect(definitiveFailureSnapshot?.updatedAtMs).toBe(
                afterDefinitiveFailure?.updatedAtMs
            );
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("merges in-flight history snapshots without replacing live external detail", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        let includeSnapshotPlan = true;
        let snapshotText = "Snapshot answer";
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                inFlightRun: {
                    ...(includeSnapshotPlan
                        ? {
                              plan: {
                                  explanation: "Snapshot rationale",
                                  steps: [
                                      {
                                          status: "in_progress" as const,
                                          text: "Snapshot plan",
                                      },
                                  ],
                              },
                          }
                        : {}),
                    runId: "external-refresh",
                    text: snapshotText,
                },
                messages: [],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-refresh",
                providerSequence: 1,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                stream: "thinking",
                text: "Private reasoning",
            });
            await subscription.onEvent({
                callId: "synthetic-call",
                callIdSource: "synthetic",
                input: '{"query":"history"}',
                isError: false,
                kind: "tool",
                name: "search",
                nameSource: "synthetic",
                phase: "started",
                providerRunId: "external-refresh",
                providerSequence: 2,
                receivedAtMs: 1002,
                sessionKey: "agent:main:main",
            });
            await subscription.onEvent({
                callId: "synthetic-call",
                callIdSource: "synthetic",
                isError: false,
                kind: "tool",
                name: "search",
                nameSource: "synthetic",
                output: "Found",
                phase: "succeeded",
                providerRunId: "external-refresh",
                providerSequence: 3,
                receivedAtMs: 1003,
                sessionKey: "agent:main:main",
            });
            await subscription.onEvent({
                itemId: "item-1",
                itemType: "progress",
                kind: "item",
                providerRunId: "external-refresh",
                providerSequence: 4,
                receivedAtMs: 1004,
                sessionKey: "agent:main:main",
                text: "Checked history",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-refresh",
                providerSequence: 5,
                receivedAtMs: 1005,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "Answer",
            });
            await subscription.onEvent({
                kind: "plan",
                phase: "update",
                explanation: "Live rationale",
                providerRunId: "external-refresh",
                providerSequence: 6,
                receivedAtMs: 1006,
                sessionKey: "agent:main:main",
                steps: [{ status: "pending", text: "Live plan" }],
            });

            clock = 2000;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const refreshedRuntime = await service.runtime(runtimeInput());
            const refreshed = refreshedRuntime.externalRuns[0]!;
            expect(refreshed).toMatchObject({
                plan: {
                    explanation: "Snapshot rationale",
                    phase: "update",
                    steps: [{ status: "in_progress", text: "Snapshot plan" }],
                },
                providerRunId: "external-refresh",
                source: "provider-runtime",
                text: "Snapshot answer",
                updatedAtMs: 2000,
            });
            expect(refreshed.parts).toEqual([
                {
                    kind: "thinking",
                    occurredAtMs: 1001,
                    sequence: 1,
                    text: "Private reasoning",
                },
                {
                    callId: "synthetic-call",
                    callIdSource: "synthetic",
                    input: '{"query":"history"}',
                    isError: false,
                    kind: "tool",
                    name: "search",
                    nameSource: "synthetic",
                    occurredAtMs: 1002,
                    output: "Found",
                    phase: "succeeded",
                    sequence: 2,
                },
                {
                    id: "item-1",
                    kind: "item",
                    sequence: 3,
                    text: "Checked history",
                    type: "progress",
                },
                {
                    kind: "assistant",
                    occurredAtMs: 1005,
                    sequence: 4,
                    text: "Snapshot answer",
                },
            ]);

            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-refresh",
                providerSequence: 7,
                receivedAtMs: 2001,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: " continued",
            });
            await subscription.onEvent({
                itemId: "item-2",
                itemType: "progress",
                kind: "item",
                providerRunId: "external-refresh",
                providerSequence: 8,
                receivedAtMs: 2002,
                sessionKey: "agent:main:main",
                text: "Continued",
            });
            const continuedRuntime = await service.runtime(runtimeInput());
            const continued = continuedRuntime.externalRuns[0]!;
            expect(continued.text).toBe("Snapshot answer continued");
            expect(continued.parts?.slice(-2)).toEqual([
                {
                    kind: "assistant",
                    occurredAtMs: 1005,
                    sequence: 4,
                    text: "Snapshot answer continued",
                },
                {
                    id: "item-2",
                    kind: "item",
                    sequence: 5,
                    text: "Continued",
                    type: "progress",
                },
            ]);

            includeSnapshotPlan = false;
            snapshotText = "Snapshot answer continued";
            clock = 3000;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const withoutSnapshotPlanRuntime = await service.runtime(runtimeInput());
            const withoutSnapshotPlan = withoutSnapshotPlanRuntime.externalRuns[0]!;
            expect(withoutSnapshotPlan.plan).toEqual({
                explanation: "Snapshot rationale",
                phase: "update",
                steps: [{ status: "in_progress", text: "Snapshot plan" }],
            });
            expect(withoutSnapshotPlan.parts).toEqual(continued.parts);

            for (let index = 0; index < 5; index += 1) {
                await subscription.onEvent({
                    kind: "delta",
                    mode: "append",
                    providerRunId: "external-refresh",
                    providerSequence: 9 + index,
                    receivedAtMs: 3001 + index,
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                    text: "界".repeat(64 * 1024),
                });
            }
            const truncatedRuntime = await service.runtime(runtimeInput());
            expect(truncatedRuntime.externalRuns[0]).toMatchObject({
                parts: [],
                projectionTruncated: true,
                providerRunId: "external-refresh",
            });

            snapshotText = "Recovered snapshot";
            clock = 4000;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const recoveredRuntime = await service.runtime(runtimeInput());
            expect(recoveredRuntime.externalRuns[0]).toMatchObject({
                parts: [
                    {
                        kind: "assistant",
                        sequence: 1,
                        text: "Recovered snapshot",
                    },
                ],
                plan: {
                    explanation: "Snapshot rationale",
                    phase: "update",
                    steps: [{ status: "in_progress", text: "Snapshot plan" }],
                },
                projectionTruncated: true,
                source: "provider-runtime",
                text: "Recovered snapshot",
            });
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("adopts an in-flight assistant baseline before the first cumulative live delta", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                inFlightRun: {
                    runId: "external-baseline",
                    text: "Baseline answer.",
                },
                messages: [],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => 1000,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const subscription = provider.requests[0]!;
            const base = {
                kind: "delta" as const,
                mode: "merge" as const,
                providerRunId: "external-baseline",
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                stream: "assistant" as const,
                streamId: "assistant",
            };
            await subscription.onEvent({
                ...base,
                providerSequence: 1,
                text: "Baseline answer.",
            });
            await subscription.onEvent({
                ...base,
                providerSequence: 2,
                receivedAtMs: 1002,
                text: "Baseline answer. Continued.",
            });

            const baselineRuntime = await service.runtime(runtimeInput());
            const external = baselineRuntime.externalRuns[0]!;
            expect(external.parts).toEqual([
                {
                    kind: "assistant",
                    segmentId: "external-baseline:history-assistant",
                    sequence: 1,
                    streamId: "assistant",
                    text: "Baseline answer. Continued.",
                },
            ]);
            expect(external.text).toBe("Baseline answer. Continued.");
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("keeps one live run when history and runtime use different active-run identities", async () => {
        for (const order of ["history-first", "live-first"] as const) {
            const database = await openFreshMigratedDatabase();
            const repository = createChatRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission,
                "main",
                () => 1000
            );
            const provider = providerHarness({
                history: async () => ({
                    hasMore: false,
                    inFlightRun: { runId: "admission-run", text: "" },
                    messages: [
                        unscopedHistoryUser("active-user", "Start", 999, 1),
                        {
                            content: {
                                kind: "complete" as const,
                                parts: [
                                    {
                                        id: "partial-assistant-part",
                                        kind: "text" as const,
                                        text: "Partial",
                                    },
                                ],
                            },
                            createdAtMs: 1000,
                            id: "partial-assistant",
                            role: "assistant" as const,
                            sequence: 2,
                            source: "gateway-history" as const,
                        },
                    ],
                }),
            });
            const service = createChatService({
                attachmentConsumer: {
                    reserve: async () => {
                        throw new Error(
                            "Attachment reservation is not used by this test"
                        );
                    },
                },
                attachmentPreparer: inertAttachmentPreparer(),
                nowMs: () => 1000,
                provider: provider.provider,
                repository,
            });
            try {
                await service.runtime(runtimeInput());
                const observeLive = async (): Promise<void> => {
                    await provider.requests[0]!.onEvent({
                        kind: "delta",
                        mode: "append",
                        providerRunId: "model-run",
                        providerSequence: 1,
                        receivedAtMs: 1000,
                        sessionKey: "agent:main:main",
                        stream: "thinking",
                        text: "Working",
                    });
                };
                const observeHistory = async (): Promise<void> => {
                    await service.history({
                        cursor: "0",
                        limit: 50,
                        sessionKey: "agent:main:main",
                    });
                };
                if (order === "history-first") {
                    await observeHistory();
                    await observeLive();
                } else {
                    await observeLive();
                    await observeHistory();
                }
                const runtime = await service.runtime(runtimeInput());
                expect(runtime.externalRuns).toHaveLength(1);
                expect(runtime.externalRuns[0]).toMatchObject({
                    lifecycle: "active",
                    providerRunId: "model-run",
                    source: "provider-runtime",
                });
                expect(runtime.externalRuns[0]?.parts).toContainEqual(
                    expect.objectContaining({ kind: "thinking", text: "Working" })
                );
            } finally {
                await service.dispose();
                database.sqlite.close(true);
            }
        }
    });

    test("does not let delayed history regress a newer live external observation", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const historyStarted = deferred<void>();
        const staleHistory = deferred<{
            hasMore: false;
            inFlightRun: {
                plan: {
                    explanation: string;
                    steps: readonly [{ status: "pending"; text: string }];
                };
                runId: string;
                text: string;
            };
            messages: readonly [];
        }>();
        let historyCalls = 0;
        const provider = providerHarness({
            history: async () => {
                historyCalls += 1;
                if (historyCalls === 1) {
                    historyStarted.resolve();
                    return staleHistory.promise;
                }
                return {
                    hasMore: false,
                    inFlightRun: {
                        plan: {
                            explanation: "Later history explanation",
                            steps: [{ status: "pending" as const, text: "Later" }],
                        },
                        runId: "external-history-race",
                        text: "Later history",
                    },
                    messages: [],
                };
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const pendingHistory = service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            await historyStarted.promise;
            await provider.requests[0]!.onEvent({
                explanation: "Live explanation",
                kind: "plan",
                phase: "update",
                providerRunId: "external-history-race",
                providerSequence: 1,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                steps: [{ status: "in_progress", text: "Live" }],
            });
            await provider.requests[0]!.onEvent({
                kind: "delta",
                mode: "merge",
                providerRunId: "external-history-race",
                providerSequence: 2,
                receivedAtMs: 1002,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "New live text",
            });
            staleHistory.resolve({
                hasMore: false,
                inFlightRun: {
                    plan: {
                        explanation: "Stale explanation",
                        steps: [{ status: "pending", text: "Stale" }],
                    },
                    runId: "external-history-race",
                    text: "Old history text",
                },
                messages: [],
            });
            await pendingHistory;
            const liveRuntime = await service.runtime(runtimeInput());
            expect(liveRuntime.externalRuns[0]).toMatchObject({
                plan: {
                    explanation: "Live explanation",
                    steps: [{ status: "in_progress", text: "Live" }],
                },
                text: "New live text",
            });

            clock = 2000;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const laterHistoryRuntime = await service.runtime(runtimeInput());
            expect(laterHistoryRuntime.externalRuns[0]).toMatchObject({
                plan: {
                    explanation: "Later history explanation",
                    steps: [{ status: "pending", text: "Later" }],
                },
                text: "Later history",
            });
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("consumes a same-millisecond append burst already represented by history", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        let historyRunId = "external-equal-time";
        let historyText = "ABC";
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                inFlightRun: {
                    runId: historyRunId,
                    text: historyText,
                },
                messages: [],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-equal-time",
                providerSequence: 1,
                receivedAtMs: 1000,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "A",
            });
            clock = 1001;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-equal-time",
                providerSequence: 2,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "B",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-equal-time",
                providerSequence: 3,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "C",
            });

            const equalTimeRuntime = await service.runtime(runtimeInput());
            expect(equalTimeRuntime.externalRuns[0]).toMatchObject({ text: "ABC" });

            clock = 1002;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-equal-time",
                providerSequence: 4,
                receivedAtMs: 1002,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "C",
            });
            const repeatedSuffixRuntime = await service.runtime(runtimeInput());
            expect(repeatedSuffixRuntime.externalRuns[0]).toMatchObject({
                text: "ABC",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-equal-time",
                providerSequence: 5,
                receivedAtMs: 1003,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "C",
            });
            const laterReceiptRuntime = await service.runtime(runtimeInput());
            expect(laterReceiptRuntime.externalRuns[0]).toMatchObject({
                text: "ABC",
            });
            historyText = "ABCC";
            clock = 1004;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const repeatedSuffixCatchUp = await service.runtime(runtimeInput());
            expect(repeatedSuffixCatchUp.externalRuns[0]).toMatchObject({
                text: "ABCC",
            });

            historyRunId = "external-equal-time-authority";
            historyText = "ABC";
            clock = 2000;
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: historyRunId,
                providerSequence: 1,
                receivedAtMs: 2000,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "A",
            });
            clock = 2001;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "merge",
                providerRunId: historyRunId,
                providerSequence: 2,
                receivedAtMs: 2001,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "ABCD",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: historyRunId,
                providerSequence: 3,
                receivedAtMs: 2001,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "E",
            });
            const authorityRuntime = await service.runtime(runtimeInput());
            expect(
                authorityRuntime.externalRuns.find(
                    ({ providerRunId }) => providerRunId === historyRunId
                )
            ).toMatchObject({ text: "ABCDE" });

            historyRunId = "external-equal-time-catch-up";
            clock = 3000;
            await subscription.onEvent({
                kind: "delta",
                mode: "merge",
                providerRunId: historyRunId,
                providerSequence: 1,
                receivedAtMs: 3000,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "ABC",
            });
            clock = 3001;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const historyMarkersBeforeAmbiguity = database.orm
                .select()
                .from(realtimeEvents)
                .where(eq(realtimeEvents.topic, "chat.history"))
                .all().length;
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: historyRunId,
                providerSequence: 2,
                receivedAtMs: 3001,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "D",
            });
            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "chat.history"))
                    .all()
            ).toHaveLength(historyMarkersBeforeAmbiguity + 1);
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: historyRunId,
                providerSequence: 3,
                receivedAtMs: 3002,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "D",
            });
            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "chat.history"))
                    .all()
            ).toHaveLength(historyMarkersBeforeAmbiguity + 1);
            historyText = "ABCD";
            clock = 3002;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: historyRunId,
                providerSequence: 4,
                receivedAtMs: 3003,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "E",
            });
            const caughtUpRuntime = await service.runtime(runtimeInput());
            expect(
                caughtUpRuntime.externalRuns.find(
                    ({ providerRunId }) => providerRunId === historyRunId
                )
            ).toMatchObject({ text: "ABCDE" });
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("bounds a multibyte provider in-flight projection before runtime validation", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                inFlightRun: {
                    runId: "provider-multibyte-in-flight",
                    text: "界".repeat(256 * 1024),
                },
                messages: [],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const runtime = await service.runtime(runtimeInput());
            expect(runtime.externalRuns[0]).toMatchObject({
                hasUnprojectedActivity: true,
                parts: [],
                projectionTruncated: true,
                providerRunId: "provider-multibyte-in-flight",
            });
            expect(
                utf8ByteLength(JSON.stringify(runtime.externalRuns[0]))
            ).toBeLessThanOrEqual(chatRuntimeSnapshotMaximumBytes);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("cleans a snapshot-resolved reset and drops late events from the retired generation", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const lifecycle = createChatTranscriptLifecycleCoordinator(repository);
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
            transcriptLifecycle: lifecycle,
        });
        try {
            await service.runtime(runtimeInput());
            const retiredSubscription = provider.requests[0]!;
            await repository.admit(sendInput(), actor);
            await repository.beginDispatch(runId, new Date(1050));
            await lifecycle.beginControl({
                action: "reset",
                controlId: "reset-snapshot-control",
                key: "agent:main:main",
                occurredAtMs: 1100,
            });

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
            expect(provider.closeCount()).toBe(0);
            expect(repository.readTranscriptState("agent:main:main").status).toBe(
                "control-pending"
            );

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
            expect(provider.closeCount()).toBe(1);
            expect(repository.findRun(runId)).toBeUndefined();

            await retiredSubscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-before-reset",
                providerSequence: 1,
                receivedAtMs: 1200,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "late retired output",
            });
            const runtime = await service.runtime(runtimeInput());
            expect(runtime.transcriptGeneration).toBe(2);
            expect(runtime.externalRuns).toEqual([]);
            expect(runtime.runs).toEqual([]);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("releases the backend watch when a deleted transcript becomes absent", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const lifecycle = createChatTranscriptLifecycleCoordinator(repository);
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
            subscriptionMaximum: 1,
            transcriptLifecycle: lifecycle,
        });
        try {
            await service.runtime(runtimeInput());
            expect(provider.requests).toHaveLength(1);

            await lifecycle.observeLifecycleEvent({
                occurredAtMs: 1100,
                reason: "delete",
                sessionKey: "agent:main:main",
                updatedAtMs: 1100,
            });

            expect(repository.readTranscriptState("agent:main:main")).toMatchObject({
                currentGeneration: 2,
                status: "absent",
            });
            expect(provider.closeCount()).toBe(1);
            expect(provider.requests).toHaveLength(1);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("retires terminal-confirmed finals and expires unmatched interrupted projections", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        let finalRunId: string | undefined;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                messages:
                    finalRunId === undefined
                        ? []
                        : [
                              {
                                  content: {
                                      kind: "complete" as const,
                                      parts: [
                                          {
                                              id: `part-${finalRunId}`,
                                              kind: "text" as const,
                                              text: "done",
                                          },
                                      ],
                                  },
                                  id: `message-${finalRunId}`,
                                  role: "assistant" as const,
                                  runId: finalRunId,
                                  source: "gateway-history" as const,
                              },
                          ],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-lost-terminal",
                providerSequence: 1,
                receivedAtMs: clock,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "working",
            });
            const historyBefore = database.orm
                .select()
                .from(realtimeEvents)
                .where(eq(realtimeEvents.topic, "chat.history"))
                .all().length;
            const runtimeBefore = database.orm
                .select()
                .from(realtimeEvents)
                .where(eq(realtimeEvents.topic, "chat.runtime"))
                .all().length;
            finalRunId = "external-lost-terminal";
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const historyOnlyRuntime = await service.runtime(runtimeInput());
            expect(historyOnlyRuntime.externalRuns).toHaveLength(1);
            await subscription.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "external-lost-terminal",
                providerSequence: 4,
                receivedAtMs: clock,
                sessionKey: "agent:main:main",
            });
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const reconciledRuntime = await service.runtime(runtimeInput());
            expect(reconciledRuntime.externalRuns).toEqual([]);
            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "chat.history"))
                    .all()
            ).toHaveLength(historyBefore + 2);
            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "chat.runtime"))
                    .all().length
            ).toBeGreaterThanOrEqual(runtimeBefore + 1);

            finalRunId = undefined;
            await provider.requests.at(-1)!.onGap({
                expectedSequence: 1,
                providerRunId: "external-unmatched",
                receivedSequence: 2,
                sessionKey: "agent:main:main",
            });
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const unmatchedRuntime = await service.runtime(runtimeInput());
            expect(
                unmatchedRuntime.externalRuns.map(({ providerRunId }) => providerRunId)
            ).toEqual(["external-unmatched"]);

            clock += chatExternalRunStaleMilliseconds;
            const expiredRuntime = await service.runtime(runtimeInput());
            expect(expiredRuntime.externalRuns).toEqual([]);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("coalesces external token bursts and flushes boundaries before terminal history", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const scheduler = schedulerHarness();
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            coalescerScheduler: scheduler.scheduler,
            provider: provider.provider,
            repository,
        });
        const topics = (): string[] =>
            database.orm
                .select({ topic: realtimeEvents.topic })
                .from(realtimeEvents)
                .orderBy(realtimeEvents.id)
                .all()
                .map(({ topic }) => topic);
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            for (const [index, text] of ["one", "-two", "-three"].entries()) {
                await subscription.onEvent({
                    kind: "delta",
                    mode: "append",
                    providerRunId: "external-burst",
                    providerSequence: index + 1,
                    receivedAtMs: 1000 + index,
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                    text,
                });
            }
            expect(topics()).toEqual([]);
            expect(scheduler.entries).toHaveLength(1);
            expect(scheduler.entries[0]?.delayMs).toBe(chatDeltaCoalescingMilliseconds);
            const burst = scheduler.entries.shift()!;
            burst.callback();
            await flushAsync();
            expect(topics()).toEqual(["chat.runtime"]);
            const burstRuntime = await service.runtime(runtimeInput());
            expect(burstRuntime.externalRuns[0]?.text).toBe("one-two-three");

            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-burst",
                providerSequence: 4,
                receivedAtMs: 1004,
                sessionKey: "agent:main:main",
                stream: "thinking",
                text: "private reasoning",
            });
            expect(scheduler.entries).toHaveLength(1);
            await subscription.onEvent({
                callId: "call-1",
                input: '{"query":"runtime"}',
                isError: false,
                kind: "tool",
                name: "search",
                phase: "started",
                providerRunId: "external-burst",
                providerSequence: 5,
                receivedAtMs: 1005,
                sessionKey: "agent:main:main",
            });
            expect(scheduler.entries).toEqual([]);
            expect(topics()).toEqual(["chat.runtime", "chat.runtime"]);

            await subscription.onEvent({
                callId: "call-1",
                isError: false,
                kind: "tool",
                name: "search",
                output: "found",
                phase: "succeeded",
                providerRunId: "external-burst",
                providerSequence: 6,
                receivedAtMs: 1006,
                sessionKey: "agent:main:main",
            });
            const toolRuntime = await service.runtime(runtimeInput());
            expect(toolRuntime.externalRuns[0]).toMatchObject({
                hasUnprojectedActivity: false,
                projectionTruncated: false,
            });
            expect(toolRuntime.externalRuns[0]?.parts).toEqual([
                {
                    kind: "assistant",
                    occurredAtMs: 1000,
                    sequence: 1,
                    text: "one-two-three",
                },
                {
                    kind: "thinking",
                    occurredAtMs: 1004,
                    sequence: 2,
                    text: "private reasoning",
                },
                {
                    callId: "call-1",
                    input: '{"query":"runtime"}',
                    isError: false,
                    kind: "tool",
                    name: "search",
                    occurredAtMs: 1005,
                    output: "found",
                    phase: "succeeded",
                    sequence: 3,
                },
            ]);

            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-burst",
                providerSequence: 7,
                receivedAtMs: 1007,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "!",
            });
            expect(scheduler.entries).toHaveLength(1);
            await subscription.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "external-burst",
                providerSequence: 8,
                receivedAtMs: 1008,
                sessionKey: "agent:main:main",
            });
            expect(scheduler.entries).toEqual([]);
            expect(topics()).toEqual([
                "chat.runtime",
                "chat.runtime",
                "chat.runtime",
                "chat.runtime",
                "chat.history",
                "chat.runtime",
            ]);
            const terminalRuntime = await service.runtime(runtimeInput());
            expect(terminalRuntime.externalRuns).toMatchObject([
                {
                    lifecycle: "terminal-pending-history",
                    providerRunId: "external-burst",
                },
            ]);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("keeps an observed external run subscribed across idle sweeps", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        let terminalInHistory = false;
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                messages: terminalInHistory
                    ? [
                          {
                              content: {
                                  kind: "complete" as const,
                                  parts: [
                                      {
                                          id: "external-live-final-part",
                                          kind: "text" as const,
                                          text: "done",
                                      },
                                  ],
                              },
                              id: "external-live-final",
                              role: "assistant" as const,
                              runId: "external-live-run",
                              source: "gateway-history" as const,
                          },
                      ]
                    : [],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
            subscriptionIdleMilliseconds: 100,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            await subscription.onEvent({
                kind: "status",
                phase: "starting-model",
                providerRunId: "external-live-run",
                providerSequence: 1,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
            });

            clock = 1200;
            expect(await service.sweepSubscriptions()).toBe(0);
            expect(provider.closeCount()).toBe(0);

            await subscription.onReconciliationRequired("transport");
            expect(provider.requests).toHaveLength(2);
            expect(provider.closeCount()).toBe(1);
            const transportRuntime = await service.runtime(runtimeInput());
            expect(transportRuntime.externalRuns[0]).toMatchObject({
                continuity: "complete",
                hasUnprojectedActivity: false,
                projectionTruncated: false,
            });

            await provider.requests[1]!.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "external-live-run",
                providerSequence: 2,
                receivedAtMs: clock,
                sessionKey: "agent:main:main",
            });
            clock = 1400;
            expect(await service.sweepSubscriptions()).toBe(0);
            terminalInHistory = true;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            clock = 1600;
            expect(await service.sweepSubscriptions()).toBe(0);
            expect(provider.closeCount()).toBe(1);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("pins a history-discovered in-flight run after a process restart", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        let active = true;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                ...(active
                    ? {
                          inFlightRun: {
                              runId: "external-before-restart",
                              text: "",
                          },
                      }
                    : {}),
                messages: [],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
            subscriptionIdleMilliseconds: 100,
        });
        try {
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            clock = 1200;
            expect(await service.sweepSubscriptions()).toBe(0);

            await provider.requests[0]!.onReconciliationRequired("transport");
            expect(provider.requests).toHaveLength(2);

            active = false;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            clock = 1400;
            expect(await service.sweepSubscriptions()).toBe(0);
            expect(provider.closeCount()).toBe(1);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("keeps provider-origin activity across restart when an active history echo matches the in-flight run", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        let historyPhase: "active" | "final" = "active";
        const historyUser = {
            content: {
                kind: "complete" as const,
                parts: [
                    {
                        id: "external-restart-user-text",
                        kind: "text" as const,
                        text: "Continue with the checks",
                    },
                ],
            },
            createdAtMs: 1002,
            id: "external-restart-user",
            role: "user" as const,
            runId: "external-restart-run",
            sequence: 1,
            source: "gateway-history" as const,
        };
        const activeAssistantEcho = {
            content: {
                kind: "complete" as const,
                parts: [
                    {
                        id: "external-restart-active-echo-text",
                        kind: "text" as const,
                        text: "Still working",
                    },
                ],
            },
            createdAtMs: 1003,
            id: "external-restart-active-echo",
            role: "assistant" as const,
            runId: "external-restart-run",
            sequence: 2,
            source: "gateway-history" as const,
        };
        const historyPage = async (request: ChatProviderHistoryRequest) => {
            if (historyPhase === "active") {
                return request.offset === 0
                    ? {
                          hasMore: true,
                          inFlightRun: {
                              runId: "external-restart-run",
                              text: "",
                          },
                          messages: [historyUser],
                          nextOffset: 1,
                      }
                    : {
                          hasMore: false,
                          messages: [activeAssistantEcho],
                      };
            }
            return {
                hasMore: false,
                messages: [
                    historyUser,
                    {
                        content: {
                            kind: "complete" as const,
                            parts: [
                                {
                                    id: "external-restart-final-text",
                                    kind: "text" as const,
                                    text: "Finished",
                                },
                            ],
                        },
                        createdAtMs: 1006,
                        id: "external-restart-final",
                        role: "assistant" as const,
                        runId: "external-restart-run",
                        sequence: 2,
                        source: "gateway-history" as const,
                    },
                ],
            };
        };
        const firstRepository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const firstProvider = providerHarness({ history: historyPage });
        const firstService = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: firstProvider.provider,
            repository: firstRepository,
        });
        try {
            await firstService.runtime(runtimeInput());
            const firstSubscription = firstProvider.requests[0]!;
            await firstSubscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-restart-run",
                providerSequence: 1,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                stream: "thinking",
                text: "Inspecting state",
            });
            await firstSubscription.onEvent({
                callId: "external-restart-tool",
                input: '{"cmd":"status"}',
                isError: false,
                kind: "tool",
                name: "bash",
                phase: "started",
                providerRunId: "external-restart-run",
                providerSequence: 2,
                receivedAtMs: 1003,
                sessionKey: "agent:main:main",
            });
            clock = 1004;
            await firstService.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const beforeRestart = await firstService.runtime(runtimeInput());
            expect(beforeRestart.externalRuns[0]?.parts).toMatchObject([
                { kind: "thinking", occurredAtMs: 1001 },
                {
                    kind: "user",
                    messageId: "external-restart-user",
                    occurredAtMs: 1002,
                },
                { kind: "tool", occurredAtMs: 1003 },
            ]);
            expect(
                firstRepository.listExternalRuntimeSnapshots()[0]?.payload.entries[0]?.run
                    .parts
            ).toMatchObject([
                { kind: "thinking", occurredAtMs: 1001 },
                {
                    kind: "user",
                    messageId: "external-restart-user",
                    occurredAtMs: 1002,
                },
                { kind: "tool", occurredAtMs: 1003 },
            ]);

            await firstService.dispose();
            expect(firstRepository.listExternalRuntimeSnapshots()).toHaveLength(1);

            const restartedRepository = createChatRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission,
                "main",
                () => clock
            );
            const restartedProvider = providerHarness({ history: historyPage });
            const restartedService = createChatService({
                attachmentConsumer: {
                    reserve: async () => {
                        throw new Error(
                            "Attachment reservation is not used by this test"
                        );
                    },
                },
                attachmentPreparer: inertAttachmentPreparer(),
                nowMs: () => clock,
                provider: restartedProvider.provider,
                repository: restartedRepository,
            });
            try {
                await restartedService.recover();
                expect(restartedProvider.requests).toHaveLength(1);
                expect(restartedProvider.requests[0]?.runWatermarks).toEqual([
                    {
                        lastProviderSequence: 2,
                        providerRunId: "external-restart-run",
                    },
                ]);
                const hydrated = await restartedService.runtime(runtimeInput());
                expect(hydrated.externalRuns[0]).toMatchObject({
                    lifecycle: "active",
                    providerRunId: "external-restart-run",
                });
                expect(hydrated.externalRuns[0]?.parts).toMatchObject([
                    { kind: "thinking", occurredAtMs: 1001 },
                    {
                        kind: "user",
                        messageId: "external-restart-user",
                        occurredAtMs: 1002,
                    },
                    { kind: "tool", occurredAtMs: 1003 },
                ]);

                clock = 1005;
                await restartedProvider.requests[0]!.onEvent({
                    kind: "terminal",
                    outcome: "completed",
                    providerRunId: "external-restart-run",
                    providerSequence: 3,
                    receivedAtMs: clock,
                    sessionKey: "agent:main:main",
                });
                const terminalRuntime = await restartedService.runtime(runtimeInput());
                expect(terminalRuntime.externalRuns[0]).toMatchObject({
                    lifecycle: "terminal-pending-history",
                });
                expect(restartedRepository.listExternalRuntimeSnapshots()).toHaveLength(
                    1
                );

                historyPhase = "final";
                clock = 1006;
                await restartedService.history({
                    cursor: "0",
                    limit: 50,
                    sessionKey: "agent:main:main",
                });
                const retiredRuntime = await restartedService.runtime(runtimeInput());
                expect(retiredRuntime.externalRuns).toEqual([]);
                expect(restartedRepository.listExternalRuntimeSnapshots()).toEqual([]);
            } finally {
                await restartedService.dispose();
            }
        } finally {
            await firstService.dispose();
            database.sqlite.close(true);
        }
    });

    test("keeps a restarted terminal snapshot pending when history still reports it in flight", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const firstProvider = providerHarness();
        const firstService = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: firstProvider.provider,
            repository,
        });
        try {
            await firstService.runtime(runtimeInput());
            await firstProvider.requests[0]!.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-terminal-restart",
                providerSequence: 1,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
                stream: "thinking",
                text: "Finishing",
            });
            clock = 1002;
            await firstProvider.requests[0]!.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "external-terminal-restart",
                providerSequence: 2,
                receivedAtMs: clock,
                sessionKey: "agent:main:main",
            });
            await firstService.dispose();

            clock = 1003;
            const restartedProvider = providerHarness({
                history: async () => ({
                    hasMore: false,
                    inFlightRun: {
                        runId: "external-terminal-restart",
                        text: "",
                    },
                    messages: [],
                }),
            });
            const restartedService = createChatService({
                attachmentConsumer: {
                    reserve: async () => {
                        throw new Error(
                            "Attachment reservation is not used by this test"
                        );
                    },
                },
                attachmentPreparer: inertAttachmentPreparer(),
                nowMs: () => clock,
                provider: restartedProvider.provider,
                repository,
            });
            try {
                await restartedService.recover();
                const restartedRuntime = await restartedService.runtime(runtimeInput());
                expect(restartedRuntime.externalRuns).toMatchObject([
                    {
                        lifecycle: "terminal-pending-history",
                        providerRunId: "external-terminal-restart",
                    },
                ]);
                expect(
                    repository.listExternalRuntimeSnapshots()[0]?.payload.entries[0]?.run
                        .lifecycle
                ).toBe("terminal-pending-history");
            } finally {
                await restartedService.dispose();
            }
        } finally {
            await firstService.dispose();
            database.sqlite.close(true);
        }
    });

    test("retires stale persisted provider runs from authoritative active-run inventory", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const firstProvider = providerHarness();
        const firstService = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: firstProvider.provider,
            repository,
        });
        try {
            await firstService.runtime(runtimeInput());
            for (const [providerRunId, providerSequence, text] of [
                ["stale-provider-run", 1, "Preserve stale details"],
                ["current-provider-run", 1, "Preserve current details"],
            ] as const) {
                clock += 1;
                await firstProvider.requests[0]!.onEvent({
                    kind: "delta",
                    mode: "append",
                    providerRunId,
                    providerSequence,
                    receivedAtMs: clock,
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                    text,
                });
            }
            await firstService.dispose();

            clock += 1;
            const restartedProvider = providerHarness({
                history: async () => ({
                    hasMore: false,
                    inFlightRun: { runId: "current-provider-run", text: "" },
                    messages: [
                        {
                            content: {
                                kind: "complete" as const,
                                parts: [
                                    {
                                        id: "stale-final-text",
                                        kind: "text" as const,
                                        text: "Finished",
                                    },
                                ],
                            },
                            createdAtMs: clock,
                            id: "stale-final",
                            role: "assistant" as const,
                            runId: "stale-provider-run",
                            sequence: 1,
                            source: "gateway-history" as const,
                        },
                    ],
                }),
            });
            const restartedService = createChatService({
                activeProviderRunIds: async () => ["current-provider-run"],
                attachmentConsumer: {
                    reserve: async () => {
                        throw new Error(
                            "Attachment reservation is not used by this test"
                        );
                    },
                },
                attachmentPreparer: inertAttachmentPreparer(),
                nowMs: () => clock,
                provider: restartedProvider.provider,
                repository,
            });
            try {
                await restartedService.recover();
                const runtime = await restartedService.runtime(runtimeInput());
                expect(runtime.externalRuns).toHaveLength(1);
                expect(runtime.externalRuns[0]).toMatchObject({
                    lifecycle: "active",
                    providerRunId: "current-provider-run",
                    parts: [{ kind: "thinking", text: "Preserve current details" }],
                });
            } finally {
                await restartedService.dispose();
            }
        } finally {
            await firstService.dispose();
            database.sqlite.close(true);
        }
    });

    test("removes Stop authority immediately when inventory reports no active provider run", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        let activeProviderRunIds: readonly string[] = ["inventory-terminal-run"];
        const provider = providerHarness({
            history: async () => ({ hasMore: false, messages: [] }),
        });
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const service = createChatService({
            activeProviderRunIds: async () => activeProviderRunIds,
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            await provider.requests[0]!.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "inventory-terminal-run",
                providerSequence: 1,
                receivedAtMs: clock,
                sessionKey: "agent:main:main",
                stream: "thinking",
                text: "Retain this detail",
            });
            activeProviderRunIds = [];
            clock += 1;
            await service.reconcileProviderSessionActivity("agent:main:main");
            const runtime = await service.runtime(runtimeInput());
            expect(runtime.externalRuns).toMatchObject([
                {
                    lifecycle: "terminal-pending-history",
                    parts: [{ kind: "thinking", text: "Retain this detail" }],
                    providerRunId: "inventory-terminal-run",
                },
            ]);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("correlates only causally adjacent unscoped history users to one external run", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1_000_000;
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                inFlightRun: { runId: "external-unscoped-users", text: "" },
                messages: [
                    unscopedHistoryUser("unrelated-old", "Old turn", 600_000, 1),
                    unscopedHistoryUser("current-prompt", "Start this run", 999_999, 2),
                    unscopedHistoryUser("current-steer", "Adjust it", 1_000_002, 3),
                    unscopedHistoryUser("unrelated-future", "Later turn", 1_005_000, 4),
                ],
            }),
        });
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            await provider.requests[0]!.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "external-unscoped-users",
                providerSequence: 1,
                receivedAtMs: 1_000_001,
                sessionKey: "agent:main:main",
                stream: "thinking",
                text: "Inspecting",
            });
            await provider.requests[0]!.onEvent({
                callId: "external-unscoped-tool",
                isError: false,
                kind: "tool",
                name: "bash",
                phase: "started",
                providerRunId: "external-unscoped-users",
                providerSequence: 2,
                receivedAtMs: 1_000_003,
                sessionKey: "agent:main:main",
            });
            clock = 1_000_004;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            const runtime = await service.runtime(runtimeInput());
            expect(
                runtime.externalRuns[0]?.parts?.flatMap((part) =>
                    part.kind === "user" ? [part.messageId] : []
                )
            ).toEqual(["current-prompt", "current-steer"]);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("attaches unscoped history users to the sole active run instead of stale pending runs", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1_000_000;
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                inFlightRun: { runId: "current-active-run", text: "" },
                messages: [
                    unscopedHistoryUser(
                        "current-external-user",
                        "Show this immediately",
                        999_999,
                        1
                    ),
                ],
            }),
        });
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "stale-pending-run",
                providerSequence: 1,
                receivedAtMs: 999_000,
                sessionKey: "agent:main:main",
                stream: "thinking",
                text: "Old activity",
            });
            await subscription.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "stale-pending-run",
                providerSequence: 2,
                receivedAtMs: 999_100,
                sessionKey: "agent:main:main",
            });
            await subscription.onEvent({
                kind: "delta",
                mode: "append",
                providerRunId: "current-active-run",
                providerSequence: 1,
                receivedAtMs: 1_000_001,
                sessionKey: "agent:main:main",
                stream: "thinking",
                text: "Current activity",
            });
            await service.observeProviderUserMessage({
                attachments: [
                    {
                        downloadUrl:
                            "/api/chat/media/00000000-0000-4000-8000-000000000002?disposition=download",
                        fileName: "logo.jpg",
                        id: "session-media:1",
                        kind: "attachment",
                        mediaType: "image/jpeg",
                        renderPolicy: "inline-image",
                        sizeBytes: 7861,
                        url: "/api/chat/media/00000000-0000-4000-8000-000000000002?disposition=preview",
                    },
                ],
                messageId: "current-external-user",
                providerRunIds: ["stale-pending-run", "current-active-run"],
                receivedAtMs: 1_000_002,
                sessionKey: "agent:main:main",
                text: "Show this immediately",
            });
            const immediateRuntime = await service.runtime(runtimeInput());
            expect(
                immediateRuntime.externalRuns
                    .find(({ providerRunId }) => providerRunId === "current-active-run")
                    ?.parts?.flatMap((part) =>
                        part.kind === "user" ? [part.messageId] : []
                    )
            ).toEqual(["current-external-user"]);
            expect(
                immediateRuntime.externalRuns
                    .find(({ providerRunId }) => providerRunId === "current-active-run")
                    ?.parts?.find(({ kind }) => kind === "user")
            ).toMatchObject({
                attachments: [{ kind: "attachment", mediaType: "image/jpeg" }],
            });
            clock = 1_000_002;
            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });

            const runtime = await service.runtime(runtimeInput());
            const active = runtime.externalRuns.find(
                ({ providerRunId }) => providerRunId === "current-active-run"
            );
            const pending = runtime.externalRuns.find(
                ({ providerRunId }) => providerRunId === "stale-pending-run"
            );
            expect(
                active?.parts?.flatMap((part) =>
                    part.kind === "user" ? [part.messageId] : []
                )
            ).toEqual(["current-external-user"]);
            expect(pending?.lifecycle).toBe("terminal-pending-history");
            expect(pending?.parts?.some(({ kind }) => kind === "user")).toBeFalse();

            await service.observeProviderUserMessage({
                messageId: "early-user",
                providerRunIds: ["older-candidate", "newest-candidate"],
                receivedAtMs: 1_000_003,
                sessionKey: "agent:main:early",
                text: "Visible before the first runtime event",
            });
            const earlyRuntime = await service.runtime(runtimeInput("agent:main:early"));
            expect(earlyRuntime.externalRuns).toHaveLength(1);
            expect(earlyRuntime.externalRuns[0]).toMatchObject({
                providerRunId: "newest-candidate",
                parts: [
                    {
                        kind: "user",
                        messageId: "early-user",
                        text: "Visible before the first runtime event",
                    },
                ],
            });
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("retries a rejected empty-snapshot retirement during disposal", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 2000
        );
        let failFirstTombstone = true;
        let tombstoneAttempts = 0;
        const faultedRepository: ChatRepository = {
            ...repository,
            replaceExternalRuntimeSnapshot: async (input) => {
                if (input.payload.entries.length === 0) {
                    tombstoneAttempts += 1;
                    if (failFirstTombstone) {
                        failFirstTombstone = false;
                        return false;
                    }
                }
                return repository.replaceExternalRuntimeSnapshot(input);
            },
        };
        const provider = providerHarness({
            history: async () => ({
                hasMore: false,
                messages: [
                    {
                        content: {
                            kind: "complete" as const,
                            parts: [
                                {
                                    id: "dispose-retry-final-part",
                                    kind: "text" as const,
                                    text: "Done",
                                },
                            ],
                        },
                        id: "dispose-retry-final",
                        role: "assistant" as const,
                        runId: "dispose-retry-run",
                        source: "gateway-history" as const,
                    },
                ],
            }),
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            onAsyncFailure: () => {},
            provider: provider.provider,
            repository: faultedRepository,
        });
        try {
            await service.runtime(runtimeInput());
            await provider.requests[0]!.onEvent({
                kind: "status",
                phase: "starting-model",
                providerRunId: "dispose-retry-run",
                providerSequence: 1,
                receivedAtMs: 1001,
                sessionKey: "agent:main:main",
            });
            expect(repository.listExternalRuntimeSnapshots()).toHaveLength(1);

            await provider.requests[0]!.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "dispose-retry-run",
                providerSequence: 2,
                receivedAtMs: 1002,
                sessionKey: "agent:main:main",
            });

            await service.history({
                cursor: "0",
                limit: 50,
                sessionKey: "agent:main:main",
            });
            expect(tombstoneAttempts).toBe(1);
            expect(repository.listExternalRuntimeSnapshots()).toHaveLength(1);

            await service.dispose();
            expect(tombstoneAttempts).toBe(2);
            expect(repository.listExternalRuntimeSnapshots()).toEqual([]);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("retires capacity evictions durably before persisting a new external run", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const failures: unknown[] = [];
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            onAsyncFailure: (error) => failures.push(error),
            provider: provider.provider,
            repository,
        });
        try {
            for (
                let index = 0;
                index < chatExternalRunsPerProcessMaximum + 1;
                index += 1
            ) {
                const sessionKey = `agent:main:external-capacity-${index}`;
                clock = 1000 + index;
                await service.runtime(runtimeInput(sessionKey));
                await provider.requests[index]!.onEvent({
                    kind: "status",
                    phase: "starting-model",
                    providerRunId: `external-capacity-run-${index}`,
                    providerSequence: 1,
                    receivedAtMs: clock,
                    sessionKey,
                });
            }

            const durableEntries = repository
                .listExternalRuntimeSnapshots()
                .flatMap(({ payload }) => payload.entries);
            expect(failures).toEqual([]);
            expect(durableEntries).toHaveLength(chatExternalRunsPerProcessMaximum);
            expect(
                durableEntries.some(
                    ({ run }) => run.providerRunId === "external-capacity-run-0"
                )
            ).toBeFalse();
            expect(
                durableEntries.some(
                    ({ run }) =>
                        run.providerRunId ===
                        `external-capacity-run-${chatExternalRunsPerProcessMaximum}`
                )
            ).toBeTrue();
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("reacquires a remembered empty chat session during backend recovery", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const firstProvider = providerHarness();
        const firstService = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: firstProvider.provider,
            repository,
            subscriptionIdleMilliseconds: 100,
        });
        try {
            await firstService.runtime(runtimeInput());
            await firstService.dispose();
            expect(repository.listKnownSessionKeys()).toEqual(["agent:main:main"]);

            let historyCalls = 0;
            const restartedProvider = providerHarness({
                history: async () => {
                    historyCalls += 1;
                    return { hasMore: false, messages: [] };
                },
            });
            const restartedService = createChatService({
                attachmentConsumer: {
                    reserve: async () => {
                        throw new Error(
                            "Attachment reservation is not used by this test"
                        );
                    },
                },
                attachmentPreparer: inertAttachmentPreparer(),
                nowMs: () => clock,
                provider: restartedProvider.provider,
                repository,
                subscriptionIdleMilliseconds: 100,
            });
            try {
                await restartedService.recover();
                expect(restartedProvider.requests).toHaveLength(1);
                expect(restartedProvider.requests[0]).toMatchObject({
                    runWatermarks: [],
                    sessionKey: "agent:main:main",
                });
                expect(historyCalls).toBe(0);
                clock = 1200;
                expect(await restartedService.sweepSubscriptions()).toBe(0);
                expect(restartedProvider.closeCount()).toBe(0);
            } finally {
                await restartedService.dispose();
            }
        } finally {
            await firstService.dispose();
            database.sqlite.close(true);
        }
    });

    test("normalizes partially overlapping provider snapshots before persistence", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            const base = {
                providerRunId: "overlapping-provider-run",
                sessionKey: "agent:main:main",
                stream: "assistant" as const,
                streamId: "assistant",
            };
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 1,
                receivedAtMs: 1001,
                text: "Fikset og",
            });
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 2,
                receivedAtMs: 1002,
                text: "ikset og aktivt",
            });
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 3,
                receivedAtMs: 1003,
                text: "aktivt:\n\nGateway-hotfixen er lastet.",
            });

            const runtime = await service.runtime(runtimeInput());
            expect(runtime.externalRuns[0]?.text).toBe(
                "Fikset og aktivt:\n\nGateway-hotfixen er lastet."
            );
            expect(
                runtime.externalRuns[0]?.parts
                    ?.filter((part) => part.kind === "assistant")
                    .map((part) => part.text)
                    .join("")
            ).toBe("Fikset og aktivt:\n\nGateway-hotfixen er lastet.");
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("keeps cumulative Codex streams ordered across noops and tool boundaries", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            await service.runtime(runtimeInput());
            const subscription = provider.requests[0]!;
            const base = {
                providerRunId: "codex-ordered-run",
                sessionKey: "agent:main:main",
            } as const;
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 1,
                receivedAtMs: 1001,
                stream: "thinking",
                streamId: "agent:reasoning",
                text: "Checking workspace.",
            });
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 2,
                receivedAtMs: 1002,
                segmentId: "agent:preamble:preamble-1",
                stream: "thinking",
                streamId: "agent:preamble",
                text: "Preparing command.",
            });
            await subscription.onEvent({
                ...base,
                kind: "noop",
                providerSequence: 3,
                reason: "ignored",
                receivedAtMs: 1003,
            });
            await subscription.onEvent({
                ...base,
                callId: "command-1",
                input: '{"cmd":"pwd"}',
                isError: false,
                kind: "tool",
                name: "bash",
                phase: "started",
                providerSequence: 4,
                receivedAtMs: 1004,
            });
            await subscription.onEvent({
                ...base,
                callId: "command-1",
                isError: false,
                kind: "tool",
                name: "bash",
                output: "/workspace",
                phase: "succeeded",
                providerSequence: 5,
                receivedAtMs: 1005,
            });
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 6,
                receivedAtMs: 1006,
                stream: "thinking",
                streamId: "agent:reasoning",
                text: "Checking workspace. Verifying output.",
            });
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 7,
                receivedAtMs: 1007,
                stream: "assistant",
                streamId: "assistant",
                text: "Before tool.",
            });
            await subscription.onEvent({
                ...base,
                callId: "command-2",
                input: '{"cmd":"bun test"}',
                isError: false,
                kind: "tool",
                name: "bash",
                phase: "started",
                providerSequence: 8,
                receivedAtMs: 1008,
            });
            await subscription.onEvent({
                ...base,
                callId: "command-2",
                isError: false,
                kind: "tool",
                name: "bash",
                output: "1 pass",
                phase: "succeeded",
                providerSequence: 9,
                receivedAtMs: 1009,
            });
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 10,
                receivedAtMs: 1010,
                stream: "assistant",
                streamId: "assistant",
                text: "Before tool. After tool.",
            });

            const runtime = await service.runtime(runtimeInput());
            expect(runtime.externalRuns[0]).toMatchObject({
                hasUnprojectedActivity: false,
                projectionTruncated: false,
            });
            expect(runtime.externalRuns[0]?.parts).toEqual([
                {
                    kind: "thinking",
                    occurredAtMs: 1001,
                    segmentId: "codex-ordered-run:1",
                    sequence: 1,
                    streamId: "agent:reasoning",
                    text: "Checking workspace.",
                },
                {
                    kind: "thinking",
                    occurredAtMs: 1002,
                    segmentId: "agent:preamble:preamble-1",
                    sequence: 2,
                    streamId: "agent:preamble",
                    text: "Preparing command.",
                },
                {
                    callId: "command-1",
                    input: '{"cmd":"pwd"}',
                    isError: false,
                    kind: "tool",
                    name: "bash",
                    occurredAtMs: 1004,
                    output: "/workspace",
                    phase: "succeeded",
                    sequence: 3,
                },
                {
                    kind: "thinking",
                    occurredAtMs: 1006,
                    segmentId: "codex-ordered-run:6",
                    sequence: 4,
                    streamId: "agent:reasoning",
                    text: " Verifying output.",
                },
                {
                    kind: "assistant",
                    occurredAtMs: 1007,
                    segmentId: "codex-ordered-run:7",
                    sequence: 5,
                    streamId: "assistant",
                    text: "Before tool.",
                },
                {
                    callId: "command-2",
                    input: '{"cmd":"bun test"}',
                    isError: false,
                    kind: "tool",
                    name: "bash",
                    occurredAtMs: 1008,
                    output: "1 pass",
                    phase: "succeeded",
                    sequence: 6,
                },
                {
                    kind: "assistant",
                    occurredAtMs: 1010,
                    segmentId: "codex-ordered-run:10",
                    sequence: 7,
                    streamId: "assistant",
                    text: " After tool.",
                },
            ]);

            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 11,
                receivedAtMs: 1011,
                segmentId: "agent:preamble:preamble-1",
                stream: "thinking",
                streamId: "agent:preamble",
                text: "Preparing command. Ready.",
            });
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "merge",
                providerSequence: 12,
                receivedAtMs: 1012,
                segmentId: "agent:preamble:preamble-2",
                stream: "thinking",
                streamId: "agent:preamble",
                text: "Preparing command. Ready.",
            });
            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "replace",
                providerSequence: 13,
                receivedAtMs: 1013,
                stream: "assistant",
                streamId: "assistant",
                text: "Authoritative replacement.",
            });

            const replacedRuntime = await service.runtime(runtimeInput());
            const replaced = replacedRuntime.externalRuns[0]!;
            expect(
                replaced.parts?.filter(
                    (part) =>
                        part.kind === "thinking" && part.streamId === "agent:preamble"
                )
            ).toEqual([
                {
                    kind: "thinking",
                    occurredAtMs: 1002,
                    segmentId: "agent:preamble:preamble-1",
                    sequence: 2,
                    streamId: "agent:preamble",
                    text: "Preparing command. Ready.",
                },
                {
                    kind: "thinking",
                    occurredAtMs: 1012,
                    segmentId: "agent:preamble:preamble-2",
                    sequence: 8,
                    streamId: "agent:preamble",
                    text: "Preparing command. Ready.",
                },
            ]);
            expect(replaced.parts?.filter((part) => part.kind === "assistant")).toEqual([
                {
                    kind: "assistant",
                    occurredAtMs: 1013,
                    segmentId: "codex-ordered-run:13",
                    sequence: 9,
                    streamId: "assistant",
                    text: "Authoritative replacement.",
                },
            ]);
            expect(replaced.streamResets).toEqual([
                {
                    resetId: "codex-ordered-run:13",
                    streamId: "assistant",
                },
            ]);
            expect(replaced.parts?.filter((part) => part.kind === "tool")).toHaveLength(
                2
            );

            await subscription.onEvent({
                ...base,
                kind: "delta",
                mode: "replace",
                providerSequence: 14,
                receivedAtMs: 1014,
                stream: "thinking",
                streamId: "agent:reasoning",
                text: "Replacement reasoning.",
            });
            const reasoningReplacementRuntime = await service.runtime(runtimeInput());
            const reasoningReplaced = reasoningReplacementRuntime.externalRuns[0]!;
            expect(
                reasoningReplaced.parts?.filter(
                    (part) =>
                        part.kind === "thinking" && part.streamId === "agent:reasoning"
                )
            ).toEqual([
                {
                    kind: "thinking",
                    occurredAtMs: 1014,
                    segmentId: "codex-ordered-run:14",
                    sequence: 10,
                    streamId: "agent:reasoning",
                    text: "Replacement reasoning.",
                },
            ]);
            expect(reasoningReplaced.streamResets).toEqual([
                {
                    resetId: "codex-ordered-run:13",
                    streamId: "assistant",
                },
                {
                    resetId: "codex-ordered-run:14",
                    streamId: "agent:reasoning",
                },
            ]);

            await subscription.onEvent({
                ...base,
                kind: "compaction",
                phase: "active",
                providerSequence: 15,
                receivedAtMs: 1015,
            });
            let compactionRuntime = await service.runtime(runtimeInput());
            let compaction = compactionRuntime.externalRuns[0]!.parts?.find(
                (part) => part.kind === "item" && part.type === "compaction"
            );
            expect(compaction).toEqual({
                id: "compaction:codex-ordered-run",
                kind: "item",
                occurredAtMs: 1015,
                sequence: 11,
                text: "Compacting context",
                type: "compaction",
            });

            await subscription.onEvent({
                ...base,
                kind: "compaction",
                phase: "active",
                providerSequence: 16,
                receivedAtMs: 1016,
            });
            compactionRuntime = await service.runtime(runtimeInput());
            compaction = compactionRuntime.externalRuns[0]!.parts?.find(
                (part) => part.kind === "item" && part.type === "compaction"
            );
            expect(compaction).toMatchObject({
                occurredAtMs: 1015,
                sequence: 11,
                text: "Compacting context",
            });

            await subscription.onEvent({
                ...base,
                kind: "compaction",
                phase: "complete",
                providerSequence: 17,
                receivedAtMs: 1017,
            });
            compactionRuntime = await service.runtime(runtimeInput());
            compaction = compactionRuntime.externalRuns[0]!.parts?.find(
                (part) => part.kind === "item" && part.type === "compaction"
            );
            expect(compaction).toMatchObject({
                occurredAtMs: 1015,
                sequence: 11,
                text: "Context compacted",
            });

            await subscription.onEvent({
                ...base,
                kind: "compaction",
                phase: "inactive",
                providerSequence: 18,
                receivedAtMs: 1018,
            });
            compactionRuntime = await service.runtime(runtimeInput());
            expect(
                compactionRuntime.externalRuns[0]!.parts?.find(
                    (part) => part.kind === "item" && part.type === "compaction"
                )
            ).toBeUndefined();
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("coalesces a hundred local and external noops into bounded exact ranges", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 3000
        );
        const scheduler = schedulerHarness();
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            coalescerScheduler: scheduler.scheduler,
            nowMs: () => 3000,
            provider: provider.provider,
            repository,
        });
        const runtimeMarkerCount = (): number =>
            database.orm
                .select()
                .from(realtimeEvents)
                .where(eq(realtimeEvents.topic, "chat.runtime"))
                .all().length;
        try {
            await service.send(sendInput(), actor);
            const subscription = provider.requests[0]!;
            const rowsBefore = database.orm
                .select()
                .from(chatRunEvents)
                .where(eq(chatRunEvents.chatRunId, runId))
                .all().length;
            const markersBefore = runtimeMarkerCount();

            for (
                let providerSequence = 1;
                providerSequence <= 100;
                providerSequence += 1
            ) {
                await subscription.onEvent({
                    kind: "noop",
                    providerRunId: "provider-run",
                    providerSequence,
                    reason: "ignored",
                    receivedAtMs: 1000 + providerSequence,
                    sessionKey: "agent:main:main",
                });
                await subscription.onEvent({
                    kind: "noop",
                    providerRunId: "external-noop-run",
                    providerSequence,
                    reason: "ignored",
                    receivedAtMs: 2000 + providerSequence,
                    sessionKey: "agent:main:main",
                });
            }
            await subscription.onEvent({
                kind: "status",
                phase: "starting-model",
                providerRunId: "provider-run",
                providerSequence: 101,
                receivedAtMs: 1101,
                sessionKey: "agent:main:main",
            });
            await subscription.onEvent({
                kind: "status",
                phase: "starting-model",
                providerRunId: "external-noop-run",
                providerSequence: 101,
                receivedAtMs: 2101,
                sessionKey: "agent:main:main",
            });

            const rows = database.orm
                .select()
                .from(chatRunEvents)
                .where(eq(chatRunEvents.chatRunId, runId))
                .all();
            expect(rows).toHaveLength(rowsBefore + 2);
            expect(rows.find(({ kind }) => kind === "provider-noop")).toMatchObject({
                providerSequenceEnd: 100,
                providerSequenceStart: 1,
            });
            expect(repository.listProviderRunWatermarks("agent:main:main")).toEqual([
                {
                    lastProviderSequence: 101,
                    providerRunId: "external-noop-run",
                },
                {
                    lastProviderSequence: 101,
                    providerRunId: "provider-run",
                },
            ]);
            expect(runtimeMarkerCount()).toBe(markersBefore + 2);
            expect(scheduler.entries).toEqual([]);
            const noopRuntime = await service.runtime(runtimeInput());
            expect(
                noopRuntime.externalRuns.find(
                    ({ providerRunId }) => providerRunId === "external-noop-run"
                )
            ).toMatchObject({ providerRunId: "external-noop-run" });
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("settles the reconciliation deadline, releases capacity, and prunes in bounded sweeps", async () => {
        const database = await openFreshMigratedDatabase();
        let clock = 1000;
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => clock
        );
        const scheduler = schedulerHarness();
        let commits = 0;
        let releases = 0;
        const provider = providerHarness({
            history: async () => ({ hasMore: false, messages: [] }),
            send: async () => {
                throw new ChatProviderUnknownOutcomeError();
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => ({
                    attachments: [],
                    commit: async () => {
                        commits += 1;
                    },
                    release: async () => {
                        releases += 1;
                    },
                }),
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: provider.provider,
            recoveryScheduler: scheduler.scheduler,
            repository,
            subscriptionMaximum: 1,
        });
        try {
            await captureFailure(() =>
                service.send(sendInput({ attachmentTicketId: ticketId }), actor)
            );
            await flushAsync();
            expect(scheduler.entries).toHaveLength(1);
            clock = 1000 + 24 * 60 * 60 * 1000;
            const deadline = scheduler.entries[0]!;
            scheduler.entries.splice(0, 1);
            deadline.callback();
            await flushAsync();

            expect(repository.findRun(runId)?.state).toBe("unresolved");
            expect(commits).toBe(1);
            expect(releases).toBe(0);
            expect(provider.closeCount()).toBe(1);
            await service.runtime(runtimeInput("agent:main:other"));

            expect(
                await service.sweepRetention(new Date(clock + 24 * 60 * 60 * 1000))
            ).toBe(1);
            expect(repository.findRun(runId)).toBeUndefined();

            const activeId = "019fe5a1-6cb9-7e51-ad2a-bf1f69861219";
            await repository.admit(
                sendInput({
                    clientRunId: activeId,
                    idempotencyKey: "B".repeat(32),
                    sessionKey: "agent:main:other",
                }),
                actor
            );
            expect(
                await service.sweepRetention(new Date(clock + 100 * 24 * 60 * 60 * 1000))
            ).toBe(0);
            expect(repository.findRun(activeId)?.state).toBe("admitted");
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("settles an overdue recovered dispatch without contacting history", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1000
        );
        await repository.admit(sendInput(), actor);
        await repository.beginDispatch(runId, new Date(1000));
        await repository.markOutcomeUnknown(runId, new Date(1000));
        let historyCalls = 0;
        const provider = providerHarness({
            history: async () => {
                historyCalls += 1;
                return { hasMore: false, messages: [] };
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => 1000 + 24 * 60 * 60 * 1000,
            provider: provider.provider,
            repository,
        });
        try {
            await service.recover();
            expect(repository.findRun(runId)?.state).toBe("unresolved");
            expect(historyCalls).toBe(0);
            expect(provider.closeCount()).toBe(0);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("uses bounded provider truth to preserve or retire a restarting transcript", async () => {
        for (const represented of [true, false]) {
            const database = await openFreshMigratedDatabase();
            const repository = createChatRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission,
                "main",
                () => 1000
            );
            await repository.admit(sendInput(), actor);
            await repository.beginDispatch(runId, new Date(1050));
            await repository.markTranscriptTransportBoundary(1100);
            const lifecycle = createChatTranscriptLifecycleCoordinator(repository);
            const scheduler = schedulerHarness();
            const provider = providerHarness({
                history: async () => ({
                    hasMore: false,
                    ...(represented
                        ? {
                              inFlightRun: {
                                  runId: "A".repeat(32),
                                  text: "still running",
                              },
                          }
                        : {}),
                    messages: [],
                    sessionId: "provider-session",
                }),
            });
            const service = createChatService({
                attachmentConsumer: {
                    reserve: async () => {
                        throw new Error(
                            "Attachment reservation is not used by this test"
                        );
                    },
                },
                attachmentPreparer: inertAttachmentPreparer(),
                nowMs: () => 1200,
                provider: provider.provider,
                recoveryScheduler: scheduler.scheduler,
                repository,
                transcriptLifecycle: lifecycle,
            });
            try {
                await service.recover();
                expect(repository.readTranscriptState("agent:main:main")).toMatchObject({
                    currentGeneration: represented ? 1 : 2,
                    status: "ready",
                });
                if (represented) expect(repository.findRun(runId)).toBeDefined();
                else expect(repository.findRun(runId)).toBeUndefined();
            } finally {
                await service.dispose();
                database.sqlite.close(true);
            }
        }
    });

    test("caps one retention tick at four fixed-size batches", async () => {
        const database = await openFreshMigratedDatabase();
        const durable = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        let calls = 0;
        const repository: ChatRepository = {
            ...durable,
            pruneExpired: async (_at, limit) => {
                calls += 1;
                expect(limit).toBe(100);
                return 100;
            },
        };
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            expect(await service.sweepRetention()).toBe(400);
            expect(calls).toBe(4);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("bounds companion asks per session and process and releases every settlement", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const gates = new Map<
            string,
            ReturnType<typeof deferred<{ answer: string; timestampMs: number }>>
        >();
        const provider = providerHarness({
            companionAsk: async (input, signal) => {
                switch (input.question) {
                    case "definitive": {
                        throw new ChatProviderUnavailableError();
                    }
                    case "busy": {
                        throw new ChatProviderCapacityError();
                    }
                    case "unknown": {
                        throw new ChatProviderUnknownOutcomeError();
                    }
                    case "aborted": {
                        if (signal?.aborted === true) {
                            throw new DOMException("private abort detail", "AbortError");
                        }
                        break;
                    }
                    case "timeout": {
                        throw new Error("private timeout detail");
                    }
                }
                const gate = gates.get(input.sessionKey);
                return gate === undefined
                    ? { answer: "answer", timestampMs: 1000 }
                    : gate.promise;
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            const pending: Promise<unknown>[] = [];
            for (let index = 0; index < chatCompanionAskProcessMaximum; index += 1) {
                const key = `agent:main:companion-${index}`;
                gates.set(key, deferred());
                pending.push(
                    service.companionAsk(
                        {
                            question: "hold",
                            sessionKey: key,
                        },
                        { id: `actor-${index}`, kind: "user" }
                    )
                );
            }
            const sameSession = (await captureFailure(() =>
                service.companionAsk(
                    {
                        question: "duplicate",
                        sessionKey: "agent:main:companion-0",
                    },
                    { id: "duplicate-actor", kind: "user" }
                )
            )) as ChatServiceError;
            expect(sameSession).toBeInstanceOf(ChatServiceError);
            expect(sameSession.reason).toBe("capacity");
            const seventh = (await captureFailure(() =>
                service.companionAsk(
                    {
                        question: "seventh",
                        sessionKey: "agent:main:companion-6",
                    },
                    { id: "actor-6", kind: "user" }
                )
            )) as ChatServiceError;
            expect(seventh).toBeInstanceOf(ChatServiceError);
            expect(seventh.reason).toBe("capacity");

            for (const gate of gates.values()) {
                gate.resolve({ answer: "answer", timestampMs: 1000 });
            }
            await Promise.all(pending);

            for (const question of [
                "definitive",
                "busy",
                "unknown",
                "aborted",
                "timeout",
            ] as const) {
                const controller = new AbortController();
                if (question === "aborted") controller.abort();
                const settlementActor = {
                    id: `settlement-${question}`,
                    kind: "user" as const,
                };
                const failure = (await captureFailure(() =>
                    service.companionAsk(
                        { question, sessionKey: "agent:main:settlements" },
                        settlementActor,
                        controller.signal
                    )
                )) as ChatServiceError;
                expect(failure).toBeInstanceOf(ChatServiceError);
                let expectedReason: ChatServiceError["reason"] = "provider-unavailable";
                if (question === "unknown") expectedReason = "unknown-outcome";
                if (question === "busy") expectedReason = "capacity";
                expect(failure.reason).toBe(expectedReason);
                expect(
                    await service.companionAsk(
                        {
                            question: "released",
                            sessionKey: "agent:main:settlements",
                        },
                        settlementActor
                    )
                ).toMatchObject({ answer: "answer" });
            }
        } finally {
            for (const gate of gates.values()) {
                gate.reject(new Error("test cleanup"));
            }
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("bounds companion asks to four attempts per actor in a rolling minute", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        let clock = 1000;
        let dispatches = 0;
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            nowMs: () => clock,
            provider: providerHarness({
                companionAsk: async () => {
                    dispatches += 1;
                    return { answer: "answer", timestampMs: clock };
                },
            }).provider,
            repository,
        });
        const limitedActor = { id: "limited", kind: "user" as const };
        try {
            for (let index = 0; index < chatCompanionAskActorWindowMaximum; index += 1) {
                await service.companionAsk(
                    {
                        question: `attempt-${index}`,
                        sessionKey: "agent:main:rate",
                    },
                    limitedActor
                );
            }
            const limited = (await captureFailure(() =>
                service.companionAsk(
                    {
                        question: "limited",
                        sessionKey: "agent:main:rate",
                    },
                    limitedActor
                )
            )) as ChatServiceError;
            expect(limited).toBeInstanceOf(ChatServiceError);
            expect(limited.reason).toBe("capacity");
            expect(dispatches).toBe(chatCompanionAskActorWindowMaximum);

            await service.companionAsk(
                {
                    question: "independent actor",
                    sessionKey: "agent:main:rate",
                },
                { id: "independent", kind: "automation" }
            );
            clock += chatCompanionAskRateWindowMilliseconds;
            await service.companionAsk(
                {
                    question: "window elapsed",
                    sessionKey: "agent:main:rate",
                },
                limitedActor
            );
            expect(dispatches).toBe(chatCompanionAskActorWindowMaximum + 2);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("dispatches one reset and tombstones the superseded session ask", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const firstAsk = deferred<{ answer: string; timestampMs: number }>();
        const secondAsk = deferred<{ answer: string; timestampMs: number }>();
        const reset = deferred<{ reset: true }>();
        let askCalls = 0;
        let resetCalls = 0;
        const provider = providerHarness({
            companionAsk: async () => {
                askCalls += 1;
                return askCalls === 1 ? firstAsk.promise : secondAsk.promise;
            },
            companionReset: async () => {
                resetCalls += 1;
                return reset.promise;
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            const asking = service.companionAsk(
                {
                    question: "hold",
                    sessionKey: "agent:main:serialized",
                },
                actor
            );
            const firstReset = service.companionReset({
                sessionKey: "agent:main:serialized",
            });
            const duplicateReset = service.companionReset({
                sessionKey: "agent:main:serialized",
            });
            expect(duplicateReset).toBe(firstReset);
            expect(resetCalls).toBe(1);
            expect(
                (
                    (await captureFailure(() =>
                        service.companionAsk(
                            {
                                question: "racing",
                                sessionKey: "agent:main:serialized",
                            },
                            actor
                        )
                    )) as ChatServiceError
                ).reason
            ).toBe("capacity");

            reset.resolve({ reset: true });
            expect(firstReset).resolves.toEqual({ reset: true });
            expect(duplicateReset).resolves.toEqual({ reset: true });
            expect(resetCalls).toBe(1);
            const replacement = service.companionAsk(
                {
                    question: "replacement",
                    sessionKey: "agent:main:serialized",
                },
                actor
            );
            expect(askCalls).toBe(2);
            firstAsk.resolve({ answer: "aborted", timestampMs: 1000 });
            secondAsk.resolve({ answer: "replacement", timestampMs: 1001 });
            expect(
                ((await captureFailure(() => asking)) as ChatServiceError).reason
            ).toBe("conflict");
            expect(replacement).resolves.toMatchObject({
                answer: "replacement",
            });
        } finally {
            firstAsk.reject(new Error("test cleanup"));
            secondAsk.reject(new Error("test cleanup"));
            reset.reject(new Error("test cleanup"));
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("keeps an active companion ask valid after definitive and unknown reset failures", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const ask = deferred<{ answer: string; timestampMs: number }>();
        let resetAttempt = 0;
        const provider = providerHarness({
            companionAsk: async () => ask.promise,
            companionReset: async () => {
                resetAttempt += 1;
                if (resetAttempt === 1) throw new ChatProviderUnavailableError();
                throw new ChatProviderUnknownOutcomeError();
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
        });
        try {
            const activeAsk = service.companionAsk(
                { question: "hold", sessionKey: "agent:main:reset-failure" },
                actor
            );
            for (const reason of ["provider-unavailable", "unknown-outcome"] as const) {
                const failure = (await captureFailure(() =>
                    service.companionReset({
                        sessionKey: "agent:main:reset-failure",
                    })
                )) as ChatServiceError;
                expect(failure).toBeInstanceOf(ChatServiceError);
                expect(failure.reason).toBe(reason);
                await flushAsync();
            }

            ask.resolve({ answer: "still valid", timestampMs: 1200 });
            expect(activeAsk).resolves.toMatchObject({ answer: "still valid" });
        } finally {
            ask.reject(new Error("test cleanup"));
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("rejects invalid read input before subscription and normalizes lease capacity", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const provider = providerHarness();
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
            subscriptionMaximum: 1,
        });
        try {
            for (const operation of [
                () => service.history({ sessionKey: "" } as never),
                () =>
                    service.getMessage({ messageId: "", sessionKey: "agent:main:main" }),
                () =>
                    service.runtime({
                        afterCursor: "not-a-cursor",
                        sessionKey: "agent:main:main",
                    } as never),
            ]) {
                const failure = (await captureFailure(operation)) as ChatServiceError;
                expect(failure).toBeInstanceOf(ChatServiceError);
                expect(failure.reason).toBe("invalid-input");
            }
            expect(provider.requests).toHaveLength(0);

            await service.runtime(runtimeInput("agent:main:first"));
            await provider.requests[0]!.onEvent({
                kind: "status",
                phase: "starting-model",
                providerRunId: "capacity-pinned-run",
                providerSequence: 1,
                receivedAtMs: 1000,
                sessionKey: "agent:main:first",
            });
            const capacity = (await captureFailure(() =>
                service.runtime(runtimeInput("agent:main:second"))
            )) as ChatServiceError;
            expect(capacity).toBeInstanceOf(ChatServiceError);
            expect(capacity.reason).toBe("capacity");
            expect(provider.requests).toHaveLength(1);
        } finally {
            await service.dispose();
            database.sqlite.close(true);
        }
    });

    test("normalizes attachment port validation, capacity, and disposal failures", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const validInput = {
            files: [{ fileName: "note.txt", mimeType: "text/plain", sizeBytes: 1 }],
            idempotencyKey: "A".repeat(32),
            sessionKey: "agent:main:main",
        };
        for (const [portReason, serviceReason] of [
            ["invalid", "invalid-input"],
            ["capacity", "capacity"],
            ["unavailable", "provider-unavailable"],
        ] as const) {
            let prepareCalls = 0;
            const service = createChatService({
                attachmentConsumer: {
                    reserve: async () => {
                        throw new Error(
                            "Attachment reservation is not used by this test"
                        );
                    },
                },
                attachmentPreparer: {
                    prepare: async () => {
                        prepareCalls += 1;
                        throw new ChatAttachmentTicketError(portReason);
                    },
                },
                provider: providerHarness().provider,
                repository,
            });
            try {
                const failure = (await captureFailure(() =>
                    service.prepareAttachmentTicket(validInput, actor.id)
                )) as ChatServiceError;
                expect(failure).toBeInstanceOf(ChatServiceError);
                expect(failure.reason).toBe(serviceReason);
                expect(prepareCalls).toBe(1);

                const malformed = (await captureFailure(() =>
                    service.prepareAttachmentTicket(
                        { ...validInput, files: [] },
                        actor.id
                    )
                )) as ChatServiceError;
                expect(malformed).toBeInstanceOf(ChatServiceError);
                expect(malformed.reason).toBe("invalid-input");
                expect(prepareCalls).toBe(1);
            } finally {
                await service.dispose();
            }
        }
        database.sqlite.close(true);
    });

    test("normalizes subscription, history, and provider conflicts at the service boundary", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        let page = 0;
        const provider = providerHarness({
            companionReset: async () => {
                throw new ChatProviderConflictError();
            },
            history: async () => {
                page += 1;
                return page === 1
                    ? {
                          hasMore: true,
                          messages: [],
                          nextOffset: 1,
                          sessionId: runId,
                      }
                    : {
                          hasMore: false,
                          messages: [],
                          sessionId: ticketId,
                      };
            },
        });
        const service = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: provider.provider,
            repository,
            subscriptionMaximum: 1,
        });
        try {
            await service.runtime(runtimeInput("agent:main:lease-one"));
            await provider.requests[0]!.onEvent({
                kind: "status",
                phase: "starting-model",
                providerRunId: "conflict-boundary-pinned-run",
                providerSequence: 1,
                receivedAtMs: 1000,
                sessionKey: "agent:main:lease-one",
            });
            const capacity = (await captureFailure(() =>
                service.runtime(runtimeInput("agent:main:lease-two"))
            )) as ChatServiceError;
            expect(capacity).toBeInstanceOf(ChatServiceError);
            expect(capacity.reason).toBe("capacity");

            const historyFailure = (await captureFailure(() =>
                service.history({
                    cursor: "0",
                    limit: 2,
                    sessionKey: "agent:main:lease-one",
                })
            )) as ChatServiceError;
            expect(historyFailure).toBeInstanceOf(ChatServiceError);
            expect(historyFailure.reason).toBe("provider-unavailable");

            const conflict = (await captureFailure(() =>
                service.companionReset({ sessionKey: "agent:main:lease-one" })
            )) as ChatServiceError;
            expect(conflict).toBeInstanceOf(ChatServiceError);
            expect(conflict.reason).toBe("conflict");
        } finally {
            await service.dispose();
        }

        const unavailable = createChatService({
            attachmentConsumer: {
                reserve: async () => {
                    throw new Error("Attachment reservation is not used by this test");
                },
            },
            attachmentPreparer: inertAttachmentPreparer(),
            provider: providerHarness({
                subscribeChat: async () => {
                    throw new Error("private subscription detail");
                },
            }).provider,
            repository,
        });
        try {
            const failure = (await captureFailure(() =>
                unavailable.runtime(runtimeInput("agent:main:unavailable"))
            )) as ChatServiceError;
            expect(failure).toBeInstanceOf(ChatServiceError);
            expect(failure.reason).toBe("provider-unavailable");
        } finally {
            await unavailable.dispose();
            database.sqlite.close(true);
        }
    });
});
