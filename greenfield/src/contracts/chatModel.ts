import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import {
    boundedControlSafeTextSchema,
    boundedNonBlankTextSchema,
    canonicalNonnegativeSafeIntegerStringSchema,
    hasNoNulCharacter,
    hasUniqueArrayItems,
    lowercaseUuidV7Schema,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import { chatAttachmentTicketIdSchema } from "./chatMedia.ts";
import { gatewaySessionKeySchema } from "./gatewaySessions.ts";
import { jobIdempotencyKeySchema } from "./jobModel.ts";

export const chatHistoryPageDefault = 50;
export const chatHistoryPageMaximum = 100;
/** Shared browser-retention and media-reference rehydration page ceiling. */
export const chatHistoryRetainedPageMaximum = 5;
export const chatHistoryResponseMaximumBytes = 512 * 1024;
export const chatHistoryProviderPageMaximum = 2;
export const chatMessageHydrationMaximumBytes = 1024 * 1024;
export const chatRuntimePageDefault = 128;
export const chatRuntimePageMinimum = 128;
export const chatRuntimePageMaximum = 256;
/** A larger same-session backlog is replaced by one authoritative snapshot response. */
export const chatRuntimeCatchUpMaximumEvents = 256;

/**
 * Normalizes OpenClaw's user-carrier suffix to Dashboard's canonical send identity.
 * @param value Candidate identity from canonical history or provider runtime.
 * @returns Canonical idempotency identity, or undefined for an unsupported value.
 */
export function normalizeChatProviderUserIdentity(value: unknown): string | undefined {
    const direct = v.safeParse(jobIdempotencyKeySchema, value);
    if (direct.success) return direct.output;
    if (typeof value !== "string" || !value.endsWith(":user")) return undefined;
    const base = v.safeParse(jobIdempotencyKeySchema, value.slice(0, -":user".length));
    return base.success ? base.output : undefined;
}
export const chatRuntimeCatchUpMaximumPages = 2;
export const chatRuntimeResponseMaximumBytes = 1024 * 1024;
/** Leaves room for the bounded provider-origin projection added by ChatService. */
export const chatRuntimeExternalProjectionReserveBytes = 64 * 1024;
export const chatRuntimeDurableResponseMaximumBytes =
    chatRuntimeResponseMaximumBytes - chatRuntimeExternalProjectionReserveBytes;
export const chatRuntimeSnapshotMaximumBytes = 512 * 1024;
export const chatRuntimeProjectionPartsMaximum = 512;
export const chatRunEventMaximum = 4096;
export const chatRunEventBytesMaximum = 1024 * 1024;
/** One immutable journal row must leave most of the per-run journal available. */
export const chatRunEventPayloadMaximumBytes = 256 * 1024;
/** Durable admission JSON remains below the database's independent hard ceiling. */
export const chatRunRequestMaximumBytes = 256 * 1024;
/**
 * A send intent spends at most half of the durable request ceiling. Its derived
 * user event therefore fits one row while leaving at least three quarters of
 * the aggregate journal budget for provider/runtime events.
 */
export const chatSendInputMaximumBytes = 128 * 1024;
export const chatActiveRunsPerSessionMaximum = 8;
export const chatActiveRunsPerProcessMaximum = 32;
export const chatExternalRunsPerSessionMaximum = 8;
export const chatExternalRunsPerProcessMaximum = 32;
export const chatDeltaCoalescingMilliseconds = 150;
export const chatMessageTextMaximumCodeUnits = 256 * 1024;

export const chatRunStates = [
    "active",
    "admitted",
    "cancel-requested",
    "cancelled",
    "completed",
    "failed",
    "interrupted",
    "outcome-unknown",
    "unresolved",
] as const;

export const chatActiveRunStates = [
    "active",
    "admitted",
    "cancel-requested",
    "interrupted",
    "outcome-unknown",
] as const;

export type ChatRunState = (typeof chatRunStates)[number];

export const chatRunStateSchema = v.picklist(chatRunStates, "Chat run state is invalid");
export const chatRunIdSchema = lowercaseUuidV7Schema("Chat run id is invalid");
export const chatProviderRunIdSchema = boundedControlSafeTextSchema(
    256,
    "Chat provider run id is invalid"
);
export const chatMessageIdSchema = boundedControlSafeTextSchema(
    256,
    "Chat message id is invalid"
);
export const chatRuntimeCursorSchema = canonicalNonnegativeSafeIntegerStringSchema(
    "Chat runtime cursor is invalid"
);
export const chatRuntimeEventSequenceSchema = v.pipe(
    positiveSafeIntegerSchema("Chat runtime sequence is invalid"),
    v.maxValue(chatRunEventMaximum, "Chat runtime sequence is outside its budget")
);
const chatProviderSequenceSchema = positiveSafeIntegerSchema(
    "Chat provider sequence is invalid"
);
const chatProjectionStreamIdSchema = boundedControlSafeTextSchema(
    512,
    "Chat projection stream id is invalid"
);
const chatProjectionSegmentIdSchema = boundedControlSafeTextSchema(
    512,
    "Chat projection segment id is invalid"
);

function boundedChatTextSchema(maximumCodeUnits: number, message: string) {
    return v.pipe(
        v.string(message),
        v.maxLength(maximumCodeUnits, message),
        v.check(hasNoNulCharacter, message)
    );
}

export const chatMessageTextSchema = boundedChatTextSchema(
    chatMessageTextMaximumCodeUnits,
    "Chat message text is invalid"
);
export const chatDeltaTextSchema = boundedChatTextSchema(
    64 * 1024,
    "Chat delta text is invalid"
);
const chatDiagnosticTextSchema = boundedChatTextSchema(
    32 * 1024,
    "Chat diagnostic text is invalid"
);
const chatPreviewTextSchema = boundedChatTextSchema(
    4096,
    "Chat message preview is invalid"
);
const chatPartIdSchema = boundedControlSafeTextSchema(256, "Chat part id is invalid");
const chatToolNameSchema = boundedControlSafeTextSchema(200, "Chat tool name is invalid");
const chatToolCallIdSchema = boundedControlSafeTextSchema(
    256,
    "Chat tool call id is invalid"
);
const chatProviderLabelSchema = boundedControlSafeTextSchema(
    128,
    "Chat provider label is invalid"
);
const chatModelLabelSchema = boundedControlSafeTextSchema(
    256,
    "Chat model label is invalid"
);

const chatMessagePartVariantSchema = v.variant("kind", [
    v.strictObject({
        id: chatPartIdSchema,
        kind: v.literal("text"),
        text: chatMessageTextSchema,
    }),
    v.strictObject({
        id: chatPartIdSchema,
        kind: v.literal("thinking"),
        text: chatMessageTextSchema,
    }),
    v.strictObject({
        callId: chatToolCallIdSchema,
        callIdSource: v.optional(v.literal("synthetic")),
        id: chatPartIdSchema,
        input: v.optional(chatDiagnosticTextSchema),
        isError: v.boolean("Chat tool failure state is invalid"),
        kind: v.literal("tool"),
        name: chatToolNameSchema,
        nameSource: v.optional(v.literal("synthetic")),
        output: v.optional(chatDiagnosticTextSchema),
        phase: v.picklist(
            ["started", "running", "succeeded", "failed"],
            "Chat tool phase is invalid"
        ),
    }),
    v.strictObject({
        downloadUrl: v.optional(
            v.pipe(
                v.string("Chat attachment download URL is invalid"),
                v.regex(
                    /^\/api\/chat\/media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?disposition=download$/u,
                    "Chat attachment download URL is invalid"
                )
            )
        ),
        fileName: boundedControlSafeTextSchema(
            255,
            "Chat attachment file name is invalid"
        ),
        id: chatPartIdSchema,
        kind: v.literal("attachment"),
        mediaType: v.pipe(
            v.string("Chat attachment media type is invalid"),
            v.maxLength(127, "Chat attachment media type is invalid")
        ),
        renderPolicy: v.picklist(["bounded-text", "download-only", "inline-image"]),
        sizeBytes: v.optional(
            nonnegativeSafeIntegerSchema("Chat attachment size is invalid")
        ),
        url: v.pipe(
            v.string("Chat attachment URL is invalid"),
            v.regex(
                /^\/api\/chat\/media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?disposition=(?:preview|download)$/u,
                "Chat attachment URL is invalid"
            )
        ),
    }),
    v.strictObject({
        id: chatPartIdSchema,
        kind: v.literal("control"),
        text: chatDiagnosticTextSchema,
    }),
]);

export function chatMessagePartToolStateIsConsistent(
    part: v.InferOutput<typeof chatMessagePartVariantSchema>
): boolean {
    return (
        part.kind !== "tool" ||
        (part.isError === (part.phase === "failed") &&
            (part.phase !== "failed" || part.output !== undefined))
    );
}

export function chatMessageAttachmentDispositionIsConsistent(
    part: v.InferOutput<typeof chatMessagePartVariantSchema>
): boolean {
    if (part.kind !== "attachment") return true;
    const primaryDispositionMatches =
        part.renderPolicy === "download-only"
            ? part.url.endsWith("?disposition=download")
            : part.url.endsWith("?disposition=preview");
    const expectedDownloadUrl = part.url.replace(
        /\?disposition=(?:preview|download)$/u,
        "?disposition=download"
    );
    return (
        primaryDispositionMatches &&
        (part.downloadUrl === undefined || part.downloadUrl === expectedDownloadUrl)
    );
}

export const chatMessagePartSchema = v.pipe(
    chatMessagePartVariantSchema,
    v.check(
        chatMessagePartToolStateIsConsistent,
        "Chat tool phase and failure state are inconsistent"
    ),
    v.check(
        chatMessageAttachmentDispositionIsConsistent,
        "Chat attachment render policy and URL disposition disagree"
    )
);
export type ChatMessagePart = v.InferOutput<typeof chatMessagePartSchema>;

export function chatMessagePartsHaveUniqueIds(
    parts: v.InferOutput<typeof chatMessagePartSchema>[]
): boolean {
    return hasUniqueArrayItems(parts.map(({ id }) => id));
}

const chatMessagePartsSchema = v.pipe(
    v.array(chatMessagePartSchema, "Chat message parts are invalid"),
    v.maxLength(128, "Chat message part count is outside its budget"),
    v.check(chatMessagePartsHaveUniqueIds, "Chat message part ids must be unique")
);

export const chatMessageContentSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("complete"),
        parts: chatMessagePartsSchema,
    }),
    v.strictObject({
        attachments: v.optional(
            v.pipe(
                v.array(chatMessagePartSchema),
                v.maxLength(10),
                v.check(
                    (parts) => parts.every((part) => part.kind === "attachment"),
                    "Hydration attachments are invalid"
                )
            )
        ),
        kind: v.literal("hydration-required"),
        preview: v.optional(chatPreviewTextSchema),
        reason: v.picklist(["provider-omitted", "response-budget"]),
    }),
]);

