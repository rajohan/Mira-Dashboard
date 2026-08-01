import * as v from "valibot";

import {
    canonicalChatMessageSchema,
    canonicalChatProviderMetadataSchema,
} from "./chatCanonical";
import { nonNegativeIntegerSchema, parseContract } from "./runtime";

export const CANONICAL_CHAT_HISTORY_SCHEMA_VERSION = 1;

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const canonicalChatHistoryRowSchema = v.strictObject({
    id: nonEmptyStringSchema,
    message: canonicalChatMessageSchema,
    messageId: v.optional(nonEmptyStringSchema),
    provider: canonicalChatProviderMetadataSchema,
    schemaVersion: v.literal(CANONICAL_CHAT_HISTORY_SCHEMA_VERSION),
    sequence: v.optional(nonNegativeIntegerSchema),
    sessionKey: nonEmptyStringSchema,
    source: v.literal("openclaw-history"),
    truncated: v.optional(v.boolean()),
});

export const canonicalChatHistoryPageSchema = v.strictObject({
    hasMore: v.boolean(),
    messages: v.array(canonicalChatHistoryRowSchema),
    nextOffset: v.optional(nonNegativeIntegerSchema),
    offset: nonNegativeIntegerSchema,
    schemaVersion: v.literal(CANONICAL_CHAT_HISTORY_SCHEMA_VERSION),
    sessionId: v.optional(nonEmptyStringSchema),
    sessionKey: nonEmptyStringSchema,
    totalMessages: v.optional(nonNegativeIntegerSchema),
});

export const canonicalChatHistoryMessageResultSchema = v.union([
    v.strictObject({
        message: canonicalChatHistoryRowSchema,
        ok: v.literal(true),
        schemaVersion: v.literal(CANONICAL_CHAT_HISTORY_SCHEMA_VERSION),
    }),
    v.strictObject({
        ok: v.literal(false),
        schemaVersion: v.literal(CANONICAL_CHAT_HISTORY_SCHEMA_VERSION),
        unavailableReason: v.picklist(["not_found", "not_visible", "oversized"]),
    }),
]);

export type CanonicalChatHistoryRow = v.InferOutput<typeof canonicalChatHistoryRowSchema>;
export type CanonicalChatHistoryPage = v.InferOutput<
    typeof canonicalChatHistoryPageSchema
>;
export type CanonicalChatHistoryMessageResult = v.InferOutput<
    typeof canonicalChatHistoryMessageResultSchema
>;

/**
 * Parses one canonical history page at a transport boundary.
 * @param value Value to validate.
 * @param path Contract path used in validation errors.
 * @returns Validated canonical history page.
 */
export function parseCanonicalChatHistoryPage(
    value: unknown,
    path = "chatHistory"
): CanonicalChatHistoryPage {
    return parseContract(canonicalChatHistoryPageSchema, value, path);
}

/**
 * Parses one canonical full-message response at a transport boundary.
 * @param value Value to validate.
 * @param path Contract path used in validation errors.
 * @returns Validated canonical full-message response.
 */
export function parseCanonicalChatHistoryMessageResult(
    value: unknown,
    path = "chatHistoryMessage"
): CanonicalChatHistoryMessageResult {
    return parseContract(canonicalChatHistoryMessageResultSchema, value, path);
}
