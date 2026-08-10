import * as v from "valibot";

import {
    chatCompanionAskOutputSchema,
    chatCompanionResetOutputSchema,
    chatCompanionStateOutputSchema,
    chatMessageGetOutputSchema,
    chatModelsListOutputSchema,
    chatSessionSettingsOutputSchema,
    type ChatMessageGetOutput,
    type ChatModelsListOutput,
    type ChatSessionSettingsOutput,
} from "../../../contracts/chat.ts";
import {
    chatMessageHydrationMaximumBytes,
    chatMessageSchema,
    chatMessagePartSchema,
    chatPlanExplanationSchema,
    chatPlanStepSchema,
    type ChatMessage,
    type ChatPlanStep,
} from "../../../contracts/chatModel.ts";
import { jobIdempotencyKeySchema } from "../../../contracts/jobModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import {
    boundedControlSafeTextSchema,
    hasNoNulCharacter,
} from "../../../shared/validation.ts";

type ProjectedChatMessagePart = v.InferOutput<typeof chatMessagePartSchema>;

class ProjectedChatMessageOversizedError extends Error {
    constructor() {
        super("Projected chat message exceeds its hydration budget");
        this.name = "ProjectedChatMessageOversizedError";
    }
}
import {
    ChatProviderConflictError,
    type ChatEventSubscription,
    type ChatEventSubscriptionRequest,
    type ChatProvider,
    type ChatProviderAbortAcknowledgement,
    type ChatProviderAbortRequest,
    ChatProviderCapacityError,
    type ChatProviderEvent,
    type ChatProviderHistoryPage,
    type ChatProviderHistoryRequest,
    type ChatProviderMessageRequest,
    type ChatProviderSendAcknowledgement,
    type ChatProviderSendRequest,
    ChatProviderUnknownOutcomeError,
    ChatProviderUnavailableError,
} from "../../domains/chat/provider.ts";
import {
    parsePersistentGatewayChatSendAcknowledgement,
    persistentGatewayChatHistoryMaximumChars,
    type PersistentGatewayChatReadMethod,
    type PersistentGatewayChatReadMutationMethod,
    type PersistentGatewayChatWriteMethod,
} from "./persistentGatewayProtocol.ts";
import {
    persistentGatewaySessionChangedReason,
    persistentGatewaySessionCompanionBusyReason,
    PersistentGatewayCapacityError,
    PersistentGatewayRequestError,
    type PersistentGatewayDeliveredChatEvent,
    type PersistentGatewayRequestOptions,
    type PersistentGatewayTransport,
    PersistentGatewayUnknownOutcomeError,
} from "./persistentGatewayTransport.ts";

/** Read deadlines for bounded history, hydration, catalog, and companion state. */
export const persistentGatewayChatReadTimeoutMs = 15_000;
/** Send, abort, settings, companion ask, and companion reset acknowledgement budget. */
export const persistentGatewayChatMutationTimeoutMs = 60_000;

export type PersistentGatewayChatProviderTransport = Pick<
    PersistentGatewayTransport,
    | "requestAdmin"
    | "requestChatRead"
    | "requestChatReadMutation"
    | "requestChatWrite"
    | "subscribeChat"
>;

export interface PersistentGatewayChatMediaReferenceRegistrar {
    readonly register: (
        reference: Readonly<{
            attachmentId: string;
            messageId: string;
            sessionKey: string;
        }>
    ) => void;
}

const upstreamInFlightRunSchema = v.strictObject({
    plan: v.optional(
        v.object({
            explanation: v.optional(chatPlanExplanationSchema),
            steps: v.pipe(v.array(v.unknown()), v.maxLength(64)),
        })
    ),
    runId: boundedControlSafeTextSchema(256, "Chat provider in-flight run id is invalid"),
    text: v.pipe(
        v.string("Chat provider in-flight run text is invalid"),
        v.maxLength(64 * 1024, "Chat provider in-flight run text is invalid"),
        v.check(hasNoNulCharacter, "Chat provider in-flight run text is invalid"),
        v.check(
            (text) => utf8ByteLength(text) <= 64 * 1024,
            "Chat provider in-flight run text is invalid"
        )
    ),
});

const upstreamHistorySchema = v.object({
    hasMore: v.optional(v.boolean()),
    inFlightRun: v.optional(upstreamInFlightRunSchema),
    messages: v.pipe(v.array(v.unknown()), v.maxLength(100)),
    nextOffset: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    offset: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    sessionId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
    sessionKey: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});
const inlineRasterAttachmentMimeTypes: ReadonlySet<string> = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/webp",
]);
const upstreamMessageGetSchema = v.variant("ok", [
    v.object({ message: v.unknown(), ok: v.literal(true) }),
    v.object({
        ok: v.literal(false),
        unavailableReason: v.picklist(["not_found", "not_visible", "oversized"]),
    }),
]);
const upstreamAbortSchema = v.strictObject({
    aborted: v.boolean(),
    ok: v.literal(true),
    runIds: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
        v.maxLength(32)
    ),
});
const upstreamModelsSchema = v.object({
    models: v.pipe(
        v.array(
            v.object({
                available: v.optional(v.boolean()),
                id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
                name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
                provider: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
                reasoning: v.optional(v.boolean()),
            })
        ),
        v.maxLength(512)
    ),
});
const upstreamOptionalModelSchema = v.optional(
    v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(256)))
);
const upstreamOptionalThinkingLevelSchema = v.optional(
    v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(128)))
);
const upstreamSettingsSchema = v.object({
    entry: v.object({
        fastMode: v.optional(v.nullable(v.union([v.boolean(), v.literal("auto")]))),
        sessionId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
        thinkingLevel: upstreamOptionalThinkingLevelSchema,
    }),
    key: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    ok: v.literal(true),
    resolved: v.optional(
        v.object({
            model: upstreamOptionalModelSchema,
            thinkingLevel: upstreamOptionalThinkingLevelSchema,
        })
    ),
});
const upstreamCompanionStateSchema = v.strictObject({
    exchanges: v.pipe(
        v.array(
            v.strictObject({
                answer: v.pipe(v.string(), v.minLength(1), v.maxLength(1200)),
                question: v.pipe(v.string(), v.minLength(1), v.maxLength(400)),
                ts: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
            })
        ),
        v.maxLength(24)
    ),
});
const upstreamCompanionAskSchema = v.strictObject({
    answer: v.pipe(v.string(), v.minLength(1), v.maxLength(1200)),
    ts: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const upstreamCompanionResetSchema = v.strictObject({ ok: v.literal(true) });

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
        return undefined;
    }
    for (const character of value) {
        const point = character.codePointAt(0);
        if (point === 0 || point === 127) return undefined;
    }
    return value;
}