const chatMessageObjectSchema = v.strictObject({
    content: chatMessageContentSchema,
    createdAtMs: v.optional(
        timestampMillisecondsSchema("Chat message timestamp is invalid")
    ),
    id: chatMessageIdSchema,
    idempotencyKey: v.optional(jobIdempotencyKeySchema),
    localRunId: v.optional(chatRunIdSchema),
    model: v.optional(chatModelLabelSchema),
    provider: v.optional(chatProviderLabelSchema),
    role: v.picklist(
        ["assistant", "system", "tool", "user"],
        "Chat message role is invalid"
    ),
    runId: v.optional(chatProviderRunIdSchema),
    sequence: v.optional(
        nonnegativeSafeIntegerSchema("Chat message sequence is invalid")
    ),
    source: v.picklist(["gateway-history", "runtime"]),
    stopReason: v.optional(
        boundedControlSafeTextSchema(128, "Chat stop reason is invalid")
    ),
});

export function chatMessageFitsHydrationBudget(
    message: v.InferOutput<typeof chatMessageObjectSchema>
): boolean {
    return utf8ByteLength(JSON.stringify(message)) <= chatMessageHydrationMaximumBytes;
}

/** One provider-independent, fully bounded display message. */
export const chatMessageSchema = v.pipe(
    chatMessageObjectSchema,
    v.check(chatMessageFitsHydrationBudget, "Chat message exceeds its hydration budget")
);

