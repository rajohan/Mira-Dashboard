import { describe, expect, test } from "bun:test";

import {
    ChatProviderCapacityError,
    ChatProviderUnknownOutcomeError,
    ChatProviderUnavailableError,
} from "../../domains/chat/provider.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createPersistentGatewayChatProvider,
    type PersistentGatewayChatMediaReferenceRegistrar,
    type PersistentGatewayChatProviderTransport,
} from "./persistentGatewayChatProvider.ts";
import type {
    PersistentGatewayChatListener,
    PersistentGatewayDeliveredChatEvent,
} from "./persistentGatewayTransport.ts";
import {
    PersistentGatewayCapacityError,
    PersistentGatewayRequestError,
    persistentGatewaySessionCompanionBusyReason,
    PersistentGatewayUnknownOutcomeError,
} from "./persistentGatewayTransport.ts";

const sessionKey = "agent:main:main";
const attachmentId = "019fe633-9133-4ba0-8b80-809dd80dfb40";

interface RecordedRequest {
    readonly method: string;
    readonly parameters: Readonly<Record<string, unknown>>;
}

function isResponseQueue(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
}

function createHarness(responses: Readonly<Record<string, unknown>>): Readonly<{
    mediaReferences: PersistentGatewayChatMediaReferenceRegistrar;
    deliverChat: (event: PersistentGatewayDeliveredChatEvent) => Promise<void>;
    provider: ReturnType<typeof createPersistentGatewayChatProvider>;
    references: Array<
        Readonly<{ attachmentId: string; messageId: string; sessionKey: string }>
    >;
    requests: RecordedRequest[];
}> {
    const requests: RecordedRequest[] = [];
    const references: Array<
        Readonly<{ attachmentId: string; messageId: string; sessionKey: string }>
    > = [];
    const queues = new Map<string, unknown[]>(
        Object.entries(responses).map(([method, response]) => {
            const queue = isResponseQueue(response) ? [...response] : [response];
            return [method, queue];
        })
    );
    let chatListener: PersistentGatewayChatListener | undefined;
    const request = (
        method: string,
        parameters: Readonly<Record<string, unknown>>
    ): Promise<unknown> => {
        requests.push({ method, parameters });
        const queue = queues.get(method);
        if (queue === undefined || queue.length === 0) {
            throw new Error(`Missing fake response for ${method}`);
        }
        const response = queue.shift();
        return response instanceof Error
            ? Promise.reject(response)
            : Promise.resolve(response);
    };
    const transport = {
        requestAdmin: request,
        requestChatRead: request,
        requestChatReadMutation: request,
        requestChatWrite: request,
        subscribeChat: (
            _subscription: unknown,
            listener: PersistentGatewayChatListener
        ) => {
            chatListener = listener;
            return () => {
                if (chatListener === listener) chatListener = undefined;
            };
        },
    } as PersistentGatewayChatProviderTransport;
    const mediaReferences = {
        register: (
            reference: Readonly<{
                attachmentId: string;
                messageId: string;
                sessionKey: string;
            }>
        ) => {
            references.push(reference);
        },
    };
    return {
        deliverChat: async (event) => {
            await chatListener?.onEvent?.(event);
        },
        mediaReferences,
        provider: createPersistentGatewayChatProvider(transport, mediaReferences),
        references,
        requests,
    };
}