function boundedControlString(value: unknown, maximum: number): string | undefined {
    const text = boundedString(value, maximum);
    if (text === undefined) return undefined;
    for (const character of text) {
        const point = character.codePointAt(0);
        if (point !== undefined && point <= 31) return undefined;
    }
    return text;
}

function resolveControlAlias(
    values: readonly unknown[],
    maximum: number
): string | null | undefined {
    let resolved: string | undefined;
    for (const value of values) {
        if (value === undefined || value === null) continue;
        const candidate = boundedControlString(value, maximum);
        if (candidate === undefined) return null;
        if (resolved !== undefined && resolved !== candidate) return null;
        resolved = candidate;
    }
    return resolved;
}

class ChatProviderEventReconciliationRequiredError extends Error {}

function projectChatDeltaText(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    if (value.length > 64 * 1024 || value.includes("\u0000")) {
        throw new ChatProviderEventReconciliationRequiredError();
    }
    return value;
}

const chatTerminalErrorMessages = Object.freeze({
    context_length: "Chat provider context limit exceeded",
    rate_limit: "Chat provider rate limit exceeded",
    refusal: "Chat provider refused the request",
    timeout: "Chat provider timed out",
    unknown: "Chat provider reported an error",
});
const chatTerminalOutcomes = Object.freeze({
    aborted: "aborted",
    error: "error",
    final: "completed",
});
const chatMessageUnavailableReasons = Object.freeze({
    not_found: "not-found",
    not_visible: "not-visible",
    oversized: "oversized",
});

function safeInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function canonicalIdempotencyKey(value: unknown): string | undefined {
    const parsed = v.safeParse(jobIdempotencyKeySchema, value);
    return parsed.success ? parsed.output : undefined;
}

function safeJsonText(value: unknown, maximum: number): string | undefined {
    try {
        const encoded = typeof value === "string" ? value : JSON.stringify(value);
        return boundedString(encoded, maximum);
    } catch {
        return undefined;
    }
}

function providerVisibleToolResult(value: unknown): unknown {
    if (value === undefined) return undefined;
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value;
    }
    if (!Array.isArray(value)) {
        const block = asRecord(value);
        const type =
            typeof block?.type === "string" ? block.type.toLowerCase() : undefined;
        return (type === "text" || type === "output_text") &&
            typeof block?.text === "string"
            ? block.text
            : "Unsupported provider content.";
    }
    const text: string[] = [];
    for (const item of value) {
        if (typeof item === "string") {
            text.push(item);
            continue;
        }
        const block = asRecord(item);
        const type =
            typeof block?.type === "string" ? block.type.toLowerCase() : undefined;
        if (
            (type !== "text" && type !== "output_text") ||
            typeof block?.text !== "string"
        ) {
            text.push("Unsupported provider content.");
            continue;
        }
        text.push(block.text);
    }
    return text.join("\n");
}

function parseOrUnavailable<
    TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, value: unknown): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, value, { abortEarly: true });
    if (!parsed.success) throw new ChatProviderUnavailableError();
    return parsed.output;
}

function parseMutationAcknowledgement<
    TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, value: unknown): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, value, { abortEarly: true });
    if (!parsed.success) throw new ChatProviderUnknownOutcomeError();
    return parsed.output;
}

function translateTransportFailure(error: unknown): never {
    if (error instanceof PersistentGatewayUnknownOutcomeError) {
        throw new ChatProviderUnknownOutcomeError();
    }
    if (
        error instanceof PersistentGatewayCapacityError ||
        (error instanceof PersistentGatewayRequestError &&
            error.reason === persistentGatewaySessionCompanionBusyReason)
    ) {
        throw new ChatProviderCapacityError();
    }
    if (
        error instanceof PersistentGatewayRequestError &&
        error.reason === persistentGatewaySessionChangedReason
    ) {
        throw new ChatProviderConflictError();
    }
    throw new ChatProviderUnavailableError();
}

async function requestRead(
    transport: PersistentGatewayChatProviderTransport,
    method: PersistentGatewayChatReadMethod,
    parameters: Readonly<Record<string, unknown>>,
    options: PersistentGatewayRequestOptions
): Promise<unknown> {
    try {
        return await transport.requestChatRead(method, parameters, options);
    } catch (error) {
        return translateTransportFailure(error);
    }
}

async function requestWrite(
    transport: PersistentGatewayChatProviderTransport,
    method: PersistentGatewayChatWriteMethod,
    parameters: Readonly<Record<string, unknown>>,
    options: PersistentGatewayRequestOptions
): Promise<unknown> {
    try {
        return await transport.requestChatWrite(method, parameters, options);
    } catch (error) {
        return translateTransportFailure(error);
    }
}