export type ChatMessage = v.InferOutput<typeof chatMessageSchema>;

export const chatRunReconciliationStates = [
    "failed",
    "history-authoritative",
    "pending",
    "runtime-authoritative",
] as const;

export const chatRunReconciliationStateSchema = v.picklist(
    chatRunReconciliationStates,
    "Chat reconciliation state is invalid"
);

const chatRunSummaryObjectSchema = v.strictObject({
    admittedAtMs: timestampMillisecondsSchema("Chat admission timestamp is invalid"),
    cancelRequestedAtMs: v.optional(
        timestampMillisecondsSchema("Chat cancellation timestamp is invalid")
    ),
    failureCode: v.optional(
        boundedControlSafeTextSchema(128, "Chat failure code is invalid")
    ),
    failureMessage: v.optional(
        boundedNonBlankTextSchema(2000, "Chat failure message is invalid")
    ),
    id: chatRunIdSchema,
    providerRunId: v.optional(chatProviderRunIdSchema),
    reconciliation: chatRunReconciliationStateSchema,
    reconciledAtMs: v.optional(
        timestampMillisecondsSchema("Chat reconciliation timestamp is invalid")
    ),
    sessionKey: gatewaySessionKeySchema,
    state: chatRunStateSchema,
    stateVersion: positiveSafeIntegerSchema("Chat run version is invalid"),
    terminalAtMs: v.optional(
        timestampMillisecondsSchema("Chat terminal timestamp is invalid")
    ),
    updatedAtMs: timestampMillisecondsSchema("Chat update timestamp is invalid"),
});

