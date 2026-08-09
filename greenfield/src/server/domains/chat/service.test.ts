/* oxlint-disable typescript/require-await -- Async test doubles mirror production promise ports. */
import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import type { ChatSendInput } from "../../../contracts/chat.ts";
import {
    chatDeltaCoalescingMilliseconds,
    chatRuntimeResponseMaximumBytes,
} from "../../../contracts/chatModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    type ChatAttachmentTicketReservation,
    ChatAttachmentTicketError,
    type ChatEventSubscriptionRequest,
    type ChatProvider,
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

    test("bounds external projections and signals history only for terminal activity", async () => {
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
            for (let runIndex = 0; runIndex < 9; runIndex += 1) {
                for (let sequence = 1; sequence <= 4; sequence += 1) {
                    await subscription.onEvent({
                        kind: "delta",
                        mode: "append",
                        providerRunId: `external-${runIndex}`,
                        providerSequence: sequence,
                        receivedAtMs: 1000 + runIndex * 10 + sequence,
                        sessionKey: "agent:main:main",
                        stream: "assistant",
                        text: "x".repeat(64 * 1024),
                    });
                }
            }
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
            expect(utf8ByteLength(JSON.stringify(runtime))).toBeLessThanOrEqual(
                chatRuntimeResponseMaximumBytes
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
            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "chat.history"))
                    .all()
            ).toHaveLength(1);

            const projectedRuntime = await service.runtime(runtimeInput());
            for (const external of projectedRuntime.externalRuns) {
                await subscription.onEvent({
                    kind: "terminal",
                    outcome: "completed",
                    providerRunId: external.providerRunId,
                    providerSequence:
                        external.providerRunId === "external-late-baseline" ? 6 : 5,
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
            expect(cleaned.externalRuns).toEqual([]);
            expect(cleaned.externalRunsTruncated).toBeFalse();
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

    test("retires exact external finals and expires only unmatched interrupted projections", async () => {
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
            await subscription.onGap({
                expectedSequence: 2,
                providerRunId: "external-lost-terminal",
                receivedSequence: 3,
                sessionKey: "agent:main:main",
            });
            const interruptedRuntime = await service.runtime(runtimeInput());
            expect(interruptedRuntime.externalRuns[0]).toMatchObject({
                continuity: "interrupted",
                projectionTruncated: true,
                providerRunId: "external-lost-terminal",
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
            const reconciledRuntime = await service.runtime(runtimeInput());
            expect(reconciledRuntime.externalRuns).toEqual([]);
            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .where(eq(realtimeEvents.topic, "chat.history"))
                    .all()
            ).toHaveLength(historyBefore + 1);
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
                kind: "delta",
                mode: "append",
                providerRunId: "external-burst",
                providerSequence: 6,
                receivedAtMs: 1006,
                sessionKey: "agent:main:main",
                stream: "assistant",
                text: "!",
            });
            expect(scheduler.entries).toHaveLength(1);
            await subscription.onEvent({
                kind: "terminal",
                outcome: "completed",
                providerRunId: "external-burst",
                providerSequence: 7,
                receivedAtMs: 1007,
                sessionKey: "agent:main:main",
            });
            expect(scheduler.entries).toEqual([]);
            expect(topics()).toEqual([
                "chat.runtime",
                "chat.runtime",
                "chat.runtime",
                "chat.history",
                "chat.runtime",
            ]);
            const terminalRuntime = await service.runtime(runtimeInput());
            expect(terminalRuntime.externalRuns).toEqual([]);
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
            expect(provider.closeCount()).toBe(1);
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
