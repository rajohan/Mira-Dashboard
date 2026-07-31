import * as v from "valibot";

import { nonNegativeIntegerSchema, parseContract } from "./runtime";

export const CANONICAL_CHAT_EVENT_SCHEMA_VERSION = 1;

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const canonicalChatImageSchema = v.object({
    alt: v.optional(v.string()),
    data: v.optional(v.string()),
    image_url: v.optional(
        v.union([
            v.string(),
            v.object({
                url: v.optional(v.string()),
            }),
        ])
    ),
    mimeType: v.optional(v.string()),
    openUrl: v.optional(v.string()),
    source: v.optional(
        v.object({
            data: v.optional(v.string()),
            media_type: v.optional(v.string()),
            type: v.optional(v.string()),
            url: v.optional(v.string()),
        })
    ),
    type: v.picklist(["image", "image_url", "input_image"]),
    url: v.optional(v.string()),
});

export const canonicalChatAttachmentSchema = v.strictObject({
    contentBase64: v.optional(v.string()),
    dataUrl: v.optional(v.string()),
    fileName: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
    kind: v.picklist(["file", "image", "text"]),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(nonNegativeIntegerSchema),
    url: v.optional(v.string()),
});

export const canonicalChatThinkingSchema = v.strictObject({
    id: v.optional(nonEmptyStringSchema),
    snapshot: v.optional(v.boolean()),
    text: v.string(),
});

export const canonicalChatToolResultSchema = v.strictObject({
    content: v.string(),
    id: v.optional(nonEmptyStringSchema),
    images: v.optional(v.array(canonicalChatImageSchema)),
    isError: v.optional(v.boolean()),
    isPlaceholder: v.optional(v.boolean()),
    name: v.optional(nonEmptyStringSchema),
});

export const canonicalChatToolCallSchema = v.strictObject({
    arguments: v.optional(v.unknown()),
    id: v.optional(nonEmptyStringSchema),
    name: nonEmptyStringSchema,
    toolResult: v.optional(canonicalChatToolResultSchema),
});

export const canonicalChatMessageSchema = v.strictObject({
    attachments: v.optional(v.array(canonicalChatAttachmentSchema)),
    content: v.unknown(),
    hasOnlyHiddenToolAttachments: v.optional(v.boolean()),
    images: v.optional(v.array(canonicalChatImageSchema)),
    isFinal: v.optional(v.boolean()),
    isToolUse: v.optional(v.boolean()),
    local: v.optional(v.boolean()),
    role: nonEmptyStringSchema,
    runId: v.optional(nonEmptyStringSchema),
    runtimeKey: v.optional(nonEmptyStringSchema),
    runtimeSequence: v.optional(nonNegativeIntegerSchema),
    text: v.string(),
    thinking: v.optional(v.array(canonicalChatThinkingSchema)),
    timestamp: v.optional(nonEmptyStringSchema),
    toolCalls: v.optional(v.array(canonicalChatToolCallSchema)),
    toolResult: v.optional(canonicalChatToolResultSchema),
});

const canonicalProviderMetadataSchema = v.strictObject({
    eventName: nonEmptyStringSchema,
    format: v.picklist([
        "openclaw-agent",
        "openclaw-chat",
        "openclaw-runtime",
        "openclaw-session-message",
        "openclaw-session-tool",
    ]),
    model: v.optional(nonEmptyStringSchema),
    provider: v.optional(nonEmptyStringSchema),
    state: v.optional(nonEmptyStringSchema),
    stream: v.optional(nonEmptyStringSchema),
});

const canonicalEventBase = {
    id: nonEmptyStringSchema,
    lifecycle: v.picklist(["aborted", "active", "completed", "error"]),
    origin: v.picklist(["openclaw-chat", "openclaw-runtime", "openclaw-session"]),
    provider: canonicalProviderMetadataSchema,
    runAliases: v.optional(v.array(nonEmptyStringSchema)),
    runId: v.optional(nonEmptyStringSchema),
    schemaVersion: v.literal(CANONICAL_CHAT_EVENT_SCHEMA_VERSION),
    sequence: nonNegativeIntegerSchema,
    sessionKey: nonEmptyStringSchema,
    timestamp: nonEmptyStringSchema,
};

export const canonicalChatEventSchema = v.variant("kind", [
    v.strictObject({
        ...canonicalEventBase,
        kind: v.literal("identity"),
    }),
    v.strictObject({
        ...canonicalEventBase,
        kind: v.literal("user"),
        message: canonicalChatMessageSchema,
    }),
    v.strictObject({
        ...canonicalEventBase,
        kind: v.literal("assistant"),
        message: canonicalChatMessageSchema,
        mode: v.picklist(["append", "merge", "replace"]),
        source: v.picklist(["chat", "runtime", "session"]),
    }),
    v.strictObject({
        ...canonicalEventBase,
        kind: v.literal("thinking"),
        message: canonicalChatMessageSchema,
    }),
    v.strictObject({
        ...canonicalEventBase,
        kind: v.literal("tool"),
        message: canonicalChatMessageSchema,
        toolKey: nonEmptyStringSchema,
    }),
    v.strictObject({
        ...canonicalEventBase,
        kind: v.literal("status"),
        operation: v.optional(v.literal("compact")),
        operationPhase: v.optional(
            v.picklist(["active", "complete", "inactive", "retrying"])
        ),
        text: v.optional(v.string()),
    }),
    v.strictObject({
        ...canonicalEventBase,
        authoritative: v.optional(v.boolean()),
        error: v.optional(v.string()),
        kind: v.literal("finish"),
        message: v.optional(canonicalChatMessageSchema),
        outcome: v.picklist(["aborted", "completed", "error"]),
        settlesCompactionRunId: v.optional(nonEmptyStringSchema),
        toolFailure: v.optional(v.boolean()),
    }),
]);

export type CanonicalChatImage = v.InferOutput<typeof canonicalChatImageSchema>;
export type CanonicalChatAttachment = v.InferOutput<typeof canonicalChatAttachmentSchema>;
export type CanonicalChatThinking = v.InferOutput<typeof canonicalChatThinkingSchema>;
export type CanonicalChatToolResult = v.InferOutput<typeof canonicalChatToolResultSchema>;
export type CanonicalChatToolCall = v.InferOutput<typeof canonicalChatToolCallSchema>;
export type CanonicalChatMessage = v.InferOutput<typeof canonicalChatMessageSchema>;
export type CanonicalChatEvent = v.InferOutput<typeof canonicalChatEventSchema>;
export type CanonicalChatLifecycle = CanonicalChatEvent["lifecycle"];
export type CanonicalChatOperationPhase = Extract<
    CanonicalChatEvent,
    { kind: "status" }
>["operationPhase"];

/**
 * Parses one provider-independent canonical chat event at a trust boundary.
 * @param value Value to validate.
 * @param path Contract path used in validation errors.
 * @returns Validated canonical chat event.
 */
export function parseCanonicalChatEvent(
    value: unknown,
    path = "canonicalChatEvent"
): CanonicalChatEvent {
    return parseContract(canonicalChatEventSchema, value, path);
}

/**
 * Parses provider-independent canonical chat events at a trust boundary.
 * @param value Value to validate.
 * @param path Contract path used in validation errors.
 * @returns Validated canonical chat events.
 */
export function parseCanonicalChatEvents(
    value: unknown,
    path = "canonicalChatEvents"
): CanonicalChatEvent[] {
    return parseContract(v.array(canonicalChatEventSchema), value, path);
}