type ChatRunSummaryValue = v.InferOutput<typeof chatRunSummaryObjectSchema>;

export function chatRunSummaryIsConsistent(run: ChatRunSummaryValue): boolean {
    const terminal = ["cancelled", "completed", "failed", "unresolved"].includes(
        run.state
    );
    return (
        run.updatedAtMs >= run.admittedAtMs &&
        terminal === (run.terminalAtMs !== undefined) &&
        (run.terminalAtMs === undefined || run.terminalAtMs <= run.updatedAtMs) &&
        (run.cancelRequestedAtMs === undefined ||
            (run.cancelRequestedAtMs >= run.admittedAtMs &&
                run.cancelRequestedAtMs <= run.updatedAtMs)) &&
        (run.reconciliation === "history-authoritative") ===
            (run.reconciledAtMs !== undefined)
    );
}

export const chatRunSummarySchema = v.pipe(
    chatRunSummaryObjectSchema,
    v.check(chatRunSummaryIsConsistent, "Chat run summary is inconsistent")
);

export type ChatRunSummary = v.InferOutput<typeof chatRunSummarySchema>;

const chatRuntimeEventBase = {
    occurredAtMs: timestampMillisecondsSchema("Chat runtime timestamp is invalid"),
    runId: chatRunIdSchema,
    sequence: chatRuntimeEventSequenceSchema,
};

