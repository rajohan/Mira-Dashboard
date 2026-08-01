import * as v from "valibot";

import {
    canonicalChatMessageSchema,
    canonicalChatProviderMetadataSchema,
} from "./chatCanonical";
import { nonNegativeIntegerSchema, parseContract } from "./runtime";

export const CANONICAL_CHAT_TURN_SCHEMA_VERSION = 1;

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const canonicalChatTurnEntrySourceSchema = v.picklist([
    "dashboard-optimistic",
    "openclaw-history",
    "openclaw-runtime",
    "reconciled",
]);
const canonicalChatTurnSourceReferenceSchema = v.strictObject({
    id: nonEmptyStringSchema,
    origin: v.optional(
        v.picklist(["openclaw-chat", "openclaw-runtime", "openclaw-session"])
    ),
    provider: v.optional(canonicalChatProviderMetadataSchema),
    sequence: v.optional(nonNegativeIntegerSchema),
    source: canonicalChatTurnEntrySourceSchema,
});

export const canonicalChatTurnEntrySchema = v.strictObject({
    id: nonEmptyStringSchema,
    kind: v.picklist(["assistant", "commentary", "control", "thinking", "tool", "user"]),
    message: canonicalChatMessageSchema,
    origin: v.optional(
        v.picklist(["openclaw-chat", "openclaw-runtime", "openclaw-session"])
    ),
    provider: v.optional(canonicalChatProviderMetadataSchema),
    relatedSources: v.optional(v.array(canonicalChatTurnSourceReferenceSchema)),
    sequence: v.optional(nonNegativeIntegerSchema),
    source: canonicalChatTurnEntrySourceSchema,
});

export const canonicalChatTurnSchema = v.strictObject({
    entries: v.pipe(v.array(canonicalChatTurnEntrySchema), v.minLength(1)),
    id: nonEmptyStringSchema,
    lifecycle: v.picklist(["aborted", "active", "completed", "error", "unknown"]),
    providers: v.optional(v.array(canonicalChatProviderMetadataSchema)),
    runAliases: v.optional(v.array(nonEmptyStringSchema)),
    runId: v.optional(nonEmptyStringSchema),
    schemaVersion: v.literal(CANONICAL_CHAT_TURN_SCHEMA_VERSION),
    sequenceEnd: v.optional(nonNegativeIntegerSchema),
    sequenceStart: v.optional(nonNegativeIntegerSchema),
    sessionKey: nonEmptyStringSchema,
    startedAt: v.optional(nonEmptyStringSchema),
    terminalAt: v.optional(nonEmptyStringSchema),
});

export type CanonicalChatTurnEntry = v.InferOutput<typeof canonicalChatTurnEntrySchema>;
export type CanonicalChatTurnSourceReference = v.InferOutput<
    typeof canonicalChatTurnSourceReferenceSchema
>;
export type CanonicalChatTurn = v.InferOutput<typeof canonicalChatTurnSchema>;

/**
 * Parses provider-independent canonical chat turns at a trust boundary.
 * @param value Value to validate.
 * @param path Contract path used in validation errors.
 * @returns Validated canonical chat turns.
 */
export function parseCanonicalChatTurns(
    value: unknown,
    path = "canonicalChatTurns"
): CanonicalChatTurn[] {
    return parseContract(v.array(canonicalChatTurnSchema), value, path);
}
