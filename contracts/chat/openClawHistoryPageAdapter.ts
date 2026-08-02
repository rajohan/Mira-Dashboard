import type { CanonicalChatMessage, CanonicalChatProviderMetadata } from "./canonical";
import {
    CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
    parseCanonicalChatHistoryMessageResult,
    parseCanonicalChatHistoryPage,
    type CanonicalChatHistoryMessageResult,
    type CanonicalChatHistoryPage,
    type CanonicalChatHistoryRow,
} from "./canonicalHistory";
import {
    canonicalChatContentFingerprint,
    summarizeCanonicalChatValueForFingerprint,
} from "./canonicalMessage";
import { stableCanonicalChatStringify } from "./canonicalUtilities";
import {
    normalizeOpenClawHistoryMessage,
    type RawOpenClawHistoryMessage,
} from "./openClawHistoryNormalizer";

interface CanonicalizeOpenClawHistoryPageOptions {
    messageId?: string;
    offset: number;
    sessionKey: string;
}

interface CanonicalizeOpenClawHistoryMessageOptions {
    messageId: string;
    sessionKey: string;
}

const CHAT_HISTORY_TRUNCATION_SUFFIX = "\n...(truncated)...";
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function historyProvider(
    message: RawOpenClawHistoryMessage,
    eventName = "chat.history"
): CanonicalChatProviderMetadata {
    return {
        eventName,
        format: "openclaw-history",
        model: stringValue(message.model),
        provider: stringValue(message.provider),
    };
}

function historyRowId(
    sessionKey: string,
    message: RawOpenClawHistoryMessage,
    canonicalMessage: CanonicalChatMessage,
    metadata: Record<string, unknown> | undefined,
    fallbackPosition: number,
    explicitMessageId?: string
): string {
    const providerId = explicitMessageId || stringValue(metadata?.id);
    const providerSequence = nonNegativeInteger(metadata?.seq);
    let sourceId = providerId;
    if (!sourceId) {
        const fingerprint = canonicalChatContentFingerprint(
            stableCanonicalChatStringify({
                content: canonicalMessage.content,
                idempotencyKey: stringValue(message.idempotencyKey),
                isError: message.isError,
                mediaPath: summarizeCanonicalChatValueForFingerprint(message.MediaPath),
                mediaPaths: summarizeCanonicalChatValueForFingerprint(message.MediaPaths),
                mediaType: summarizeCanonicalChatValueForFingerprint(message.MediaType),
                mediaTypes: summarizeCanonicalChatValueForFingerprint(message.MediaTypes),
                role: message.role,
                runId: message.runId,
                stopReason: message.stopReason,
                text: message.text,
                timestamp: message.timestamp,
                toolCallId: message.toolCallId ?? message.tool_call_id,
                toolName: message.toolName ?? message.tool_name,
            })
        );
        sourceId =
            providerSequence === undefined
                ? `position:${fallbackPosition}:fingerprint:${fingerprint}`
                : `sequence:${providerSequence}:fingerprint:${fingerprint}`;
    }
    return `openclaw-history:${encodeURIComponent(sessionKey)}:${encodeURIComponent(
        sourceId
    )}`;
}

function canonicalHistoryRow(
    sessionKey: string,
    message: RawOpenClawHistoryMessage,
    fallbackPosition: number,
    options: {
        eventName?: string;
        messageId?: string;
        truncated?: boolean;
    } = {}
): CanonicalChatHistoryRow {
    const metadata = asRecord(message.__openclaw);
    const canonicalMessage = normalizeOpenClawHistoryMessage(message);
    const messageId = options.messageId || stringValue(metadata?.id);
    const role = canonicalMessage.role.toLowerCase();
    const isPrimaryTranscriptMessage = ["assistant", "system", "user"].includes(role);
    const normalizedText = canonicalMessage.text.trimEnd();
    const isLightweightPreview =
        isPrimaryTranscriptMessage &&
        (normalizedText.endsWith(CHAT_HISTORY_TRUNCATION_SUFFIX.trimStart()) ||
            normalizedText === CHAT_HISTORY_OVERSIZED_PLACEHOLDER);
    const isProviderTruncated = metadata?.truncated === true;
    return {
        id: historyRowId(
            sessionKey,
            message,
            canonicalMessage,
            metadata,
            fallbackPosition,
            messageId
        ),
        message: canonicalMessage,
        messageId,
        provider: historyProvider(message, options.eventName),
        schemaVersion: CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
        sequence: nonNegativeInteger(metadata?.seq),
        sessionKey,
        source: "openclaw-history",
        truncated:
            options.truncated ??
            (isProviderTruncated || isLightweightPreview || undefined),
    };
}