export const chatPlanStepStatuses = ["completed", "in_progress", "pending"] as const;
export const chatPlanExplanationMaximumCodeUnits = 4000;
export const chatPlanExplanationSchema = boundedNonBlankTextSchema(
    chatPlanExplanationMaximumCodeUnits,
    "Chat plan explanation is invalid"
);
export const chatPlanStepSchema = v.strictObject({
    status: v.picklist(chatPlanStepStatuses, "Chat plan step status is invalid"),
    text: boundedNonBlankTextSchema(1000, "Chat plan step text is invalid"),
});
export type ChatPlanStep = v.InferOutput<typeof chatPlanStepSchema>;

export function chatPlanStepsHaveAtMostOneActive(steps: ChatPlanStep[]): boolean {
    return steps.filter(({ status }) => status === "in_progress").length <= 1;
}

const chatPlanStepsSchema = v.pipe(
    v.array(chatPlanStepSchema, "Chat plan steps are invalid"),
    v.minLength(1, "Chat plan must contain at least one step"),
    v.maxLength(64, "Chat plan step count is outside its budget"),
    v.check(
        chatPlanStepsHaveAtMostOneActive,
        "Chat plan has more than one in-progress step"
    )
);

/** Ordered durable event vocabulary consumed by the runtime reducer and browser. */
const chatRuntimeEventVariantSchema = v.variant("kind", [
    v.strictObject({
        ...chatRuntimeEventBase,
        attachmentTicketId: v.optional(chatAttachmentTicketIdSchema),
        idempotencyKey: jobIdempotencyKeySchema,
        kind: v.literal("user"),
        text: chatMessageTextSchema,
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        kind: v.literal("assistant"),
        mode: v.picklist(["append", "merge", "replace"]),
        providerSequenceEnd: v.optional(
            positiveSafeIntegerSchema("Chat provider sequence is invalid")
        ),
        providerSequenceStart: v.optional(
            positiveSafeIntegerSchema("Chat provider sequence is invalid")
        ),
        text: chatDeltaTextSchema,
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        kind: v.literal("thinking"),
        mode: v.picklist(["append", "merge", "replace"]),
        providerSequenceEnd: v.optional(
            positiveSafeIntegerSchema("Chat provider sequence is invalid")
        ),
        providerSequenceStart: v.optional(
            positiveSafeIntegerSchema("Chat provider sequence is invalid")
        ),
        text: chatDeltaTextSchema,
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        callId: chatToolCallIdSchema,
        callIdSource: v.optional(v.literal("synthetic")),
        input: v.optional(chatDiagnosticTextSchema),
        isError: v.boolean("Chat tool failure state is invalid"),
        kind: v.literal("tool"),
        name: chatToolNameSchema,
        nameSource: v.optional(v.literal("synthetic")),
        output: v.optional(chatDiagnosticTextSchema),
        phase: v.picklist(["started", "running", "succeeded", "failed"]),
        providerSequence: v.optional(chatProviderSequenceSchema),
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        itemId: boundedControlSafeTextSchema(256, "Chat item id is invalid"),
        itemType: boundedControlSafeTextSchema(128, "Chat item type is invalid"),
        kind: v.literal("item"),
        providerSequence: v.optional(chatProviderSequenceSchema),
        text: v.optional(chatDiagnosticTextSchema),
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        kind: v.literal("status"),
        phase: v.picklist([
            "preparing-context",
            "preparing-workspace",
            "provisioning-environment",
            "starting-model",
        ]),
        providerSequence: v.optional(chatProviderSequenceSchema),
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        explanation: v.optional(chatPlanExplanationSchema),
        kind: v.literal("plan"),
        phase: v.literal("update"),
        providerSequence: v.optional(chatProviderSequenceSchema),
        steps: chatPlanStepsSchema,
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        kind: v.literal("provider-noop"),
        providerSequenceEnd: chatProviderSequenceSchema,
        providerSequenceStart: chatProviderSequenceSchema,
        reason: v.literal("ignored"),
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        kind: v.literal("cancel"),
        providerSequence: v.optional(chatProviderSequenceSchema),
        source: v.picklist(["operator", "provider"]),
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        errorCode: v.optional(
            boundedControlSafeTextSchema(128, "Chat terminal error code is invalid")
        ),
        errorMessage: v.optional(
            boundedNonBlankTextSchema(2000, "Chat terminal error is invalid")
        ),
        kind: v.literal("terminal"),
        outcome: v.picklist(["aborted", "completed", "error"]),
        providerSequence: v.optional(chatProviderSequenceSchema),
        providerRunId: v.optional(chatProviderRunIdSchema),
        stopReason: v.optional(
            boundedControlSafeTextSchema(128, "Chat stop reason is invalid")
        ),
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        historyMessageId: v.optional(chatMessageIdSchema),
        kind: v.literal("reconciled"),
    }),
    v.strictObject({
        ...chatRuntimeEventBase,
        kind: v.literal("interrupted"),
    }),
]);

