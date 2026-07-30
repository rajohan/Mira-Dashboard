import type { CanonicalChatProviderMetadata } from "../chatCanonical";
import {
    CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
    parseCanonicalChatHistoryPage,
    type CanonicalChatHistoryPage,
    type CanonicalChatHistoryRow,
} from "../chatCanonicalHistory";
import { canonicalChatContentFingerprint } from "../chatCanonicalMessage";
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
    metadata: Record<string, unknown> | undefined
): string {
    const providerId = stringValue(metadata?.id);
    const sourceId =
        providerId ||
        `fingerprint:${canonicalChatContentFingerprint(
            stableCanonicalChatStringify({
                content: message.content,
                isError: message.isError,
                role: message.role,
                runId: message.runId,
                stopReason: message.stopReason,
                text: message.text,
                timestamp: message.timestamp,
                toolCallId: message.toolCallId ?? message.tool_call_id,
                toolName: message.toolName ?? message.tool_name,
            })
        )}`;
    return `openclaw-history:${encodeURIComponent(sessionKey)}:${encodeURIComponent(
        sourceId
    )}`;
}

function canonicalHistoryRow(
    sessionKey: string,
    message: RawOpenClawHistoryMessage
): CanonicalChatHistoryRow {
    const metadata = asRecord(message.__openclaw);
    return {
        id: historyRowId(sessionKey, message, metadata),
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
    const messages = Array.isArray(page?.messages)
        ? page.messages
              .filter(
                  (message): message is RawOpenClawHistoryMessage =>
                      asRecord(message) !== undefined
              )
              .map((message) => canonicalHistoryRow(sessionKey, message))
        : [];
    return parseCanonicalChatHistoryPage({
        hasMore: page?.hasMore === true,
        messages,
        nextOffset: nonNegativeInteger(page?.nextOffset),
        offset: nonNegativeInteger(page?.offset) ?? options.offset,
        schemaVersion: CANONICAL_CHAT_HISTORY_SCHEMA_VERSION,
        sessionId: stringValue(page?.sessionId),
        sessionKey,
        totalMessages: nonNegativeInteger(page?.totalMessages),
    });
}