describe("persistent Gateway chat provider", () => {
    test("projects history into bounded local media and sanitized diagnostics", async () => {
        const harness = createHarness({
            "chat.history": {
                hasMore: false,
                inFlightRun: {
                    plan: {
                        steps: [
                            { status: "completed", text: "Inspect context" },
                            { status: "in_progress", text: "Answer safely" },
                        ],
                    },
                    runId: "provider-run-in-flight",
                    text: "Partial answer",
                },
                messages: [
                    {
                        content: [
                            {
                                secret: "must-never-cross-the-provider-boundary",
                                type: "provider_private_metadata",
                            },
                        ],
                        id: "message-unknown",
                        role: "assistant",
                    },
                    {
                        content: [
                            {
                                isError: true,
                                toolCallId: "tool-call-1",
                                toolName: "read",
                                type: "tool_result",
                            },
                        ],
                        id: "message-tool",
                        role: "tool",
                    },
                    {
                        content: [
                            {
                                attachment: {
                                    label: "diagram.png",
                                    mimeType: "image/png",
                                    sizeBytes: 42,
                                    url: `/api/chat/media/outgoing/${encodeURIComponent(
                                        sessionKey
                                    )}/${attachmentId.toUpperCase()}/full`,
                                },
                                type: "attachment",
                            },
                        ],
                        id: "message-media",
                        role: "assistant",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 3,
            maxChars: 512 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]?.content).toEqual({
            kind: "complete",
            parts: [
                {
                    id: "1",
                    kind: "control",
                    text: "Unsupported provider content.",
                },
            ],
        });
        expect(JSON.stringify(history)).not.toContain("must-never-cross");
        expect(history.messages[1]?.content).toEqual({
            kind: "complete",
            parts: [
                {
                    callId: "tool-call-1",
                    id: "1",
                    isError: true,
                    kind: "tool",
                    name: "read",
                    output: "Tool failed without a provider-visible result.",
                    phase: "failed",
                },
            ],
        });
        expect(history.messages[2]?.content).toEqual({
            kind: "complete",
            parts: [
                {
                    fileName: "diagram.png",
                    id: "1",
                    kind: "attachment",
                    mediaType: "image/png",
                    renderPolicy: "inline-image",
                    sizeBytes: 42,
                    url: `/api/chat/media/${attachmentId}?disposition=preview`,
                },
            ],
        });
        expect(harness.references).toEqual([
            { attachmentId, messageId: "message-media", sessionKey },
        ]);
        expect(history.inFlightRun).toEqual({
            plan: {
                steps: [
                    { status: "completed", text: "Inspect context" },
                    { status: "in_progress", text: "Answer safely" },
                ],
            },
            runId: "provider-run-in-flight",
            text: "Partial answer",
        });
    });

    test("rejects foreign managed-media origins and keeps active image content download-only", async () => {
        const svgAttachmentId = "019fe633-9133-4ba0-8b80-809dd80dfb41";
        const harness = createHarness({
            "chat.history": {
                hasMore: false,
                messages: [
                    {
                        content: [
                            {
                                attachment: {
                                    label: "active.svg",
                                    mimeType: "image/svg+xml",
                                    url: `/api/chat/media/outgoing/${encodeURIComponent(
                                        sessionKey
                                    )}/${svgAttachmentId}/full`,
                                },
                                type: "attachment",
                            },
                        ],
                        id: "message-svg",
                        role: "assistant",
                    },
                    {
                        content: [
                            {
                                attachment: {
                                    label: "foreign.png",
                                    mimeType: "image/png",
                                    url: `https://attacker.example.test/api/chat/media/outgoing/${encodeURIComponent(
                                        sessionKey
                                    )}/${attachmentId}/full`,
                                },
                                type: "attachment",
                            },
                        ],
                        id: "message-foreign",
                        role: "assistant",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 2,
            maxChars: 512 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]?.content).toEqual({
            kind: "complete",
            parts: [
                {
                    fileName: "active.svg",
                    id: "1",
                    kind: "attachment",
                    mediaType: "image/svg+xml",
                    renderPolicy: "download-only",
                    url: `/api/chat/media/${svgAttachmentId}?disposition=download`,
                },
            ],
        });
        expect(history.messages[1]?.content).toEqual({
            kind: "complete",
            parts: [
                {
                    id: "1",
                    kind: "control",
                    text: "Unsupported provider content.",
                },
            ],
        });
        expect(harness.references).toEqual([
            {
                attachmentId: svgAttachmentId,
                messageId: "message-svg",
                sessionKey,
            },
        ]);
    });

    test("surfaces companion ask post-dispatch uncertainty without a blind retry", async () => {
        const harness = createHarness({
            "sessions.companion.ask": new PersistentGatewayUnknownOutcomeError(),
        });

        expect(
            await captureFailure(() =>
                harness.provider.companionAsk({
                    question: "What changed?",
                    sessionKey,
                })
            )
        ).toBeInstanceOf(ChatProviderUnknownOutcomeError);
        expect(harness.requests).toEqual([
            {
                method: "sessions.companion.ask",
                parameters: { question: "What changed?", sessionKey },
            },
        ]);
    });

    test("maps only sanitized companion saturation outcomes to capacity", async () => {
        const harness = createHarness({
            "sessions.companion.ask": [
                new PersistentGatewayRequestError({
                    code: "UNAVAILABLE",
                    reason: persistentGatewaySessionCompanionBusyReason,
                    retryable: true,
                    retryAfterMs: 60_000,
                }),
                new PersistentGatewayCapacityError(),
            ],
        });

        for (const question of ["busy", "local admission"] as const) {
            const failure = await captureFailure(() =>
                harness.provider.companionAsk({ question, sessionKey })
            );
            expect(failure).toBeInstanceOf(ChatProviderCapacityError);
            expect(String(failure)).not.toContain("SESSION_COMPANION_BUSY");
            expect(String(failure)).not.toContain("UNAVAILABLE");
        }
    });

    test("rejects malformed in-flight history text and plan snapshots", async () => {
        const harness = createHarness({
            "chat.history": [
                {
                    inFlightRun: {
                        runId: "provider-run-1",
                        text: `invalid\0text`,
                    },
                    messages: [],
                    offset: 0,
                    sessionKey,
                },
                {
                    inFlightRun: {
                        plan: {
                            steps: [
                                { status: "in_progress", text: "First" },
                                { status: "in_progress", text: "Second" },
                            ],
                        },
                        runId: "provider-run-2",
                        text: "valid text",
                    },
                    messages: [],
                    offset: 0,
                    sessionKey,
                },
            ],
        });
        const request = {
            limit: 1,
            maxChars: 1024,
            offset: 0,
            sessionKey,
        };

        expect(
            await captureFailure(() => harness.provider.history(request))
        ).toBeInstanceOf(ChatProviderUnavailableError);
        expect(
            await captureFailure(() => harness.provider.history(request))
        ).toBeInstanceOf(ChatProviderUnavailableError);
    });

    test("omits an empty in-flight plan instead of projecting an active plan shell", async () => {
        const harness = createHarness({
            "chat.history": {
                inFlightRun: {
                    plan: { steps: [] },
                    runId: "provider-run-empty-plan",
                    text: "Working",
                },
                messages: [],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 1,
            maxChars: 1024,
            offset: 0,
            sessionKey,
        });
        expect(history.inFlightRun).toEqual({
            runId: "provider-run-empty-plan",
            text: "Working",
        });
    });

    test("rejects a history response larger than the exact requested page", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    { content: [{ text: "one", type: "text" }], id: "1", role: "user" },
                    { content: [{ text: "two", type: "text" }], id: "2", role: "user" },
                ],
                offset: 0,
                sessionKey,
            },
        });

        expect(
            await captureFailure(() =>
                harness.provider.history({
                    limit: 1,
                    maxChars: 1024,
                    offset: 0,
                    sessionKey,
                })
            )
        ).toBeInstanceOf(ChatProviderUnavailableError);
    });

    test("rejects an exact-message response whose projected identity differs", async () => {
        const harness = createHarness({
            "chat.message.get": {
                message: {
                    content: [{ text: "wrong row", type: "text" }],
                    id: "message-other",
                    role: "assistant",
                },
                ok: true,
            },
        });

        expect(
            await captureFailure(() =>
                harness.provider.getMessage({
                    maxChars: 16 * 1024,
                    messageId: "message-requested",
                    sessionKey,
                })
            )
        ).toBeInstanceOf(ChatProviderUnavailableError);
        expect(harness.references).toEqual([]);
        expect(harness.requests).toEqual([
            {
                method: "chat.message.get",
                parameters: {
                    maxChars: 16 * 1024,
                    messageId: "message-requested",
                    sessionKey,
                },
            },
        ]);
    });

    test("classifies canonical hydration byte overflow without masking malformed rows", async () => {
        const multibyte = "€".repeat(200_000);
        const harness = createHarness({
            "chat.message.get": [
                {
                    message: {
                        content: [
                            { text: multibyte, type: "text" },
                            { text: multibyte, type: "text" },
                        ],
                        id: "message-large",
                        role: "assistant",
                    },
                    ok: true,
                },
                {
                    message: {
                        content: [{ text: "malformed", type: "text" }],
                        id: "message-malformed",
                        role: "provider-private-role",
                    },
                    ok: true,
                },
            ],
        });

        expect(
            await harness.provider.getMessage({
                maxChars: 2_000_000,
                messageId: "message-large",
                sessionKey,
            })
        ).toEqual({ reason: "oversized", status: "unavailable" });
        expect(
            await captureFailure(() =>
                harness.provider.getMessage({
                    maxChars: 2_000_000,
                    messageId: "message-malformed",
                    sessionKey,
                })
            )
        ).toBeInstanceOf(ChatProviderUnavailableError);
    });

    test("does not invent model fast-mode or thinking-level capabilities", async () => {
        const harness = createHarness({
            "models.list": {
                models: [
                    {
                        id: "gpt-5.6",
                        name: "GPT 5.6",
                        provider: "openai",
                        reasoning: true,
                    },
                ],
            },
        });

        expect(
            await harness.provider.listModels({
                includeProviderCapabilities: true,
                view: "configured",
            })
        ).toEqual({
            models: [
                {
                    id: "openai/gpt-5.6",
                    label: "GPT 5.6",
                    provider: "openai",
                    supportsFastMode: false,
                    thinkingLevels: [],
                },
            ],
        });
    });

    test("returns only settings values read back from the Gateway", async () => {
        const harness = createHarness({
            "sessions.patch": {
                entry: {
                    fastMode: false,
                    sessionId: "session-1",
                    thinkingLevel: "medium",
                },
                key: sessionKey,
                ok: true,
                resolved: { model: "gpt-5.6", thinkingLevel: "high" },
            },
        });

        expect(
            await harness.provider.updateSessionSettings({
                expectedSessionId: "session-1",
                fastMode: true,
                model: "requested-model",
                sessionKey,
                thinkingLevel: "low",
            })
        ).toEqual({
            fastMode: false,
            model: "gpt-5.6",
            sessionId: "session-1",
            sessionKey,
            thinkingLevel: "high",
        });
    });

    test("requires an exact session generation readback for fenced settings", async () => {
        const harness = createHarness({
            "sessions.patch": [
                {
                    entry: { sessionId: "session-other" },
                    key: sessionKey,
                    ok: true,
                },
                { entry: {}, key: sessionKey, ok: true },
            ],
        });

        for (const fastMode of [true, false] as const) {
            expect(
                await captureFailure(() =>
                    harness.provider.updateSessionSettings({
                        expectedSessionId: "session-expected",
                        fastMode,
                        sessionKey,
                    })
                )
            ).toBeInstanceOf(ChatProviderUnknownOutcomeError);
        }
        expect(harness.requests).toEqual([
            {
                method: "sessions.patch",
                parameters: {
                    expectedSessionId: "session-expected",
                    fastMode: true,
                    key: sessionKey,
                },
            },
            {
                method: "sessions.patch",
                parameters: {
                    expectedSessionId: "session-expected",
                    fastMode: false,
                    key: sessionKey,
                },
            },
        ]);
    });

    test("validates exact run-scoped abort acknowledgements and terminal races", async () => {
        const providerRunId = "provider-run-1";
        const harness = createHarness({
            "chat.abort": [
                { aborted: false, ok: true, runIds: [] },
                { aborted: true, ok: true, runIds: ["different-run"] },
                { aborted: false, ok: true, runIds: [providerRunId] },
                { aborted: true, ok: true, runIds: [providerRunId] },
            ],
        });
        const request = { preserveSideRuns: false as const, providerRunId, sessionKey };

        expect(await harness.provider.abort(request)).toEqual({
            aborted: false,
            ok: true,
            runIds: [],
        });
        expect(
            await captureFailure(() => harness.provider.abort(request))
        ).toBeInstanceOf(ChatProviderUnknownOutcomeError);
        expect(
            await captureFailure(() => harness.provider.abort(request))
        ).toBeInstanceOf(ChatProviderUnknownOutcomeError);
        expect(await harness.provider.abort(request)).toEqual({
            aborted: true,
            ok: true,
            runIds: [providerRunId],
        });
    });

    test("classifies every malformed successful mutation acknowledgement as unknown", async () => {
        const harness = createHarness({
            "chat.send": { runId: "different-run", status: "started" },
            "sessions.companion.ask": { answer: "missing timestamp" },
            "sessions.companion.reset": { ok: false },
            "sessions.patch": {
                entry: {},
                key: "agent:main:other",
                ok: true,
            },
        });
        const failures = await Promise.all([
            captureFailure(() =>
                harness.provider.send({
                    attachments: [],
                    idempotencyKey: "A".repeat(32),
                    message: "hello",
                    sessionKey,
                })
            ),
            captureFailure(() =>
                harness.provider.updateSessionSettings({
                    fastMode: true,
                    sessionKey,
                })
            ),
            captureFailure(() =>
                harness.provider.companionAsk({
                    question: "What changed?",
                    sessionKey,
                })
            ),
            captureFailure(() => harness.provider.companionReset({ sessionKey })),
        ]);

        expect(
            failures.every(
                (failure) => failure instanceof ChatProviderUnknownOutcomeError
            )
        ).toBe(true);
    });

    test("maps an audited tool error phase to a consistent failed event", async () => {
        const harness = createHarness({});
        const projected: unknown[] = [];
        await harness.provider.subscribeChat({
            onEvent: (event) => {
                projected.push(event);
            },
            onGap: () => {},
            onReconciliationRequired: () => {},
            runWatermarks: [],
            sessionKey,
        });

        await harness.deliverChat({
            connectionGeneration: 1,
            frame: {
                event: "agent",
                payload: {
                    data: {
                        phase: "error",
                        toolCallId: "tool-call-1",
                        toolName: "read",
                    },
                    runId: "provider-run-1",
                    seq: 4,
                    sessionKey,
                    stream: "tool",
                    ts: 10,
                },
            },
            receivedAtMs: 20,
        });

        expect(projected).toEqual([
            {
                callId: "tool-call-1",
                isError: true,
                kind: "tool",
                name: "read",
                output: "Tool failed without a provider-visible result.",
                phase: "failed",
                providerRunId: "provider-run-1",
                providerSequence: 4,
                receivedAtMs: 20,
                sessionKey,
            },
        ]);
    });

    test("projects pinned shared-sequence assistant and chat events with overlap-safe modes", async () => {
        const harness = createHarness({});
        const projected: unknown[] = [];
        await harness.provider.subscribeChat({
            onEvent: (event) => {
                projected.push(event);
            },
            onGap: () => {},
            onReconciliationRequired: () => {},
            runWatermarks: [],
            sessionKey,
        });
        const deliver = async (
            frame: PersistentGatewayDeliveredChatEvent["frame"],
            receivedAtMs: number
        ): Promise<void> =>
            harness.deliverChat({ connectionGeneration: 1, frame, receivedAtMs });

        await deliver(
            {
                event: "agent",
                payload: {
                    data: { text: "Checking cancellation." },
                    runId: "cancelled-run",
                    seq: 1,
                    sessionKey,
                    stream: "assistant",
                    ts: 1,
                },
            },
            1
        );
        await deliver(
            {
                event: "chat",
                payload: {
                    deltaText: "Checking cancellation.",
                    runId: "cancelled-run",
                    seq: 2,
                    sessionKey,
                    state: "delta",
                },
            },
            2
        );
        await deliver(
            {
                event: "agent",
                payload: {
                    data: { delta: "Running the fixture tool." },
                    runId: "completed-run",
                    seq: 2,
                    sessionKey,
                    stream: "assistant",
                    ts: 2,
                },
            },
            3
        );
        await deliver(
            {
                event: "chat",
                payload: {
                    deltaText: "Fixture complete.",
                    runId: "completed-run",
                    seq: 5,
                    sessionKey,
                    state: "delta",
                },
            },
            4
        );
        await deliver(
            {
                event: "agent",
                payload: {
                    data: {},
                    runId: "ignored-run",
                    seq: 1,
                    sessionKey,
                    stream: "assistant",
                    ts: 5,
                },
            },
            5
        );

        expect(projected).toEqual([
            {
                kind: "delta",
                mode: "merge",
                providerRunId: "cancelled-run",
                providerSequence: 1,
                receivedAtMs: 1,
                sessionKey,
                stream: "assistant",
                text: "Checking cancellation.",
            },
            {
                kind: "delta",
                mode: "merge",
                providerRunId: "cancelled-run",
                providerSequence: 2,
                receivedAtMs: 2,
                sessionKey,
                stream: "assistant",
                text: "Checking cancellation.",
            },
            {
                kind: "delta",
                mode: "append",
                providerRunId: "completed-run",
                providerSequence: 2,
                receivedAtMs: 3,
                sessionKey,
                stream: "assistant",
                text: "Running the fixture tool.",
            },
            {
                kind: "delta",
                mode: "merge",
                providerRunId: "completed-run",
                providerSequence: 5,
                receivedAtMs: 4,
                sessionKey,
                stream: "assistant",
                text: "Fixture complete.",
            },
            {
                kind: "noop",
                providerRunId: "ignored-run",
                providerSequence: 1,
                reason: "ignored",
                receivedAtMs: 5,
                sessionKey,
            },
        ]);
    });

    test("merges repeated full thinking text while appending explicit thinking deltas", async () => {
        const harness = createHarness({});
        const projected: unknown[] = [];
        await harness.provider.subscribeChat({
            onEvent: (event) => {
                projected.push(event);
            },
            onGap: () => {},
            onReconciliationRequired: () => {},
            runWatermarks: [],
            sessionKey,
        });
        const deliver = async (
            data: Readonly<Record<string, unknown>>,
            seq: number
        ): Promise<void> =>
            harness.deliverChat({
                connectionGeneration: 1,
                frame: {
                    event: "agent",
                    payload: {
                        data,
                        runId: "thinking-run",
                        seq,
                        sessionKey,
                        stream: "thinking",
                        ts: seq,
                    },
                },
                receivedAtMs: seq,
            });

        await deliver({ text: "Inspecting" }, 1);
        await deliver({ text: "Inspecting context" }, 2);
        await deliver({ text: "Inspecting context" }, 3);
        await deliver({ delta: "." }, 4);
        await deliver({ replace: true, text: "Final thought" }, 5);

        expect(
            projected.map((event) => {
                const delta = event as { mode: string; text: string };
                return [delta.mode, delta.text];
            })
        ).toEqual([
            ["merge", "Inspecting"],
            ["merge", "Inspecting context"],
            ["merge", "Inspecting context"],
            ["append", "."],
            ["replace", "Final thought"],
        ]);
    });

    test("turns domain-invalid deltas into a reconciliation boundary without advancing events", async () => {
        const harness = createHarness({});
        const projected: unknown[] = [];
        const reconciliationReasons: string[] = [];
        await harness.provider.subscribeChat({
            onEvent: (event) => {
                projected.push(event);
            },
            onGap: () => {},
            onReconciliationRequired: (reason) => {
                reconciliationReasons.push(reason);
            },
            runWatermarks: [{ lastProviderSequence: 4, providerRunId: "oversized-run" }],
            sessionKey,
        });

        await harness.deliverChat({
            connectionGeneration: 1,
            frame: {
                event: "chat",
                payload: {
                    deltaText: "x".repeat(64 * 1024 + 1),
                    runId: "oversized-run",
                    seq: 5,
                    sessionKey,
                    state: "delta",
                },
            },
            receivedAtMs: 10,
        });
        await harness.deliverChat({
            connectionGeneration: 1,
            frame: {
                event: "chat",
                payload: {
                    deltaText: "must not cross the boundary",
                    runId: "oversized-run",
                    seq: 6,
                    sessionKey,
                    state: "delta",
                },
            },
            receivedAtMs: 11,
        });

        expect(projected).toEqual([]);
        expect(reconciliationReasons).toEqual(["backpressure"]);
    });

    test("maps terminal failures to allowlisted diagnostics and bounded stop reasons", async () => {
        const harness = createHarness({});
        const projected: unknown[] = [];
        await harness.provider.subscribeChat({
            onEvent: (event) => {
                projected.push(event);
            },
            onGap: () => {},
            onReconciliationRequired: () => {},
            runWatermarks: [],
            sessionKey,
        });
        const privateError = `provider-private\u0000${"x".repeat(3000)}`;

        await harness.deliverChat({
            connectionGeneration: 1,
            frame: {
                event: "chat",
                payload: {
                    errorKind: "rate_limit",
                    errorMessage: privateError,
                    runId: "failed-run",
                    seq: 3,
                    sessionKey,
                    state: "error",
                    stopReason: `private\u0007${"y".repeat(200)}`,
                },
            },
            receivedAtMs: 12,
        });

        expect(projected).toEqual([
            {
                errorCode: "rate_limit",
                errorMessage: "Chat provider rate limit exceeded",
                kind: "terminal",
                outcome: "error",
                providerRunId: "failed-run",
                providerSequence: 3,
                receivedAtMs: 12,
                sessionKey,
                stopReason: undefined,
            },
        ]);
        expect(JSON.stringify(projected)).not.toContain("provider-private");
    });
});