export function chatRuntimeEventToolStateIsConsistent(
    event: v.InferOutput<typeof chatRuntimeEventVariantSchema>
): boolean {
    return (
        event.kind !== "tool" ||
        (event.isError === (event.phase === "failed") &&
            (event.phase !== "failed" || event.output !== undefined))
    );
}

export function chatRuntimeEventProviderRangeIsConsistent(
    event: v.InferOutput<typeof chatRuntimeEventVariantSchema>
): boolean {
    if (
        event.kind !== "assistant" &&
        event.kind !== "thinking" &&
        event.kind !== "provider-noop"
    ) {
        return true;
    }
    return (
        (event.providerSequenceStart === undefined &&
            event.providerSequenceEnd === undefined) ||
        (event.providerSequenceStart !== undefined &&
            event.providerSequenceEnd !== undefined &&
            event.providerSequenceStart <= event.providerSequenceEnd)
    );
}

export const chatRuntimeEventSchema = v.pipe(
    chatRuntimeEventVariantSchema,
    v.check(
        chatRuntimeEventToolStateIsConsistent,
        "Chat runtime tool phase and failure state are inconsistent"
    ),
    v.check(
        chatRuntimeEventProviderRangeIsConsistent,
        "Chat provider sequence range is inconsistent"
    )
);

export type ChatRuntimeEvent = v.InferOutput<typeof chatRuntimeEventSchema>;

const chatRuntimeProjectionPartVariantSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("assistant"),
        occurredAtMs: v.optional(
            timestampMillisecondsSchema("Chat assistant timestamp is invalid")
        ),
        segmentId: v.optional(chatProjectionSegmentIdSchema),
        sequence: chatRuntimeEventSequenceSchema,
        streamId: v.optional(chatProjectionStreamIdSchema),
        text: chatMessageTextSchema,
    }),
    v.strictObject({
        kind: v.literal("thinking"),
        occurredAtMs: v.optional(
            timestampMillisecondsSchema("Chat thinking timestamp is invalid")
        ),
        segmentId: v.optional(chatProjectionSegmentIdSchema),
        sequence: chatRuntimeEventSequenceSchema,
        streamId: v.optional(chatProjectionStreamIdSchema),
        text: chatMessageTextSchema,
    }),
    v.strictObject({
        callId: chatToolCallIdSchema,
        callIdSource: v.optional(v.literal("synthetic")),
        input: v.optional(chatDiagnosticTextSchema),
        isError: v.boolean(),
        kind: v.literal("tool"),
        name: chatToolNameSchema,
        nameSource: v.optional(v.literal("synthetic")),
        occurredAtMs: v.optional(
            timestampMillisecondsSchema("Chat tool timestamp is invalid")
        ),
        output: v.optional(chatDiagnosticTextSchema),
        phase: v.picklist(["started", "running", "succeeded", "failed"]),
        sequence: chatRuntimeEventSequenceSchema,
    }),
    v.strictObject({
        id: boundedControlSafeTextSchema(256, "Chat item id is invalid"),
        kind: v.literal("item"),
        occurredAtMs: v.optional(
            timestampMillisecondsSchema("Chat item timestamp is invalid")
        ),
        sequence: chatRuntimeEventSequenceSchema,
        text: v.optional(chatDiagnosticTextSchema),
        type: boundedControlSafeTextSchema(128, "Chat item type is invalid"),
    }),
    v.strictObject({
        attachments: v.optional(
            v.pipe(
                v.array(chatMessagePartSchema, "Chat user attachments are invalid"),
                v.maxLength(10, "Chat user attachment count is outside its budget"),
                v.check(
                    (parts) => parts.every((part) => part.kind === "attachment"),
                    "Chat user projection contains a non-attachment part"
                )
            )
        ),
        kind: v.literal("user"),
        messageId: v.optional(chatMessageIdSchema),
        occurredAtMs: v.optional(
            timestampMillisecondsSchema("Chat user timestamp is invalid")
        ),
        sequence: chatRuntimeEventSequenceSchema,
        text: chatMessageTextSchema,
    }),
]);

