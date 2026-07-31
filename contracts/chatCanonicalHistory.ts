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
    provider: canonicalChatProviderMetadataSchema,
    schemaVersion: v.literal(CANONICAL_CHAT_HISTORY_SCHEMA_VERSION),
    sequence: v.optional(nonNegativeIntegerSchema),
    sessionKey: nonEmptyStringSchema,
    source: v.literal("openclaw-history"),
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

export type CanonicalChatHistoryRow = v.InferOutput<typeof canonicalChatHistoryRowSchema>;
export type CanonicalChatHistoryPage = v.InferOutput<
    typeof canonicalChatHistoryPageSchema
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