async function requestReadMutation(
    transport: PersistentGatewayChatProviderTransport,
    method: PersistentGatewayChatReadMutationMethod,
    parameters: Readonly<Record<string, unknown>>,
    options: PersistentGatewayRequestOptions
): Promise<unknown> {
    try {
        return await transport.requestChatReadMutation(method, parameters, options);
    } catch (error) {
        return translateTransportFailure(error);
    }
}

function managedMediaUrl(
    value: unknown,
    expectedSessionKey: string,
    messageId: string,
    registrar: PersistentGatewayChatMediaReferenceRegistrar
): string | undefined {
    if (typeof value !== "string" || value.length > 4096) return undefined;
    const match = value.match(
        /^\/api\/chat\/media\/outgoing\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/full$/iu
    );
    if (match === null) return undefined;
    try {
        if (decodeURIComponent(match[1]!) !== expectedSessionKey) return undefined;
    } catch {
        return undefined;
    }
    const attachmentId = match[2]!.toLowerCase();
    registrar.register({
        attachmentId,
        messageId,
        sessionKey: expectedSessionKey,
    });
    return `/api/chat/media/${attachmentId}`;
}

function attachmentRenderPolicy(
    mimeType: string
): "bounded-text" | "download-only" | "inline-image" {
    if (inlineRasterAttachmentMimeTypes.has(mimeType)) {
        return "inline-image";
    }
    if (
        mimeType === "text/csv" ||
        mimeType === "text/markdown" ||
        mimeType === "text/plain" ||
        mimeType === "application/json" ||
        mimeType === "application/ld+json"
    ) {
        return "bounded-text";
    }
    return "download-only";
}

function projectAttachmentPart(
    block: Readonly<Record<string, unknown>>,
    partId: string,
    sessionKey: string,
    messageId: string,
    registrar: PersistentGatewayChatMediaReferenceRegistrar
): ProjectedChatMessagePart | undefined {
    const attachment = asRecord(block.attachment);
    if (block.type !== "attachment" || attachment === undefined) return undefined;
    const url = managedMediaUrl(attachment.url, sessionKey, messageId, registrar);
    const fileName = boundedControlString(attachment.label, 255);
    const mediaType = boundedControlString(attachment.mimeType, 127)?.toLowerCase();
    if (url === undefined || fileName === undefined || mediaType === undefined) {
        return undefined;
    }
    const sizeBytes = safeInteger(attachment.sizeBytes);
    const renderPolicy = attachmentRenderPolicy(mediaType);
    return {
        downloadUrl: `${url}?disposition=download`,
        fileName,
        id: partId,
        kind: "attachment",
        mediaType,
        renderPolicy,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        url: `${url}?disposition=${
            renderPolicy === "download-only" ? "download" : "preview"
        }`,
    };
}

