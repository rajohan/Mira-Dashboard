import type { CanonicalChatProviderMetadata } from "../chatCanonical";
import {
    CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
    parseCanonicalChatHistoryPage,
    type CanonicalChatHistoryPage,
    type CanonicalChatHistoryRow,
} from "../chatCanonicalHistory";
import {
    canonicalChatContentFingerprint,
    summarizeCanonicalChatValueForFingerprint,
} from "../chatCanonicalMessage";
import { stableCanonicalChatStringify } from "../chatCanonicalUtilities";
import {
    normalizeOpenClawHistoryMessage,
    type RawOpenClawHistoryMessage,
} from "./openClawHistoryNormalizer";

interface CanonicalizeOpenClawHistoryPageOptions {
    offset: number;
    sessionKey: string;
}

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
    message: RawOpenClawHistoryMessage
): CanonicalChatProviderMetadata {
    return {
        eventName: "chat.history",
        format: "openclaw-history",
        model: stringValue(message.model),
        provider: stringValue(message.provider),
    };
}

function historyRowId(
    sessionKey: string,
    message: RawOpenClawHistoryMessage,
    metadata: Record<string, unknown> | undefined,
    fallbackPosition: number
): string {
    const providerId = stringValue(metadata?.id);
    const providerSequence = nonNegativeInteger(metadata?.seq);
    const sourceId =
        providerId ||
        (providerSequence === undefined
            ? `position:${fallbackPosition}:fingerprint:${canonicalChatContentFingerprint(
                  stableCanonicalChatStringify({
                      content: summarizeCanonicalChatValueForFingerprint(message.content),
                      isError: message.isError,
                      role: message.role,
                      runId: message.runId,
                      stopReason: message.stopReason,
                      text: message.text,
                      timestamp: message.timestamp,
                      toolCallId: message.toolCallId ?? message.tool_call_id,
                      toolName: message.toolName ?? message.tool_name,
                  })
              )}`
            : `sequence:${providerSequence}`);
    return `openclaw-history:${encodeURIComponent(sessionKey)}:${encodeURIComponent(
        sourceId
    )}`;
}

function canonicalHistoryRow(
    sessionKey: string,
    message: RawOpenClawHistoryMessage,
    fallbackPosition: number
): CanonicalChatHistoryRow {
    const metadata = asRecord(message.__openclaw);
    return {
        id: historyRowId(sessionKey, message, metadata, fallbackPosition),
        message: normalizeOpenClawHistoryMessage(message),
        provider: historyProvider(message),
        schemaVersion: CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
        sequence: nonNegativeInteger(metadata?.seq),
        sessionKey,
        source: "openclaw-history",
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
    const responseOffset = nonNegativeInteger(page?.offset);
    const isCompleteSnapshot =
        page?.completeSnapshot === true &&
        page?.hasMore !== true &&
        nonNegativeInteger(page?.nextOffset) === undefined;
    if (
        (responseOffset === undefined && !isCompleteSnapshot) ||
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
