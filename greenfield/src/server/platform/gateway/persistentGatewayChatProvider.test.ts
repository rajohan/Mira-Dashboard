import { describe, expect, test } from "bun:test";

import { chatHistoryResponseMaximumBytes } from "../../../contracts/chatModel.ts";
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
import { persistentGatewayChatHistoryMaximumChars } from "./persistentGatewayProtocol.ts";
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
    test("keeps Dashboard's response budget while bounding the Gateway history request", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [],
                offset: 0,
                sessionKey,
            },
        });

        expect(chatHistoryResponseMaximumBytes).toBeGreaterThan(
            persistentGatewayChatHistoryMaximumChars
        );

        await harness.provider.history({
            limit: 1,
            maxChars: chatHistoryResponseMaximumBytes,
            offset: 0,
            sessionKey,
        });

        expect(harness.requests).toEqual([
            {
                method: "chat.history",
                parameters: {
                    limit: 1,
                    maxChars: persistentGatewayChatHistoryMaximumChars,
                    offset: 0,
                    sessionKey,
                },
            },
        ]);
    });

    test("normalizes Codex commentary and provider reasoning blocks as thinking without changing final text", async () => {
        const commentary = "Inspecting the runtime before answering.";
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [{ text: commentary, type: "text" }],
                        id: "codex-commentary",
                        openclawStreamFallback: {
                            itemId: "commentary-item-1",
                            replacementText: commentary,
                            source: "segment",
                        },
                        role: "assistant",
                    },
                    {
                        content: [
                            {
                                text: "Synthetic provider reasoning.",
                                type: "reasoning_text",
                            },
                        ],
                        id: "synthetic-reasoning",
                        role: "assistant",
                    },
                    {
                        content: [{ text: "The final answer.", type: "text" }],
                        id: "codex-final",
                        role: "assistant",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 3,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages.map(({ content }) => content)).toEqual([
            {
                kind: "complete",
                parts: [{ id: "1", kind: "thinking", text: commentary }],
            },
            {
                kind: "complete",
                parts: [
                    {
                        id: "1",
                        kind: "thinking",
                        text: "Synthetic provider reasoning.",
                    },
                ],
            },
            {
                kind: "complete",
                parts: [{ id: "1", kind: "text", text: "The final answer." }],
            },
        ]);
    });

    test("projects history into bounded local media and sanitized diagnostics", async () => {
        const harness = createHarness({
            "chat.history": {
                hasMore: false,
                inFlightRun: {
                    plan: {
                        explanation: "Provider-only metadata is intentionally ignored",
                        steps: [
                            { status: "completed", step: "Inspect context" },
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
                    downloadUrl: `/api/chat/media/${attachmentId}?disposition=download`,
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
                explanation: "Provider-only metadata is intentionally ignored",
                steps: [
                    { status: "completed", text: "Inspect context" },
                    { status: "in_progress", text: "Answer safely" },
                ],
            },
            runId: "provider-run-in-flight",
            text: "Partial answer",
        });
    });

    test("marks provider-missing tool call identities as synthetic", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [
                            {
                                arguments: { query: "runtime" },
                                name: "search",
                                type: "tool_call",
                            },
                        ],
                        id: "assistant-call",
                        role: "assistant",
                    },
                    {
                        content: "found",
                        id: "tool-result",
                        role: "tool",
                        toolName: "search",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 2,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages.map(({ content }) => content)).toEqual([
            {
                kind: "complete",
                parts: [
                    {
                        callId: "1",
                        callIdSource: "synthetic",
                        id: "1",
                        input: '{"query":"runtime"}',
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                ],
            },
            {
                kind: "complete",
                parts: [
                    {
                        callId: "1",
                        callIdSource: "synthetic",
                        id: "1",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        output: "found",
                        phase: "succeeded",
                    },
                ],
            },
        ]);
    });

    test("marks anonymous tool names so they cannot become fallback match identity", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [{ type: "tool_call" }],
                        id: "anonymous-call",
                        role: "assistant",
                    },
                    {
                        content: "anonymous output",
                        id: "anonymous-result",
                        role: "tool",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 2,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        for (const message of history.messages) {
            expect(message.content).toMatchObject({
                parts: [
                    {
                        callIdSource: "synthetic",
                        kind: "tool",
                        name: "tool",
                        nameSource: "synthetic",
                    },
                ],
            });
        }
    });

    test("normalizes every audited tool identity alias on blocks and top-level result rows", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [
                            {
                                args: { query: "runtime" },
                                tool_call_id: "provider-call-1",
                                tool_name: "search",
                                type: "tool_use",
                            },
                        ],
                        id: "assistant-call",
                        role: "assistant",
                        runId: "provider-run-1",
                    },
                    {
                        callId: "provider-call-1",
                        content: [{ text: "found", type: "text" }],
                        id: "tool-result",
                        role: "tool",
                        runId: "provider-run-1",
                        tool_name: "search",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 2,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]).toMatchObject({
            content: {
                parts: [
                    {
                        callId: "provider-call-1",
                        input: '{"query":"runtime"}',
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                ],
            },
            runId: "provider-run-1",
        });
        expect(history.messages[1]).toMatchObject({
            content: {
                parts: [
                    {
                        callId: "provider-call-1",
                        kind: "tool",
                        name: "search",
                        output: "found",
                        phase: "succeeded",
                    },
                ],
            },
            runId: "provider-run-1",
        });
        expect(JSON.stringify(history)).not.toContain('"callIdSource":"synthetic"');
    });

    test("keeps bounded text and error aliases in provider-visible tool output", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [
                            {
                                callId: "provider-call-1",
                                name: "search",
                                text: "found",
                                type: "tool_result",
                            },
                        ],
                        id: "text-result",
                        role: "tool",
                    },
                    {
                        content: [
                            {
                                callId: "provider-call-2",
                                error: "denied",
                                name: "read",
                                type: "tool_result",
                            },
                        ],
                        id: "error-result",
                        role: "tool",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 2,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]?.content).toMatchObject({
            parts: [{ output: "found", phase: "succeeded" }],
        });
        expect(history.messages[1]?.content).toMatchObject({
            parts: [{ isError: true, output: "denied", phase: "failed" }],
        });
    });

    test("redacts unknown tool-role array blocks instead of serializing provider metadata", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [
                            { text: "visible output", type: "text" },
                            {
                                secret: "provider-private-value",
                                type: "private_context",
                            },
                        ],
                        id: "tool-result",
                        role: "tool",
                        toolCallId: "provider-call-1",
                        toolName: "search",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 1,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]?.content).toMatchObject({
            parts: [
                {
                    output: "visible output\nUnsupported provider content.",
                    phase: "succeeded",
                },
            ],
        });
        expect(JSON.stringify(history)).not.toContain("provider-private-value");
        expect(JSON.stringify(history)).not.toContain("private_context");
    });

    test("redacts object-shaped tool result content and ignores sentinel identity keys", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [
                            {
                                content: { secret: "provider-private-value" },
                                type: "tool_result",
                            },
                        ],
                        id: "object-result",
                        role: "tool",
                        toolCallId: "provider-call-1",
                        toolName: "search",
                    },
                    {
                        content: [
                            {
                                __topLevelCallId: "spoofed-call",
                                __topLevelName: "spoofed-name",
                                callId: "block-call",
                                content: "visible output",
                                name: "block-name",
                                toolCallId: "conflicting-block-call",
                                toolName: "conflicting-block-name",
                                type: "tool_result",
                            },
                        ],
                        id: "nested-result",
                        role: "assistant",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 2,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]?.content).toMatchObject({
            parts: [
                {
                    callId: "provider-call-1",
                    name: "search",
                    output: "Unsupported provider content.",
                },
            ],
        });
        expect(history.messages[1]?.content).toMatchObject({
            parts: [
                {
                    callId: "1",
                    callIdSource: "synthetic",
                    name: "tool",
                    nameSource: "synthetic",
                    output: "visible output",
                },
            ],
        });
        const encoded = JSON.stringify(history);
        expect(encoded).not.toContain("provider-private-value");
        expect(encoded).not.toContain('"secret"');
        expect(encoded).not.toContain("spoofed-call");
        expect(encoded).not.toContain("spoofed-name");
        expect(encoded).not.toContain("block-call");
        expect(encoded).not.toContain("block-name");
        expect(encoded).not.toContain("conflicting-block-call");
        expect(encoded).not.toContain("conflicting-block-name");
    });

    test("ignores unrelated tool identity aliases on ordinary text messages", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [{ text: "Visible assistant text", type: "text" }],
                        id: "ordinary-text",
                        name: "assistant-display-name",
                        role: "assistant",
                        toolCallId: "\u0000invalid-tool-call-id",
                        toolName: "unrelated-tool-name",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 1,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]?.content).toEqual({
            kind: "complete",
            parts: [{ id: "1", kind: "text", text: "Visible assistant text" }],
        });
    });

    test("does not downgrade conflicting tool identity aliases to synthetic matching", async () => {
        const harness = createHarness({
            "chat.history": {
                messages: [
                    {
                        content: [
                            {
                                callId: "provider-call-1",
                                name: "search",
                                toolCallId: "different-call",
                                type: "tool_call",
                            },
                        ],
                        id: "conflicting-call",
                        role: "assistant",
                    },
                    {
                        content: [
                            {
                                callId: "provider-call-1",
                                name: "search",
                                toolCallId: "\u0000invalid",
                                type: "tool_result",
                            },
                        ],
                        id: "malformed-result",
                        role: "tool",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 2,
            maxChars: 32 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages.map(({ content }) => content)).toEqual([
            {
                kind: "hydration-required",
                reason: "response-budget",
            },
            {
                kind: "hydration-required",
                reason: "response-budget",
            },
        ]);
    });

    test("projects separate bounded-text preview and full download URLs", async () => {
        const textAttachmentId = "019fe633-9133-4ba0-8b80-809dd80dfb42";
        const harness = createHarness({
            "chat.history": {
                hasMore: false,
                messages: [
                    {
                        content: [
                            {
                                attachment: {
                                    label: "notes.txt",
                                    mimeType: "text/plain",
                                    sizeBytes: 2 * 1024 * 1024,
                                    url: `/api/chat/media/outgoing/${encodeURIComponent(
                                        sessionKey
                                    )}/${textAttachmentId}/full`,
                                },
                                type: "attachment",
                            },
                        ],
                        id: "message-text-media",
                        role: "assistant",
                    },
                ],
                offset: 0,
                sessionKey,
            },
        });

        const history = await harness.provider.history({
            limit: 1,
            maxChars: 512 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]?.content).toEqual({
            kind: "complete",
            parts: [
                {
                    downloadUrl: `/api/chat/media/${textAttachmentId}?disposition=download`,
                    fileName: "notes.txt",
                    id: "1",
                    kind: "attachment",
                    mediaType: "text/plain",
                    renderPolicy: "bounded-text",
                    sizeBytes: 2 * 1024 * 1024,
                    url: `/api/chat/media/${textAttachmentId}?disposition=preview`,
                },
            ],
        });
    });

    test("omits provider message keys that are not canonical Dashboard idempotency keys", async () => {
        const canonicalKey = "A".repeat(32);
        const harness = createHarness({
            "chat.history": {
                defaults: {},
                messages: [
                    {
                        __openclaw: {
                            id: "019fe89d-156f-7ba0-bfad-2dff55fab001",
                            idempotencyKey: "channel:message:noncanonical",
                            seq: 1,
                        },
                        content: "First message",
                        role: "user",
                        timestamp: 1_800_000_000_000,
                    },
                    {
                        __openclaw: {
                            id: "019fe89d-156f-7ba0-bfad-2dff55fab002",
                            idempotencyKey: canonicalKey,
                            seq: 2,
                        },
                        content: "Second message",
                        role: "user",
                        timestamp: 1_800_000_000_001,
                    },
                ],
                offset: 0,
                sessionId: "session-generation-1",
                sessionInfo: {},
                sessionKey,
                thinkingLevel: "high",
                totalMessages: 2,
                verboseLevel: "off",
            },
        });

        const history = await harness.provider.history({
            limit: 2,
            maxChars: 16 * 1024,
            offset: 0,
            sessionKey,
        });

        expect(history.messages[0]).not.toHaveProperty("idempotencyKey");
        expect(history.messages[1]).toMatchObject({ idempotencyKey: canonicalKey });
        expect(history.sessionId).toBe("session-generation-1");
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
                    downloadUrl: `/api/chat/media/${svgAttachmentId}?disposition=download`,
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

    test("marks provider-missing runtime tool identity as synthetic", async () => {
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
                    data: { args: { query: "runtime" }, phase: "start" },
                    runId: "provider-run-synthetic",
                    seq: 7,
                    sessionKey,
                    stream: "tool",
                    ts: 10,
                },
            },
            receivedAtMs: 20,
        });

        expect(projected).toEqual([
            expect.objectContaining({
                callId: "provider-run-synthetic:7",
                callIdSource: "synthetic",
                kind: "tool",
                name: "tool",
                nameSource: "synthetic",
                phase: "started",
            }),
        ]);
    });

    test("normalizes installed Gateway plan step fields for runtime events", async () => {
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
                        explanation: "Why this plan is useful.",
                        phase: "update",
                        private: "must not cross",
                        source: "provider-private-source",
                        steps: [
                            { status: "completed", step: "Inspect context" },
                            { status: "in_progress", step: "Render activity" },
                        ],
                        title: "Provider-private title",
                    },
                    runId: "provider-plan-run",
                    seq: 3,
                    sessionKey,
                    stream: "plan",
                    ts: 10,
                },
            },
            receivedAtMs: 20,
        });

        expect(projected).toEqual([
            {
                explanation: "Why this plan is useful.",
                kind: "plan",
                phase: "update",
                providerRunId: "provider-plan-run",
                providerSequence: 3,
                receivedAtMs: 20,
                sessionKey,
                steps: [
                    { status: "completed", text: "Inspect context" },
                    { status: "in_progress", text: "Render activity" },
                ],
            },
        ]);
        expect(JSON.stringify(projected)).not.toContain("provider-private");
    });

    test("rejects malformed known plan updates instead of advancing as noops", async () => {
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
        const failure = await captureFailure(() =>
            harness.deliverChat({
                connectionGeneration: 1,
                frame: {
                    event: "agent",
                    payload: {
                        data: {
                            explanation: "x".repeat(4001),
                            phase: "update",
                            steps: [{ status: "pending", step: "Wait" }],
                        },
                        runId: "provider-malformed-plan",
                        seq: 1,
                        sessionKey,
                        stream: "plan",
                        ts: 10,
                    },
                },
                receivedAtMs: 20,
            })
        );

        expect(failure).toBeInstanceOf(ChatProviderUnavailableError);
        expect(projected).toEqual([]);
    });

    test("projects agent snapshots and genuine chat suffixes onto one assistant family", async () => {
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
                    deltaText: " Confirmed.",
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
                streamId: "assistant",
                text: "Checking cancellation.",
            },
            {
                kind: "delta",
                mode: "append",
                providerRunId: "cancelled-run",
                providerSequence: 2,
                receivedAtMs: 2,
                sessionKey,
                stream: "assistant",
                streamId: "assistant",
                text: " Confirmed.",
            },
            {
                kind: "delta",
                mode: "append",
                providerRunId: "completed-run",
                providerSequence: 2,
                receivedAtMs: 3,
                sessionKey,
                stream: "assistant",
                streamId: "assistant",
                text: "Running the fixture tool.",
            },
            {
                kind: "delta",
                mode: "append",
                providerRunId: "completed-run",
                providerSequence: 5,
                receivedAtMs: 4,
                sessionKey,
                stream: "assistant",
                streamId: "assistant",
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

        await deliver(
            {
                delta: "must-not-project",
                isReasoningSnapshot: true,
                text: "Inspecting",
            },
            1
        );
        await deliver({ isReasoningSnapshot: true, text: "Inspecting context" }, 2);
        await deliver({ isReasoningSnapshot: true, text: "Inspecting context" }, 3);
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

    test("projects assistant commentary as thinking without reclassifying final answers", async () => {
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
                        runId: "assistant-phase-run",
                        seq,
                        sessionKey,
                        stream: "assistant",
                        ts: seq,
                    },
                },
                receivedAtMs: seq,
            });

        await deliver({ phase: "commentary", text: "Inspecting" }, 1);
        await deliver({ delta: " context", phase: "commentary" }, 2);
        await deliver({ phase: "commentary", replace: true, text: "Checked context" }, 3);
        await deliver({ phase: "final_answer", text: "Finished." }, 4);
        await deliver({ text: "Finished without an explicit phase." }, 5);

        expect(projected).toEqual([
            {
                kind: "delta",
                mode: "merge",
                providerRunId: "assistant-phase-run",
                providerSequence: 1,
                receivedAtMs: 1,
                sessionKey,
                stream: "thinking",
                streamId: "agent:commentary",
                text: "Inspecting",
            },
            {
                kind: "delta",
                mode: "append",
                providerRunId: "assistant-phase-run",
                providerSequence: 2,
                receivedAtMs: 2,
                sessionKey,
                stream: "thinking",
                streamId: "agent:commentary",
                text: " context",
            },
            {
                kind: "delta",
                mode: "replace",
                providerRunId: "assistant-phase-run",
                providerSequence: 3,
                receivedAtMs: 3,
                sessionKey,
                stream: "thinking",
                streamId: "agent:commentary",
                text: "Checked context",
            },
            {
                kind: "delta",
                mode: "merge",
                providerRunId: "assistant-phase-run",
                providerSequence: 4,
                receivedAtMs: 4,
                sessionKey,
                stream: "assistant",
                streamId: "assistant",
                text: "Finished.",
            },
            {
                kind: "delta",
                mode: "merge",
                providerRunId: "assistant-phase-run",
                providerSequence: 5,
                receivedAtMs: 5,
                sessionKey,
                stream: "assistant",
                streamId: "assistant",
                text: "Finished without an explicit phase.",
            },
        ]);
    });

    test("projects the installed compaction lifecycle without false completion", async () => {
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
                        runId: "compaction-run",
                        seq,
                        sessionKey,
                        stream: "compaction",
                        ts: seq,
                    },
                },
                receivedAtMs: 1000 + seq,
            });

        await deliver({ phase: "start" }, 1);
        await deliver({ completed: false, phase: "end", willRetry: true }, 2);
        await deliver({ phase: "start" }, 3);
        await deliver({ completed: true, phase: "end", willRetry: false }, 4);
        await deliver({ completed: false, phase: "end", willRetry: false }, 5);

        expect(projected).toEqual([
            expect.objectContaining({
                kind: "compaction",
                phase: "active",
                providerRunId: "compaction-run",
                providerSequence: 1,
            }),
            expect.objectContaining({
                kind: "compaction",
                phase: "active",
                providerSequence: 2,
            }),
            expect.objectContaining({
                kind: "compaction",
                phase: "active",
                providerSequence: 3,
            }),
            expect.objectContaining({
                kind: "compaction",
                phase: "complete",
                providerSequence: 4,
            }),
            expect.objectContaining({
                kind: "compaction",
                phase: "inactive",
                providerSequence: 5,
            }),
        ]);
    });

    test("projects Codex preamble progress items onto the thinking stream", async () => {
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
                        itemId: "preamble-1",
                        kind: "preamble",
                        phase: "update",
                        progressText: "Checking the live session.",
                    },
                    runId: "codex-preamble-run",
                    seq: 1,
                    sessionKey,
                    stream: "item",
                    ts: 1,
                },
            },
            receivedAtMs: 2,
        });

        expect(projected).toEqual([
            {
                kind: "delta",
                mode: "merge",
                providerRunId: "codex-preamble-run",
                providerSequence: 1,
                receivedAtMs: 2,
                segmentId: "agent:preamble:preamble-1",
                sessionKey,
                stream: "thinking",
                streamId: "agent:preamble",
                text: "Checking the live session.",
            },
        ]);
    });

    test("normalizes standard Codex and suppressed message presentation items to provider noops", async () => {
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

        const itemKinds = ["command", "analysis", "tool", "message"] as const;
        for (const [index, kind] of itemKinds.entries()) {
            await harness.deliverChat({
                connectionGeneration: 1,
                frame: {
                    event: "agent",
                    payload: {
                        data: {
                            itemId: `codex-item-${index}`,
                            kind,
                            phase: index === 0 ? "start" : "end",
                            ...(kind === "message"
                                ? { suppressChannelProgress: true }
                                : {}),
                            title: kind,
                        },
                        runId: "codex-standard-items",
                        seq: index + 1,
                        sessionKey,
                        stream: "item",
                        ts: index + 1,
                    },
                },
                receivedAtMs: index + 10,
            });
        }

        expect(projected).toEqual(
            itemKinds.map((_, index) => ({
                kind: "noop",
                providerRunId: "codex-standard-items",
                providerSequence: index + 1,
                reason: "ignored",
                receivedAtMs: index + 10,
                sessionKey,
            }))
        );
        expect(JSON.stringify(projected)).not.toMatch(/command|analysis|tool|message/u);
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