function projectMessageParts(
    message: Readonly<Record<string, unknown>>,
    sessionKey: string,
    messageId: string,
    registrar: PersistentGatewayChatMediaReferenceRegistrar
): readonly unknown[] | undefined {
    const rawContent = message.content;
    const rawRole = boundedControlString(message.role, 32)?.toLowerCase();
    const streamFallback = asRecord(message.openclawStreamFallback);
    let commentaryText: string | undefined;
    if (rawRole === "assistant" && streamFallback?.source === "segment") {
        const itemId = boundedControlString(streamFallback.itemId, 256);
        const replacementText = boundedString(streamFallback.replacementText, 256 * 1024);
        if (itemId !== undefined) commentaryText = replacementText;
    }
    let blocks: readonly unknown[];
    if (rawRole?.startsWith("tool") === true) {
        if (Array.isArray(rawContent)) {
            const contentBlocks: readonly unknown[] = rawContent;
            const explicitToolResult = contentBlocks.some((value) => {
                const block = asRecord(value);
                const type =
                    typeof block?.type === "string" ? block.type.toLowerCase() : "";
                return type === "toolresult" || type === "tool_result";
            });
            if (explicitToolResult) {
                blocks = contentBlocks;
            } else {
                const attachmentBlocks = contentBlocks.filter((value) => {
                    const block = asRecord(value);
                    return block?.type === "attachment";
                });
                const outputBlocks = contentBlocks.filter((value) => {
                    const block = asRecord(value);
                    return block?.type !== "attachment";
                });
                const topLevelOutput =
                    outputBlocks.length === 0
                        ? (message.result ??
                          message.output ??
                          message.text ??
                          message.error)
                        : providerVisibleToolResult(outputBlocks);
                blocks = [
                    {
                        content: topLevelOutput,
                        isError: message.isError === true || message.error !== undefined,
                        type: "tool_result",
                    },
                    ...attachmentBlocks,
                ];
            }
        } else {
            blocks = [
                {
                    content:
                        rawContent ??
                        message.result ??
                        message.output ??
                        message.text ??
                        message.error,
                    isError: message.isError === true || message.error !== undefined,
                    type: "tool_result",
                },
            ];
        }
    } else if (Array.isArray(rawContent)) blocks = rawContent;
    else if (rawContent === undefined) blocks = [];
    else blocks = [{ type: "text", text: rawContent }];
    if (blocks.length > 128) return undefined;
    const parts: unknown[] = [];
    for (const [index, rawBlock] of blocks.entries()) {
        const partId = String(index + 1);
        const block = asRecord(rawBlock);
        if (block === undefined) {
            const text = boundedString(rawBlock, 256 * 1024);
            if (text === undefined) return undefined;
            parts.push({ id: partId, kind: "text", text });
            continue;
        }
        const attachment = projectAttachmentPart(
            block,
            partId,
            sessionKey,
            messageId,
            registrar
        );
        if (attachment !== undefined) {
            parts.push(attachment);
            continue;
        }
        const type = typeof block.type === "string" ? block.type.toLowerCase() : "";
        if (type === "text" || type === "output_text") {
            const text = boundedString(block.text, 256 * 1024);
            if (text === undefined) return undefined;
            parts.push({
                id: partId,
                kind: commentaryText === text ? "thinking" : "text",
                text,
            });
            continue;
        }
        if (
            type === "thinking" ||
            type === "reasoning" ||
            type === "reasoning_text" ||
            type === "analysis" ||
            type === "commentary"
        ) {
            const text = boundedString(block.thinking ?? block.text, 256 * 1024);
            if (text === undefined) return undefined;
            parts.push({ id: partId, kind: "thinking", text });
            continue;
        }
        if (
            type === "toolcall" ||
            type === "tool_call" ||
            type === "tooluse" ||
            type === "tool_use"
        ) {
            const providerName = resolveControlAlias(
                [block.name, block.toolName, block.tool_name],
                200
            );
            const providerCallId = resolveControlAlias(
                [block.toolCallId, block.tool_call_id, block.callId, block.id],
                256
            );
            if (providerName === null || providerCallId === null) return undefined;
            parts.push({
                callId: providerCallId ?? partId,
                ...(providerCallId === undefined ? { callIdSource: "synthetic" } : {}),
                id: partId,
                input: safeJsonText(
                    block.args ?? block.arguments ?? block.input,
                    32 * 1024
                ),
                isError: false,
                kind: "tool",
                name: providerName ?? "tool",
                ...(providerName === undefined ? { nameSource: "synthetic" } : {}),
                phase: "started",
            });
            continue;
        }
        if (type === "toolresult" || type === "tool_result") {
            const isError = block.isError === true || block.error !== undefined;
            const topLevelToolName = resolveControlAlias(
                [message.name, message.toolName, message.tool_name],
                200
            );
            const topLevelToolCallId = resolveControlAlias(
                [message.callId, message.toolCallId, message.tool_call_id],
                256
            );
            if (topLevelToolName === null || topLevelToolCallId === null) {
                return undefined;
            }
            let providerName = topLevelToolName;
            let providerCallId = topLevelToolCallId;
            if (rawRole?.startsWith("tool") === true) {
                const blockProviderName = resolveControlAlias(
                    [block.name, block.toolName, block.tool_name],
                    200
                );
                const blockProviderCallId = resolveControlAlias(
                    [block.toolCallId, block.tool_call_id, block.callId, block.id],
                    256
                );
                if (blockProviderName === null || blockProviderCallId === null) {
                    return undefined;
                }
                const resolvedProviderName = resolveControlAlias(
                    [topLevelToolName, blockProviderName],
                    200
                );
                const resolvedProviderCallId = resolveControlAlias(
                    [topLevelToolCallId, blockProviderCallId],
                    256
                );
                if (resolvedProviderName === null || resolvedProviderCallId === null) {
                    return undefined;
                }
                providerName = resolvedProviderName;
                providerCallId = resolvedProviderCallId;
            }
            const output = safeJsonText(
                block.result ??
                    block.output ??
                    providerVisibleToolResult(block.content) ??
                    block.text ??
                    block.error,
                32 * 1024
            );
            parts.push({
                callId: providerCallId ?? partId,
                ...(providerCallId === undefined ? { callIdSource: "synthetic" } : {}),
                id: partId,
                isError,
                kind: "tool",
                name: providerName ?? "tool",
                ...(providerName === undefined ? { nameSource: "synthetic" } : {}),
                ...(output === undefined && !isError
                    ? {}
                    : {
                          output:
                              output ?? "Tool failed without a provider-visible result.",
                      }),
                phase: isError ? "failed" : "succeeded",
            });
            continue;
        }
        // Unknown provider blocks may contain credentials or internal metadata.
        // Keep only a fixed marker; never serialize their type or payload.
        parts.push({
            id: partId,
            kind: "control",
            text: "Unsupported provider content.",
        });
    }
    if (parts.length === 0) {
        const fallbackText = boundedString(message.text, 256 * 1024);
        if (fallbackText !== undefined) {
            parts.push({ id: "1", kind: "text", text: fallbackText });
        }
    }
    return parts;
}

function abortSignalIsAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

function historyMetadata(
    message: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
    return asRecord(message.__openclaw) ?? {};
}