export function chatRuntimeProjectionToolStateIsConsistent(
    part: v.InferOutput<typeof chatRuntimeProjectionPartVariantSchema>
): boolean {
    return (
        part.kind !== "tool" ||
        (part.isError === (part.phase === "failed") &&
            (part.phase !== "failed" || part.output !== undefined))
    );
}

export const chatRuntimeProjectionPartSchema = v.pipe(
    chatRuntimeProjectionPartVariantSchema,
    v.check(
        chatRuntimeProjectionToolStateIsConsistent,
        "Chat runtime projection tool state is inconsistent"
    )
);

export type ChatRuntimeProjectionPart = v.InferOutput<
    typeof chatRuntimeProjectionPartSchema
>;

export function chatRuntimeProjectionPartsAreOrdered(
    parts: ChatRuntimeProjectionPart[]
): boolean {
    return parts.every(
        ({ sequence }, index) =>
            index === 0 || sequence > (parts[index - 1]?.sequence ?? 0)
    );
}

const chatRuntimeProjectionPartsSchema = v.pipe(
    v.array(chatRuntimeProjectionPartSchema, "Chat runtime projection parts are invalid"),
    v.maxLength(
        chatRuntimeProjectionPartsMaximum,
        "Chat runtime projection part count is outside its budget"
    ),
    v.check(
        chatRuntimeProjectionPartsAreOrdered,
        "Chat runtime projection parts are not in strict sequence order"
    )
);

const chatRuntimeSnapshotObjectSchema = v.strictObject({
    firstSequence: chatRuntimeEventSequenceSchema,
    parts: chatRuntimeProjectionPartsSchema,
    plan: v.optional(
        v.strictObject({
            explanation: v.optional(chatPlanExplanationSchema),
            phase: v.literal("update"),
            steps: chatPlanStepsSchema,
        })
    ),
    /** True when response budgeting deliberately omits projection detail. */
    projectionTruncated: v.optional(v.boolean(), false),
    run: chatRunSummarySchema,
    throughSequence: chatRuntimeEventSequenceSchema,
});

export function chatRuntimeSnapshotFitsBudget(
    snapshot: v.InferOutput<typeof chatRuntimeSnapshotObjectSchema>
): boolean {
    const isTerminal = ["cancelled", "completed", "failed", "unresolved"].includes(
        snapshot.run.state
    );
    return (
        snapshot.firstSequence <= snapshot.throughSequence &&
        (!isTerminal || snapshot.plan === undefined) &&
        utf8ByteLength(JSON.stringify(snapshot)) <= chatRuntimeSnapshotMaximumBytes
    );
}

export const chatRuntimeSnapshotSchema = v.pipe(
    chatRuntimeSnapshotObjectSchema,
    v.check(chatRuntimeSnapshotFitsBudget, "Chat runtime snapshot is inconsistent")
);

