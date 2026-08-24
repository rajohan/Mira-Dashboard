import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import {
    boundedControlSafeTextSchema,
    boundedNonBlankTextSchema,
    hasUniqueArrayItems,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import {
    chatAttachmentTicketIdSchema,
    chatAttachmentTicketPrepareInputSchema,
    chatAttachmentTicketPrepareOutputSchema,
} from "./chatMedia.ts";
import {
    type ChatMessage,
    chatAbortAttemptIdSchema,
    chatHistoryPageDefault,
    chatHistoryPageMaximum,
    chatHistoryProviderPageMaximum,
    chatHistoryResponseMaximumBytes,
    chatExternalRunSchema,
    chatMessageHydrationMaximumBytes,
    chatMessageIdSchema,
    chatMessageSchema,
    chatMessageTextSchema,
    chatRunIdSchema,
    chatRunSummarySchema,
    chatRuntimeCursorSchema,
    chatRuntimePageMinimum,
    chatRuntimeEventSchema,
    chatRuntimePageDefault,
    chatRuntimePageMaximum,
    chatRuntimeResponseMaximumBytes,
    chatRuntimeSnapshotSchema,
    chatSendInputMaximumBytes,
} from "./chatModel.ts";
import { gatewaySessionIdSchema, gatewaySessionKeySchema } from "./gatewaySessions.ts";
import { jobIdempotencyKeySchema } from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";

const chatReadAccess = {
    capabilities: ["chat:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const chatWriteAccess = {
    capabilities: ["chat:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const chatSessionWriteAccess = {
    ...chatWriteAccess,
    principalKinds: ["session"],
} as const;
const chatQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const chatMutationTransport = {
    batching: "forbidden",
    handler: "long-lived",
    requestBody: "default",
} as const;
const chatSendMutationTransport = {
    ...chatMutationTransport,
    requestBody: "chat-send",
} as const;

const chatHistoryLimitSchema = v.pipe(
    positiveSafeIntegerSchema("Chat history limit is invalid"),
    v.maxValue(chatHistoryPageMaximum, "Chat history limit is outside its budget")
);

/** Reads one bounded chronological Gateway history page. */
export const chatHistoryInputSchema = v.strictObject({
    cursor: v.optional(chatRuntimeCursorSchema, "0"),
    limit: v.optional(chatHistoryLimitSchema, chatHistoryPageDefault),
    sessionKey: gatewaySessionKeySchema,
});

export function chatHistoryMessagesHaveUniqueIds(messages: ChatMessage[]): boolean {
    return hasUniqueArrayItems(messages.map(({ id }) => id));
}

const chatHistoryMessagesSchema = v.pipe(
    v.array(chatMessageSchema, "Chat history messages are invalid"),
    v.maxLength(
        chatHistoryPageMaximum,
        "Chat history message count is outside its budget"
    ),
    v.check(chatHistoryMessagesHaveUniqueIds, "Chat history message ids must be unique")
);

const chatHistoryOutputObjectSchema = v.strictObject({
    messages: chatHistoryMessagesSchema,
    nextCursor: v.optional(chatRuntimeCursorSchema),
    providerPagesRead: v.pipe(
        positiveSafeIntegerSchema("Chat provider page count is invalid"),
        v.maxValue(
            chatHistoryProviderPageMaximum,
            "Chat provider page count is outside its budget"
        )
    ),
    sessionId: v.optional(gatewaySessionIdSchema),
    sessionKey: gatewaySessionKeySchema,
    truncated: v.boolean("Chat history truncation state is invalid"),
});

export function chatHistoryOutputFitsBudget(
    output: v.InferOutput<typeof chatHistoryOutputObjectSchema>
): boolean {
    return utf8ByteLength(JSON.stringify(output)) <= chatHistoryResponseMaximumBytes;
}

/** At most two provider pages, 100 rows, and 512 KiB of canonical history. */
export const chatHistoryOutputSchema = v.pipe(
    chatHistoryOutputObjectSchema,
    v.check(chatHistoryOutputFitsBudget, "Chat history exceeds its response budget")
);

/** Hydrates one exact message that a bounded history page deliberately omitted. */
export const chatMessageGetInputSchema = v.strictObject({
    messageId: chatMessageIdSchema,
    sessionKey: gatewaySessionKeySchema,
});

const availableChatMessageObjectSchema = v.strictObject({
    message: chatMessageSchema,
    status: v.literal("available"),
});

export function availableChatMessageIsCompleteAndFitsBudget(
    output: v.InferOutput<typeof availableChatMessageObjectSchema>
): boolean {
    return (
        output.message.content.kind === "complete" &&
        utf8ByteLength(JSON.stringify(output.message)) <= chatMessageHydrationMaximumBytes
    );
}

const availableChatMessageSchema = v.pipe(
    availableChatMessageObjectSchema,
    v.check(
        availableChatMessageIsCompleteAndFitsBudget,
        "Hydrated chat message is incomplete or oversized"
    )
);
const unavailableChatMessageSchema = v.strictObject({
    reason: v.picklist(["not-found", "not-visible", "oversized"]),
    status: v.literal("unavailable"),
});
export const chatMessageGetOutputSchema = v.variant("status", [
    availableChatMessageSchema,
    unavailableChatMessageSchema,
]);

const chatSendSettingsSchema = v.strictObject({
    fastMode: v.optional(v.union([v.boolean(), v.literal("auto")])),
    thinkingLevel: v.optional(
        boundedControlSafeTextSchema(128, "Chat thinking level is invalid")
    ),
});

/** Lost-response-safe send admission. Binary attachment content never enters tRPC. */
const chatSendInputObjectSchema = v.strictObject({
    attachmentTicketId: v.optional(chatAttachmentTicketIdSchema),
    clientRunId: chatRunIdSchema,
    idempotencyKey: jobIdempotencyKeySchema,
    message: chatMessageTextSchema,
    queueMode: v.optional(v.picklist(["collect", "followup", "interrupt", "steer"])),
    sessionKey: gatewaySessionKeySchema,
    settings: v.optional(chatSendSettingsSchema),
});

export function chatSendInputHasContent(
    input: v.InferOutput<typeof chatSendInputObjectSchema>
): boolean {
    return input.attachmentTicketId !== undefined || /\S/u.test(input.message);
}

export function chatSendInputFitsAdmissionBudget(
    input: v.InferOutput<typeof chatSendInputObjectSchema>
): boolean {
    return utf8ByteLength(JSON.stringify(input)) <= chatSendInputMaximumBytes;
}

export const chatSendInputSchema = v.pipe(
    chatSendInputObjectSchema,
    v.check(chatSendInputHasContent, "A chat message or attachment ticket is required"),
    v.check(
        chatSendInputFitsAdmissionBudget,
        "Chat send input exceeds its durable admission budget"
    )
);

export const chatSendOutputSchema = v.strictObject({
    admission: v.picklist(["created", "replayed"]),
    run: chatRunSummarySchema,
});

/** Exact run-scoped cancellation for a durable local run or observed provider run. */
export const chatAbortInputSchema = v.union([
    v.strictObject({
        runId: chatRunIdSchema,
        sessionKey: gatewaySessionKeySchema,
    }),
    v.strictObject({
        abortAttemptId: chatAbortAttemptIdSchema,
        providerRunId: boundedControlSafeTextSchema(
            256,
            "Chat provider run id is invalid"
        ),
        sessionKey: gatewaySessionKeySchema,
    }),
]);
export const chatAbortOutputSchema = v.union([
    v.strictObject({
        aborted: v.boolean("Chat abort result is invalid"),
        run: chatRunSummarySchema,
    }),
    v.strictObject({
        aborted: v.boolean("Chat abort result is invalid"),
        abortAttemptId: chatAbortAttemptIdSchema,
        providerRunId: boundedControlSafeTextSchema(
            256,
            "Chat provider run id is invalid"
        ),
    }),
]);

export const chatModelsListInputSchema = v.strictObject({});

const chatModelSummarySchema = v.strictObject({
    id: boundedControlSafeTextSchema(256, "Chat model id is invalid"),
    label: boundedControlSafeTextSchema(256, "Chat model label is invalid"),
    provider: boundedControlSafeTextSchema(128, "Chat model provider is invalid"),
    supportsFastMode: v.boolean("Chat model fast-mode capability is invalid"),
    thinkingLevels: v.pipe(
        v.array(
            boundedControlSafeTextSchema(128, "Chat model thinking level is invalid")
        ),
        v.maxLength(32, "Chat model thinking levels are outside their budget")
    ),
});

type ChatModelSummary = v.InferOutput<typeof chatModelSummarySchema>;

export function chatModelsHaveUniqueIds(output: { models: ChatModelSummary[] }): boolean {
    return hasUniqueArrayItems(output.models.map(({ id }) => id));
}

export const chatModelsListOutputSchema = v.pipe(
    v.strictObject({
        models: v.pipe(
            v.array(chatModelSummarySchema, "Chat models are invalid"),
            v.maxLength(256, "Chat model count is outside its budget")
        ),
    }),
    v.check(chatModelsHaveUniqueIds, "Chat model ids must be unique")
);

const chatSessionSettingsEntries = {
    fastMode: v.optional(v.nullable(v.union([v.boolean(), v.literal("auto")]))),
    model: v.optional(
        v.nullable(boundedControlSafeTextSchema(256, "Chat session model is invalid"))
    ),
    thinkingLevel: v.optional(
        v.nullable(
            boundedControlSafeTextSchema(128, "Chat session thinking level is invalid")
        )
    ),
};

const chatSessionSettingsInputObjectSchema = v.strictObject({
    expectedSessionId: v.optional(gatewaySessionIdSchema),
    sessionKey: gatewaySessionKeySchema,
    ...chatSessionSettingsEntries,
});

export function chatSessionSettingsPatchIsNonempty(
    input: v.InferOutput<typeof chatSessionSettingsInputObjectSchema>
): boolean {
    return (
        input.fastMode !== undefined ||
        input.model !== undefined ||
        input.thinkingLevel !== undefined
    );
}

export const chatSessionSettingsInputSchema = v.pipe(
    chatSessionSettingsInputObjectSchema,
    v.check(
        chatSessionSettingsPatchIsNonempty,
        "At least one chat session setting is required"
    )
);

export const chatSessionSettingsOutputSchema = v.strictObject({
    sessionId: v.optional(gatewaySessionIdSchema),
    sessionKey: gatewaySessionKeySchema,
    ...chatSessionSettingsEntries,
});

const chatRuntimeLimitSchema = v.pipe(
    positiveSafeIntegerSchema("Chat runtime limit is invalid"),
    v.minValue(
        chatRuntimePageMinimum,
        "Chat runtime limit is outside its catch-up policy"
    ),
    v.maxValue(chatRuntimePageMaximum, "Chat runtime limit is outside its budget")
);

export const chatRuntimeInputSchema = v.strictObject({
    afterCursor: v.optional(chatRuntimeCursorSchema, "0"),
    afterTranscriptGeneration: v.optional(
        nonnegativeSafeIntegerSchema("Chat transcript generation is invalid"),
        0
    ),
    limit: v.optional(chatRuntimeLimitSchema, chatRuntimePageDefault),
    sessionKey: gatewaySessionKeySchema,
});

const chatRuntimeDeliverySchema = v.strictObject({
    cursor: chatRuntimeCursorSchema,
    event: chatRuntimeEventSchema,
});

export function chatExternalRunsHaveUniqueProviderIds(
    runs: v.InferOutput<typeof chatExternalRunSchema>[]
): boolean {
    return hasUniqueArrayItems(runs.map(({ providerRunId }) => providerRunId));
}

const chatRuntimeOutputObjectSchema = v.strictObject({
    cursor: chatRuntimeCursorSchema,
    externalRuns: v.optional(
        v.pipe(
            v.array(chatExternalRunSchema, "External chat runs are invalid"),
            v.maxLength(8, "External chat run count is outside its budget"),
            v.check(
                chatExternalRunsHaveUniqueProviderIds,
                "External chat provider run ids must be unique"
            )
        ),
        []
    ),
    externalRunsTruncated: v.optional(
        v.boolean("External chat truncation state is invalid"),
        false
    ),
    events: v.pipe(
        v.array(chatRuntimeDeliverySchema, "Chat runtime events are invalid"),
        v.maxLength(
            chatRuntimePageMaximum,
            "Chat runtime event page is outside its budget"
        )
    ),
    hasMore: v.boolean("Chat runtime continuation state is invalid"),
    resetRequired: v.boolean("Chat runtime reset state is invalid"),
    runs: v.pipe(
        v.array(chatRuntimeSnapshotSchema, "Chat runtime snapshots are invalid"),
        v.maxLength(12, "Chat runtime snapshot count is outside its budget")
    ),
    sessionKey: gatewaySessionKeySchema,
    transcriptGeneration: positiveSafeIntegerSchema(
        "Chat transcript generation is invalid"
    ),
});

export function chatRuntimeOutputIsConsistent(
    output: v.InferOutput<typeof chatRuntimeOutputObjectSchema>
): boolean {
    let previousCursor = -1;
    const cursor = Number(output.cursor);
    const ordered = output.events.every((delivery) => {
        const current = Number(delivery.cursor);
        const valid = current > previousCursor && current <= cursor;
        previousCursor = current;
        return valid;
    });
    const uniqueRuns = hasUniqueArrayItems(output.runs.map(({ run }) => run.id));
    const lastDelivery = output.events.at(-1);
    const snapshotsAreOrdered = output.runs.every((snapshot, index) => {
        const previous = output.runs[index - 1];
        return (
            previous === undefined ||
            previous.run.admittedAtMs < snapshot.run.admittedAtMs ||
            (previous.run.admittedAtMs === snapshot.run.admittedAtMs &&
                previous.run.id < snapshot.run.id)
        );
    });
    return (
        ordered &&
        uniqueRuns &&
        snapshotsAreOrdered &&
        (!output.resetRequired || (output.events.length === 0 && !output.hasMore)) &&
        (!output.hasMore ||
            (!output.resetRequired &&
                lastDelivery !== undefined &&
                lastDelivery.cursor === output.cursor)) &&
        output.runs.every(({ run }) => run.sessionKey === output.sessionKey) &&
        output.externalRuns.every(({ sessionKey }) => sessionKey === output.sessionKey) &&
        utf8ByteLength(JSON.stringify(output)) <= chatRuntimeResponseMaximumBytes
    );
}

export const chatRuntimeOutputSchema = v.pipe(
    chatRuntimeOutputObjectSchema,
    v.check(chatRuntimeOutputIsConsistent, "Chat runtime response is inconsistent")
);

const chatCompanionExchangeSchema = v.strictObject({
    answer: boundedNonBlankTextSchema(1200, "Chat companion answer is invalid"),
    question: boundedNonBlankTextSchema(400, "Chat companion question is invalid"),
    timestampMs: timestampMillisecondsSchema("Chat companion timestamp is invalid"),
});

export const chatCompanionStateInputSchema = v.strictObject({
    sessionKey: gatewaySessionKeySchema,
});
export const chatCompanionStateOutputSchema = v.strictObject({
    exchanges: v.pipe(
        v.array(chatCompanionExchangeSchema, "Chat companion exchanges are invalid"),
        v.maxLength(24, "Chat companion exchange count is outside its budget")
    ),
});
export const chatCompanionAskInputSchema = v.strictObject({
    question: boundedNonBlankTextSchema(400, "Chat companion question is invalid"),
    sessionKey: gatewaySessionKeySchema,
});
export const chatCompanionAskOutputSchema = v.strictObject({
    answer: boundedNonBlankTextSchema(1200, "Chat companion answer is invalid"),
    timestampMs: timestampMillisecondsSchema("Chat companion timestamp is invalid"),
});
export const chatCompanionResetInputSchema = chatCompanionStateInputSchema;
export const chatCompanionResetOutputSchema = v.strictObject({
    reset: v.literal(true),
});

export type ChatHistoryInput = v.InferOutput<typeof chatHistoryInputSchema>;
export type ChatHistoryOutput = v.InferOutput<typeof chatHistoryOutputSchema>;
export type ChatMessageGetInput = v.InferOutput<typeof chatMessageGetInputSchema>;
export type ChatMessageGetOutput = v.InferOutput<typeof chatMessageGetOutputSchema>;
export type ChatSendInput = v.InferOutput<typeof chatSendInputSchema>;
export type ChatSendOutput = v.InferOutput<typeof chatSendOutputSchema>;
export type ChatAbortInput = v.InferOutput<typeof chatAbortInputSchema>;
export type ChatAbortOutput = v.InferOutput<typeof chatAbortOutputSchema>;
export type ChatModelsListInput = v.InferOutput<typeof chatModelsListInputSchema>;
export type ChatModelsListOutput = v.InferOutput<typeof chatModelsListOutputSchema>;
export type ChatSessionSettingsInput = v.InferOutput<
    typeof chatSessionSettingsInputSchema
>;
export type ChatSessionSettingsOutput = v.InferOutput<
    typeof chatSessionSettingsOutputSchema
>;
export type ChatRuntimeInput = v.InferOutput<typeof chatRuntimeInputSchema>;
export type ChatRuntimeOutput = v.InferOutput<typeof chatRuntimeOutputSchema>;
export type ChatCompanionStateInput = v.InferOutput<typeof chatCompanionStateInputSchema>;
export type ChatCompanionStateOutput = v.InferOutput<
    typeof chatCompanionStateOutputSchema
>;
export type ChatCompanionAskInput = v.InferOutput<typeof chatCompanionAskInputSchema>;
export type ChatCompanionAskOutput = v.InferOutput<typeof chatCompanionAskOutputSchema>;
export type ChatCompanionResetInput = v.InferOutput<typeof chatCompanionResetInputSchema>;
export type ChatCompanionResetOutput = v.InferOutput<
    typeof chatCompanionResetOutputSchema
>;
export type { ChatMessage, ChatRuntimeSnapshot } from "./chatModel.ts";

export const chatProcedureContracts = [
    {
        access: chatReadAccess,
        domain: "chat",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: chatHistoryInputSchema,
        inputSchemaId: "chat.history.input",
        kind: "query",
        name: "chat.history",
        output: chatHistoryOutputSchema,
        outputSchemaId: "chat.history.output",
        summary: "Reads at most two Gateway pages into bounded canonical chat history.",
        transport: chatQueryTransport,
    },
    {
        access: chatReadAccess,
        domain: "chat",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: chatMessageGetInputSchema,
        inputSchemaId: "chat.getMessage.input",
        kind: "query",
        name: "chat.getMessage",
        output: chatMessageGetOutputSchema,
        outputSchemaId: "chat.getMessage.output",
        summary: "Hydrates one exact chat message within a one-MiB response budget.",
        transport: chatQueryTransport,
    },
    {
        access: chatReadAccess,
        domain: "chat",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: chatRuntimeInputSchema,
        inputSchemaId: "chat.runtime.input",
        kind: "query",
        name: "chat.runtime",
        output: chatRuntimeOutputSchema,
        outputSchemaId: "chat.runtime.output",
        summary: "Reads cursor-ordered durable runtime events and restart snapshots.",
        transport: chatQueryTransport,
    },
    {
        access: chatSessionWriteAccess,
        domain: "chat",
        errors: [
            "BAD_REQUEST",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: chatAttachmentTicketPrepareInputSchema,
        inputSchemaId: "chat.prepareAttachmentTicket.input",
        kind: "mutation",
        name: "chat.prepareAttachmentTicket",
        output: chatAttachmentTicketPrepareOutputSchema,
        outputSchemaId: "chat.prepareAttachmentTicket.output",
        summary: "Reserves bounded one-shot same-origin chat attachment uploads.",
        transport: chatMutationTransport,
    },
    {
        access: chatWriteAccess,
        domain: "chat",
        errorReasons: ["operation_outcome_unknown"],
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: chatSendInputSchema,
        inputSchemaId: "chat.send.input",
        kind: "mutation",
        name: "chat.send",
        output: chatSendOutputSchema,
        outputSchemaId: "chat.send.output",
        summary: "Durably admits one idempotent chat run before Gateway dispatch.",
        transport: chatSendMutationTransport,
    },
    {
        access: chatWriteAccess,
        domain: "chat",
        errorReasons: ["operation_outcome_unknown"],
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: chatAbortInputSchema,
        inputSchemaId: "chat.abort.input",
        kind: "mutation",
        name: "chat.abort",
        output: chatAbortOutputSchema,
        outputSchemaId: "chat.abort.output",
        summary:
            "Cancels one exact durable or observed provider chat run without ambiguous session-wide aborts.",
        transport: chatMutationTransport,
    },
    {
        access: chatReadAccess,
        domain: "chat",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: chatModelsListInputSchema,
        inputSchemaId: "chat.listModels.input",
        kind: "query",
        name: "chat.listModels",
        output: chatModelsListOutputSchema,
        outputSchemaId: "chat.listModels.output",
        summary: "Lists bounded configured chat models and safe capabilities.",
        transport: chatQueryTransport,
    },
    {
        access: chatWriteAccess,
        domain: "chat",
        errorReasons: ["operation_outcome_unknown"],
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: chatSessionSettingsInputSchema,
        inputSchemaId: "chat.updateSessionSettings.input",
        kind: "mutation",
        name: "chat.updateSessionSettings",
        output: chatSessionSettingsOutputSchema,
        outputSchemaId: "chat.updateSessionSettings.output",
        summary: "Updates reviewed Gateway-backed chat session controls with readback.",
        transport: chatMutationTransport,
    },
    {
        access: chatReadAccess,
        domain: "chat",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: chatCompanionStateInputSchema,
        inputSchemaId: "chat.companionState.input",
        kind: "query",
        name: "chat.companionState",
        output: chatCompanionStateOutputSchema,
        outputSchemaId: "chat.companionState.output",
        summary: "Reads the bounded ephemeral companion thread for one session.",
        transport: chatQueryTransport,
    },
    {
        access: chatWriteAccess,
        domain: "chat",
        errorReasons: ["operation_outcome_unknown"],
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: chatCompanionAskInputSchema,
        inputSchemaId: "chat.companionAsk.input",
        kind: "mutation",
        name: "chat.companionAsk",
        output: chatCompanionAskOutputSchema,
        outputSchemaId: "chat.companionAsk.output",
        summary: "Runs one bounded local write-authorized session-companion ask.",
        transport: chatMutationTransport,
    },
    {
        access: chatWriteAccess,
        domain: "chat",
        errorReasons: ["operation_outcome_unknown"],
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: chatCompanionResetInputSchema,
        inputSchemaId: "chat.companionReset.input",
        kind: "mutation",
        name: "chat.companionReset",
        output: chatCompanionResetOutputSchema,
        outputSchemaId: "chat.companionReset.output",
        summary: "Clears one ephemeral session companion thread.",
        transport: chatMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];