function projectHistoryMessage(
    value: unknown,
    sessionKey: string,
    registrar: PersistentGatewayChatMediaReferenceRegistrar,
    fallbackMessageId?: string
): ChatMessage {
    const message = asRecord(value);
    if (message === undefined) throw new ChatProviderUnavailableError();
    const metadata = historyMetadata(message);
    const id =
        boundedControlString(metadata.id, 256) ??
        boundedControlString(message.id ?? message.messageId, 256) ??
        fallbackMessageId;
    if (id === undefined) throw new ChatProviderUnavailableError();
    if (fallbackMessageId !== undefined && id !== fallbackMessageId) {
        throw new ChatProviderUnavailableError();
    }
    const rawRole = boundedControlString(message.role, 32)?.toLowerCase();
    let role: "assistant" | "system" | "tool" | "user" | undefined;
    if (
        rawRole === "assistant" ||
        rawRole === "system" ||
        rawRole === "user" ||
        rawRole === "tool"
    ) {
        role = rawRole;
    } else if (rawRole?.startsWith("tool") === true) {
        role = "tool";
    }
    if (role === undefined) throw new ChatProviderUnavailableError();
    const preview = boundedString(message.text, 4096);
    const parts = projectMessageParts(message, sessionKey, id, registrar);
    const hydrationRequired = metadata.truncated === true || parts === undefined;
    const projected = {
        content: hydrationRequired
            ? {
                  kind: "hydration-required" as const,
                  ...(preview === undefined ? {} : { preview }),
                  reason:
                      metadata.truncated === true
                          ? ("provider-omitted" as const)
                          : ("response-budget" as const),
              }
            : { kind: "complete" as const, parts },
        createdAtMs: safeInteger(message.timestamp ?? message.createdAtMs),
        id,
        idempotencyKey: canonicalIdempotencyKey(
            metadata.idempotencyKey ?? message.idempotencyKey
        ),
        model: boundedControlString(message.model, 256),
        provider: boundedControlString(message.provider, 128),
        role,
        runId: boundedControlString(metadata.runId ?? message.runId, 256),
        sequence: safeInteger(metadata.seq ?? message.sequence),
        source: "gateway-history" as const,
        stopReason: boundedControlString(message.stopReason, 128),
    };
    const withoutUndefined = Object.fromEntries(
        Object.entries(projected).filter(([, field]) => field !== undefined)
    );
    if (
        fallbackMessageId !== undefined &&
        utf8ByteLength(JSON.stringify(withoutUndefined)) >
            chatMessageHydrationMaximumBytes
    ) {
        throw new ProjectedChatMessageOversizedError();
    }
    return parseOrUnavailable(chatMessageSchema, withoutUndefined);
}

function eventBase(event: PersistentGatewayDeliveredChatEvent): Readonly<{
    providerRunId: string;
    providerSequence: number;
    receivedAtMs: number;
    sessionKey: string;
}> {
    return {
        providerRunId: event.frame.payload.runId,
        providerSequence: event.frame.payload.seq,
        receivedAtMs: event.receivedAtMs,
        sessionKey: event.frame.payload.sessionKey,
    };
}

function projectPlanSteps(
    value: unknown,
    options: Readonly<{ allowEmpty?: boolean }> = {}
): readonly ChatPlanStep[] {
    if (
        !Array.isArray(value) ||
        (value.length === 0 && options.allowEmpty !== true) ||
        value.length > 64
    ) {
        throw new ChatProviderUnavailableError();
    }
    const steps = value.map((step) => {
        const record = asRecord(step);
        if (record === undefined) throw new ChatProviderUnavailableError();
        const text = record.text ?? record.step;
        if (
            record.text !== undefined &&
            record.step !== undefined &&
            record.text !== record.step
        ) {
            throw new ChatProviderUnavailableError();
        }
        return parseOrUnavailable(chatPlanStepSchema, {
            status: record.status,
            text,
        });
    });
    if (steps.filter(({ status }) => status === "in_progress").length > 1) {
        throw new ChatProviderUnavailableError();
    }
    return Object.freeze(steps);
}

function projectPlanExplanation(value: unknown): string | undefined {
    return value === undefined
        ? undefined
        : parseOrUnavailable(chatPlanExplanationSchema, value);
}

function projectToolEvent(
    event: PersistentGatewayDeliveredChatEvent,
    data: Readonly<Record<string, unknown>>
): ChatProviderEvent {
    const rawPhase = boundedControlString(data.phase, 32);
    const isError = data.isError === true || rawPhase === "error";
    const output = safeJsonText(
        data.result ?? data.partialResult ?? data.output,
        32 * 1024
    );
    let phase: "failed" | "running" | "started" | "succeeded" = "running";
    if (rawPhase === "start") phase = "started";
    else if (rawPhase === "result" || rawPhase === "error") {
        phase = isError ? "failed" : "succeeded";
    }
    const providerCallId = resolveControlAlias(
        [data.toolCallId, data.tool_call_id, data.callId],
        256
    );
    const providerName = resolveControlAlias(
        [data.toolName, data.tool_name, data.name],
        200
    );
    if (providerCallId === null || providerName === null) {
        throw new ChatProviderEventReconciliationRequiredError();
    }
    return Object.freeze({
        ...eventBase(event),
        callId:
            providerCallId ?? `${event.frame.payload.runId}:${event.frame.payload.seq}`,
        ...(providerCallId === undefined ? { callIdSource: "synthetic" as const } : {}),
        input: safeJsonText(data.args ?? data.input, 32 * 1024),
        isError,
        kind: "tool",
        name: providerName ?? "tool",
        ...(providerName === undefined ? { nameSource: "synthetic" as const } : {}),
        ...(output === undefined && !isError
            ? {}
            : {
                  output: output ?? "Tool failed without a provider-visible result.",
              }),
        phase,
    });
}

function projectItemEvent(
    event: PersistentGatewayDeliveredChatEvent,
    data: Readonly<Record<string, unknown>>
): ChatProviderEvent {
    const item = asRecord(data.item ?? data.payload) ?? data;
    const itemId =
        boundedControlString(item.id ?? item.itemId, 256) ??
        `${event.frame.payload.runId}:${event.frame.payload.seq}`;
    return Object.freeze({
        ...eventBase(event),
        itemId,
        itemType: boundedControlString(item.type ?? item.kind, 128) ?? "item",
        kind: "item",
        text: boundedString(item.text, 32 * 1024),
    });
}

function projectNoopEvent(event: PersistentGatewayDeliveredChatEvent): ChatProviderEvent {
    return Object.freeze({
        ...eventBase(event),
        kind: "noop",
        reason: "ignored",
    });
}