export type ChatRuntimeSnapshot = v.InferOutput<typeof chatRuntimeSnapshotSchema>;

const chatExternalPlanSchema = v.strictObject({
    explanation: v.optional(chatPlanExplanationSchema),
    phase: v.literal("update"),
    steps: chatPlanStepsSchema,
});

export const chatAbortAttemptIdSchema = boundedControlSafeTextSchema(
    64,
    "Chat abort attempt id is invalid"
);

const chatExternalAbortBoundarySchema = v.strictObject({
    attemptId: chatAbortAttemptIdSchema,
    attemptedAtMs: timestampMillisecondsSchema(
        "External chat abort attempt timestamp is invalid"
    ),
    baselineObservationEpoch: nonnegativeSafeIntegerSchema(
        "External chat abort observation epoch is invalid"
    ),
    baselineUpdatedAtMs: timestampMillisecondsSchema(
        "External chat abort baseline is invalid"
    ),
    settlement: v.picklist(["not-aborted", "pending", "unknown"]),
});

export const chatExternalStreamResetMaximum = 8;
const chatExternalStreamResetSchema = v.strictObject({
    resetId: chatProjectionSegmentIdSchema,
    streamId: chatProjectionStreamIdSchema,
});
const chatExternalStreamResetsSchema = v.pipe(
    v.array(chatExternalStreamResetSchema),
    v.maxLength(
        chatExternalStreamResetMaximum,
        "External chat stream reset count is outside its budget"
    )
);

/** Honest provider-origin projection with no fabricated local actor or UUID admission. */
const chatExternalRunObjectSchema = v.strictObject({
    /** Server-owned observation fence for one exact provider abort attempt. */
    abortBoundary: v.optional(chatExternalAbortBoundarySchema),
    continuity: v.picklist(["complete", "interrupted"]),
    hasUnprojectedActivity: v.boolean(),
    /** Runtime truth may stop before canonical history exposes the final message. */
    lifecycle: v.optional(v.picklist(["active", "terminal-pending-history"]), "active"),
    /** Process-local receipt/start epoch; processing completion never advances it. */
    observationEpoch: v.optional(
        nonnegativeSafeIntegerSchema("External chat observation epoch is invalid"),
        0
    ),
    /** Trusted provider receipt or history-request start time, never completion time. */
    observedAtMs: v.optional(
        timestampMillisecondsSchema("External chat observation timestamp is invalid"),
        0
    ),
    /** Ordered provider activity retained even when no local admission exists. */
    parts: v.optional(chatRuntimeProjectionPartsSchema),
    plan: v.optional(chatExternalPlanSchema),
    /** True when response budgeting deliberately omits provider projection detail. */
    projectionTruncated: v.optional(v.boolean(), false),
    providerRunId: chatProviderRunIdSchema,
    sessionKey: gatewaySessionKeySchema,
    source: v.picklist(["provider-in-flight", "provider-runtime"]),
    /** Latest authoritative replacement watermark for each provider stream. */
    streamResets: v.optional(chatExternalStreamResetsSchema),
    /** Assistant-only compatibility projection used by bounded response fallback. */
    text: chatMessageTextSchema,
    updatedAtMs: timestampMillisecondsSchema("External chat run timestamp is invalid"),
});

export function chatExternalRunFitsBudget(
    run: v.InferOutput<typeof chatExternalRunObjectSchema>
): boolean {
    return utf8ByteLength(JSON.stringify(run)) <= chatRuntimeSnapshotMaximumBytes;
}

export const chatExternalRunSchema = v.pipe(
    chatExternalRunObjectSchema,
    v.check(
        chatExternalRunFitsBudget,
        "External chat run projection is outside its budget"
    )
);

export type ChatExternalRun = v.InferOutput<typeof chatExternalRunSchema>;