/**
 * Converts one raw Gateway chat.history response into the Dashboard contract.
 * @param raw Raw Gateway response.
 * @param options Requested session identity and page offset.
 * @returns Versioned provider-independent history page.
 */
export function canonicalizeOpenClawHistoryPage(
    raw: unknown,
    options: CanonicalizeOpenClawHistoryPageOptions
): CanonicalChatHistoryPage {
    const page = asRecord(raw);
    const sessionKey = options.sessionKey.trim();
    if (!sessionKey) {
        throw new Error("OpenClaw chat history session key is required");
    }
    const hasResponseOffset = Boolean(page && Object.hasOwn(page, "offset"));
    const responseOffset = nonNegativeInteger(page?.offset);
    if (hasResponseOffset && responseOffset === undefined) {
        throw new Error("OpenClaw chat history offset is invalid");
    }
    const isAnchoredWindow = Boolean(options.messageId?.trim());
    const isFirstPage = options.offset === 0;
    const isCompleteSnapshot =
        page?.completeSnapshot === true &&
        page?.hasMore !== true &&
        nonNegativeInteger(page?.nextOffset) === undefined;
    if (
        (responseOffset === undefined &&
            !isFirstPage &&
            !isCompleteSnapshot &&
            !isAnchoredWindow) ||
        (responseOffset !== undefined && responseOffset !== options.offset)
    ) {
        throw new Error(
            `OpenClaw chat history offset mismatch: requested ${options.offset}, received ${
                responseOffset ?? "missing"
            }`
        );
    }
    const pageOffset = responseOffset ?? options.offset;
    const rawMessages = Array.isArray(page?.messages)
        ? page.messages.filter(
              (message): message is RawOpenClawHistoryMessage =>
                  asRecord(message) !== undefined
          )
        : [];
    const messages = rawMessages.map((message, index) =>
        canonicalHistoryRow(
            sessionKey,
            message,
            pageOffset + rawMessages.length - index - 1
        )
    );
    return parseCanonicalChatHistoryPage({
        hasMore: page?.hasMore === true,
        messages,
        nextOffset: nonNegativeInteger(page?.nextOffset),
        offset: pageOffset,
        schemaVersion: CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
        sessionId: stringValue(page?.sessionId),
        sessionKey,
        totalMessages: nonNegativeInteger(page?.totalMessages),
    });
}

/**
 * Converts one raw Gateway chat.message.get response into the Dashboard contract.
 * @param raw Raw Gateway response.
 * @param options Requested transcript and message identity.
 * @returns Versioned provider-independent full-message response.
 */
export function canonicalizeOpenClawHistoryMessageResult(
    raw: unknown,
    options: CanonicalizeOpenClawHistoryMessageOptions
): CanonicalChatHistoryMessageResult {
    const result = asRecord(raw);
    const sessionKey = options.sessionKey.trim();
    const messageId = options.messageId.trim();
    if (!sessionKey || !messageId) {
        throw new Error("OpenClaw full chat message identity is required");
    }
    if (result?.ok !== true) {
        const unavailableReason = result?.unavailableReason;
        if (
            unavailableReason !== "not_found" &&
            unavailableReason !== "not_visible" &&
            unavailableReason !== "oversized"
        ) {
            throw new Error("OpenClaw full chat message unavailable reason is invalid");
        }
        return parseCanonicalChatHistoryMessageResult({
            ok: false,
            schemaVersion: CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
            unavailableReason,
        });
    }
    const message = asRecord(result.message) as RawOpenClawHistoryMessage | undefined;
    if (!message) {
        throw new Error("OpenClaw full chat message is missing");
    }
    const responseMessageId = stringValue(asRecord(message.__openclaw)?.id);
    if (responseMessageId !== messageId) {
        throw new Error("OpenClaw full chat message identity is invalid");
    }
    return parseCanonicalChatHistoryMessageResult({
        message: canonicalHistoryRow(sessionKey, message, 0, {
            eventName: "chat.message.get",
            messageId,
            truncated: false,
        }),
        ok: true,
        schemaVersion: CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
    });
}