function projectProviderEvent(
    event: PersistentGatewayDeliveredChatEvent
): ChatProviderEvent {
    if (event.frame.event === "chat") {
        const payload = event.frame.payload;
        if (payload.state === "delta") {
            return Object.freeze({
                ...eventBase(event),
                kind: "delta",
                mode: payload.replace === true ? "replace" : "merge",
                stream: "assistant",
                text: projectChatDeltaText(payload.deltaText)!,
            });
        }
        if (payload.state === "status") {
            const phase = payload.phase.replaceAll("_", "-") as
                | "preparing-context"
                | "preparing-workspace"
                | "provisioning-environment"
                | "starting-model";
            return Object.freeze({ ...eventBase(event), kind: "status", phase });
        }
        const errorKind =
            payload.state === "error" ? (payload.errorKind ?? "unknown") : undefined;
        return Object.freeze({
            ...eventBase(event),
            errorCode: errorKind,
            errorMessage:
                errorKind === undefined
                    ? undefined
                    : chatTerminalErrorMessages[errorKind],
            kind: "terminal",
            outcome: chatTerminalOutcomes[payload.state],
            stopReason: boundedControlString(payload.stopReason, 128),
        });
    }

    const payload = event.frame.payload;
    const data = payload.data;
    if (payload.stream === "assistant") {
        const hasExplicitDelta = typeof data.delta === "string";
        const text = projectChatDeltaText(hasExplicitDelta ? data.delta : data.text);
        let mode: "append" | "merge" | "replace" = "merge";
        if (data.replace === true) mode = "replace";
        else if (hasExplicitDelta) mode = "append";
        return text === undefined
            ? projectNoopEvent(event)
            : Object.freeze({
                  ...eventBase(event),
                  kind: "delta",
                  mode,
                  stream: data.phase === "commentary" ? "thinking" : "assistant",
                  text,
              });
    }
    if (payload.stream === "thinking") {
        const hasExplicitDelta = typeof data.delta === "string";
        const text = projectChatDeltaText(hasExplicitDelta ? data.delta : data.text);
        if (text === undefined) return projectNoopEvent(event);
        let mode: "append" | "merge" | "replace" = "merge";
        if (data.replace === true) mode = "replace";
        else if (hasExplicitDelta) mode = "append";
        return Object.freeze({
            ...eventBase(event),
            kind: "delta",
            mode,
            stream: "thinking",
            text,
        });
    }
    if (payload.stream === "tool") return projectToolEvent(event, data);
    if (payload.stream === "item") {
        if (data.kind === "preamble") {
            const text = projectChatDeltaText(data.progressText);
            if (text !== undefined) {
                return Object.freeze({
                    ...eventBase(event),
                    kind: "delta",
                    mode: "merge",
                    stream: "thinking",
                    text,
                });
            }
        }
        return projectItemEvent(event, data);
    }
    if (payload.stream === "plan") {
        if (data.phase !== "update") return projectNoopEvent(event);
        const explanation = projectPlanExplanation(data.explanation);
        return Object.freeze({
            ...eventBase(event),
            ...(explanation === undefined ? {} : { explanation }),
            kind: "plan",
            phase: "update",
            steps: projectPlanSteps(data.steps),
        });
    }
    if (payload.stream === "run_status") {
        const phase = boundedControlString(data.phase, 64)?.replaceAll("_", "-");
        if (
            phase !== "preparing-context" &&
            phase !== "preparing-workspace" &&
            phase !== "provisioning-environment" &&
            phase !== "starting-model"
        ) {
            return projectNoopEvent(event);
        }
        return Object.freeze({ ...eventBase(event), kind: "status", phase });
    }
    return projectNoopEvent(event);
}

class PersistentGatewayChatProviderImplementation implements ChatProvider {
    readonly #mediaReferences: PersistentGatewayChatMediaReferenceRegistrar;
    readonly #transport: PersistentGatewayChatProviderTransport;

    constructor(
        transport: PersistentGatewayChatProviderTransport,
        mediaReferences: PersistentGatewayChatMediaReferenceRegistrar
    ) {
        this.#mediaReferences = mediaReferences;
        this.#transport = transport;
    }

    async history(
        request: ChatProviderHistoryRequest,
        signal?: AbortSignal
    ): Promise<ChatProviderHistoryPage> {
        const payload = await requestRead(
            this.#transport,
            "chat.history",
            {
                limit: request.limit,
                maxChars: Math.min(
                    request.maxChars,
                    persistentGatewayChatHistoryMaximumChars
                ),
                offset: request.offset,
                sessionKey: request.sessionKey,
            },
            { signal, timeoutMs: persistentGatewayChatReadTimeoutMs }
        );
        const upstream = parseOrUnavailable(upstreamHistorySchema, payload);
        if (
            upstream.sessionKey !== request.sessionKey ||
            (upstream.offset ?? request.offset) !== request.offset
        ) {
            throw new ChatProviderUnavailableError();
        }
        if (upstream.messages.length > request.limit) {
            throw new ChatProviderUnavailableError();
        }
        const hasMore = upstream.hasMore === true;
        if (
            hasMore &&
            (upstream.nextOffset === undefined || upstream.nextOffset <= request.offset)
        ) {
            throw new ChatProviderUnavailableError();
        }
        const messages = Object.freeze(
            upstream.messages.map((message) =>
                projectHistoryMessage(message, request.sessionKey, this.#mediaReferences)
            )
        );
        return Object.freeze({
            hasMore,
            ...(upstream.inFlightRun === undefined
                ? {}
                : {
                      inFlightRun: Object.freeze({
                          ...(upstream.inFlightRun.plan === undefined ||
                          upstream.inFlightRun.plan.steps.length === 0
                              ? {}
                              : {
                                    plan: Object.freeze({
                                        ...(upstream.inFlightRun.plan.explanation ===
                                        undefined
                                            ? {}
                                            : {
                                                  explanation:
                                                      upstream.inFlightRun.plan
                                                          .explanation,
                                              }),
                                        steps: projectPlanSteps(
                                            upstream.inFlightRun.plan.steps
                                        ),
                                    }),
                                }),
                          runId: upstream.inFlightRun.runId,
                          text: upstream.inFlightRun.text,
                      }),
                  }),
            messages,
            ...(upstream.nextOffset === undefined
                ? {}
                : { nextOffset: upstream.nextOffset }),
            ...(upstream.sessionId === undefined
                ? {}
                : { sessionId: upstream.sessionId }),
        });
    }

    async getMessage(
        request: ChatProviderMessageRequest,
        signal?: AbortSignal
    ): Promise<ChatMessageGetOutput> {
        const payload = await requestRead(
            this.#transport,
            "chat.message.get",
            {
                maxChars: request.maxChars,
                messageId: request.messageId,
                sessionKey: request.sessionKey,
            },
            { signal, timeoutMs: persistentGatewayChatReadTimeoutMs }
        );
        const upstream = parseOrUnavailable(upstreamMessageGetSchema, payload);
        const output = upstream.ok
            ? (() => {
                  let message: ChatMessage;
                  try {
                      message = projectHistoryMessage(
                          upstream.message,
                          request.sessionKey,
                          this.#mediaReferences,
                          request.messageId
                      );
                  } catch (error) {
                      if (error instanceof ProjectedChatMessageOversizedError) {
                          return {
                              reason: "oversized" as const,
                              status: "unavailable" as const,
                          };
                      }
                      throw error;
                  }
                  if (message.id !== request.messageId) {
                      throw new ChatProviderUnavailableError();
                  }
                  return { message, status: "available" as const };
              })()
            : {
                  reason: chatMessageUnavailableReasons[upstream.unavailableReason],
                  status: "unavailable" as const,
              };
        return parseOrUnavailable(chatMessageGetOutputSchema, output);
    }

    async send(
        request: ChatProviderSendRequest,
        signal?: AbortSignal
    ): Promise<ChatProviderSendAcknowledgement> {
        const payload = await requestWrite(
            this.#transport,
            "chat.send",
            {
                attachments: request.attachments.map(
                    ({ content, fileName, mimeType, sizeBytes, type }) => ({
                        content,
                        fileName,
                        mimeType,
                        sizeBytes: sizeBytes ?? Buffer.from(content, "base64").byteLength,
                        type,
                    })
                ),
                ...(request.fastMode === undefined ? {} : { fastMode: request.fastMode }),
                idempotencyKey: request.idempotencyKey,
                message: request.message,
                ...(request.queueMode === undefined
                    ? {}
                    : { queueMode: request.queueMode }),
                sessionKey: request.sessionKey,
                ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
            },
            { signal, timeoutMs: persistentGatewayChatMutationTimeoutMs }
        );
        const acknowledgement = parsePersistentGatewayChatSendAcknowledgement(payload);
        if (
            acknowledgement === undefined ||
            acknowledgement.runId !== request.idempotencyKey
        ) {
            throw new ChatProviderUnknownOutcomeError();
        }
        return acknowledgement;
    }

    async abort(
        request: ChatProviderAbortRequest,
        signal?: AbortSignal
    ): Promise<ChatProviderAbortAcknowledgement> {
        const payload = await requestWrite(
            this.#transport,
            "chat.abort",
            {
                preserveSideRuns: false,
                ...(request.providerRunId === undefined
                    ? {}
                    : { runId: request.providerRunId }),
                sessionKey: request.sessionKey,
            },
            { signal, timeoutMs: persistentGatewayChatMutationTimeoutMs }
        );
        const acknowledgement = parseMutationAcknowledgement(
            upstreamAbortSchema,
            payload
        );
        if (new Set(acknowledgement.runIds).size !== acknowledgement.runIds.length) {
            throw new ChatProviderUnknownOutcomeError();
        }
        if (request.providerRunId !== undefined) {
            const exactRunAcknowledged = acknowledgement.runIds.includes(
                request.providerRunId
            );
            if (
                acknowledgement.runIds.some((runId) => runId !== request.providerRunId) ||
                acknowledgement.aborted !== exactRunAcknowledged
            ) {
                throw new ChatProviderUnknownOutcomeError();
            }
        } else if (acknowledgement.aborted !== acknowledgement.runIds.length > 0) {
            throw new ChatProviderUnknownOutcomeError();
        }
        return Object.freeze(acknowledgement);
    }

    async listModels(
        _request: Readonly<{
            includeProviderCapabilities: true;
            view: "configured";
        }>,
        signal?: AbortSignal
    ): Promise<ChatModelsListOutput> {
        const payload = await requestRead(
            this.#transport,
            "models.list",
            { includeProviderCapabilities: true, view: "configured" },
            { signal, timeoutMs: persistentGatewayChatReadTimeoutMs }
        );
        const upstream = parseOrUnavailable(upstreamModelsSchema, payload);
        const models = upstream.models
            .filter(({ available }) => available !== false)
            .map(({ id, name, provider }) => ({
                id: id.includes("/") ? id : `${provider}/${id}`,
                label: name,
                provider,
                // models.list exposes neither fast-mode support nor the exact
                // accepted thinking-level catalog for an individual model.
                supportsFastMode: false,
                thinkingLevels: [],
            }));
        return parseOrUnavailable(chatModelsListOutputSchema, { models });
    }

    async updateSessionSettings(
        input: Parameters<ChatProvider["updateSessionSettings"]>[0],
        signal?: AbortSignal
    ): Promise<ChatSessionSettingsOutput> {
        let payload: unknown;
        try {
            payload = await this.#transport.requestAdmin(
                "sessions.patch",
                {
                    ...(input.expectedSessionId === undefined
                        ? {}
                        : { expectedSessionId: input.expectedSessionId }),
                    ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }),
                    key: input.sessionKey,
                    ...(input.model === undefined ? {} : { model: input.model }),
                    ...(input.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: input.thinkingLevel }),
                },
                { signal, timeoutMs: persistentGatewayChatMutationTimeoutMs }
            );
        } catch (error) {
            return translateTransportFailure(error);
        }
        const upstream = parseMutationAcknowledgement(upstreamSettingsSchema, payload);
        if (
            upstream.key !== input.sessionKey ||
            (input.expectedSessionId !== undefined &&
                upstream.entry.sessionId !== input.expectedSessionId)
        ) {
            throw new ChatProviderUnknownOutcomeError();
        }
        const output = {
            fastMode: upstream.entry.fastMode,
            model: upstream.resolved?.model,
            sessionId: upstream.entry.sessionId,
            sessionKey: input.sessionKey,
            thinkingLevel:
                upstream.resolved?.thinkingLevel ?? upstream.entry.thinkingLevel,
        };
        const withoutUndefined = Object.fromEntries(
            Object.entries(output).filter(([, value]) => value !== undefined)
        );
        return parseMutationAcknowledgement(
            chatSessionSettingsOutputSchema,
            withoutUndefined
        );
    }

    async companionState(
        input: Parameters<ChatProvider["companionState"]>[0],
        signal?: AbortSignal
    ): ReturnType<ChatProvider["companionState"]> {
        const payload = await requestRead(
            this.#transport,
            "sessions.companion.state",
            { sessionKey: input.sessionKey },
            { signal, timeoutMs: persistentGatewayChatReadTimeoutMs }
        );
        const upstream = parseOrUnavailable(upstreamCompanionStateSchema, payload);
        return parseOrUnavailable(chatCompanionStateOutputSchema, {
            exchanges: upstream.exchanges.map(({ answer, question, ts }) => ({
                answer,
                question,
                timestampMs: ts,
            })),
        });
    }

    async companionAsk(
        input: Parameters<ChatProvider["companionAsk"]>[0],
        signal?: AbortSignal
    ): ReturnType<ChatProvider["companionAsk"]> {
        const payload = await requestReadMutation(
            this.#transport,
            "sessions.companion.ask",
            { question: input.question, sessionKey: input.sessionKey },
            { signal, timeoutMs: persistentGatewayChatMutationTimeoutMs }
        );
        const upstream = parseMutationAcknowledgement(
            upstreamCompanionAskSchema,
            payload
        );
        return parseMutationAcknowledgement(chatCompanionAskOutputSchema, {
            answer: upstream.answer,
            timestampMs: upstream.ts,
        });
    }

    async companionReset(
        input: Parameters<ChatProvider["companionReset"]>[0],
        signal?: AbortSignal
    ): ReturnType<ChatProvider["companionReset"]> {
        const payload = await requestWrite(
            this.#transport,
            "sessions.companion.reset",
            { sessionKey: input.sessionKey },
            { signal, timeoutMs: persistentGatewayChatMutationTimeoutMs }
        );
        parseMutationAcknowledgement(upstreamCompanionResetSchema, payload);
        return parseMutationAcknowledgement(chatCompanionResetOutputSchema, {
            reset: true,
        });
    }

    async subscribeChat(
        request: ChatEventSubscriptionRequest,
        signal?: AbortSignal
    ): Promise<ChatEventSubscription> {
        if (signal?.aborted === true) throw new ChatProviderUnavailableError();
        let closed = false;
        let reconciliationBoundary = false;
        const unsubscribe = this.#transport.subscribeChat(
            {
                ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
                runWatermarks: request.runWatermarks,
                sessionKey: request.sessionKey,
            },
            {
                onEvent: async (event) => {
                    if (reconciliationBoundary) return;
                    try {
                        const projected = projectProviderEvent(event);
                        await request.onEvent(projected);
                    } catch (error) {
                        if (
                            !(
                                error instanceof
                                ChatProviderEventReconciliationRequiredError
                            )
                        ) {
                            throw error;
                        }
                        reconciliationBoundary = true;
                        await request.onReconciliationRequired("backpressure");
                    }
                },
                onEventGap: (gap) => {
                    reconciliationBoundary = true;
                    return request.onGap({
                        expectedSequence: gap.expectedSequence,
                        providerRunId: gap.runId,
                        receivedSequence: gap.receivedSequence,
                        sessionKey: gap.sessionKey,
                    });
                },
                onReconciliationRequired: (reason) => {
                    reconciliationBoundary = true;
                    return request.onReconciliationRequired(reason);
                },
            }
        );
        const close = (): Promise<void> => {
            if (closed) return Promise.resolve();
            closed = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
            return Promise.resolve();
        };
        const onAbort = (): void => void close();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (abortSignalIsAborted(signal)) await close();
        return Object.freeze({ close });
    }
}

/**
 * Creates the only high-level chat provider backed by the persistent transport.
 * @param transport Narrow audited Gateway transport.
 * @param mediaReferences Registrar for transcript-associated media references.
 * @returns Provider implementation consumed by the chat domain.
 */
export function createPersistentGatewayChatProvider(
    transport: PersistentGatewayChatProviderTransport,
    mediaReferences: PersistentGatewayChatMediaReferenceRegistrar
): ChatProvider {
    return new PersistentGatewayChatProviderImplementation(transport, mediaReferences);
}
