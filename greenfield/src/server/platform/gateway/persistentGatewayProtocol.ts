import * as v from "valibot";

import { chatAttachmentLimits } from "../../../contracts/chatMedia.ts";
import {
    chatMessageTextSchema,
    normalizeChatProviderUserIdentity,
} from "../../../contracts/chatModel.ts";
import {
    openClawAgentIdSchema,
    openClawChannelIdSchema,
    openClawChannelMaximum,
    openClawConfigHashSchema,
    openClawModelFallbackMaximum,
    openClawModelIdSchema,
    openClawSkillKeySchema,
} from "../../../contracts/openClawSettings.ts";
import { hasNoUnicodeControlOrFormat } from "../../../shared/validation.ts";
import { openClawGatewayProtocolVersion } from "./gatewayCredentialProtocol.ts";

/** Installed OpenClaw's hard application-frame ceiling after authentication. */
export const persistentGatewayAuthenticatedFrameMaximumBytes = 25 * 1024 * 1024;
/** Installed OpenClaw's outbound WebSocket buffered-amount policy. */
export const persistentGatewayBufferedAmountPolicyMaximumBytes = 50 * 1024 * 1024;
/** Dashboard's intentionally tighter outbound buffered-amount ceiling. */
export const persistentGatewayBufferedAmountMaximumBytes = 4 * 1024 * 1024;
/** Dashboard's tighter bound for the challenge that precedes credential disclosure. */
export const persistentGatewayChallengeFrameMaximumBytes = 4 * 1024;
/** Conservative default for non-chat Dashboard-originated request frames. */
export const persistentGatewayOutboundFrameMaximumBytes = 1024 * 1024;
/** Audited ceiling for a chat.send JSON frame containing base64 attachment content. */
export const persistentGatewayChatOutboundFrameMaximumBytes = 24 * 1024 * 1024;
/** Installed Gateway ceiling for the `chat.history` `maxChars` request parameter. */
export const persistentGatewayChatHistoryMaximumChars = 500_000;
/** Exact serialized raw-patch ceiling shared by the Settings provider and protocol. */
export const persistentGatewayOpenClawSettingsPatchMaximumBytes = 64 * 1024;
/** Fixed audited per-step timeout sent to OpenClaw's update runner. */
export const persistentGatewayOpenClawUpdateTimeoutMs = 20 * 60_000;
/** Exact outer deadlines admitted only for the two worker-owned OpenClaw operations. */
export const persistentGatewayOpenClawServiceActionRequestTimeoutMs = Object.freeze({
    "sessions.cleanup": 10 * 60_000,
    "update.run": 35 * 60_000,
} as const);
/** Dashboard-owned bound applied before parsing privileged operation results. */
export const persistentGatewayOpenClawServiceActionResponseMaximumBytes = 2 * 1024 * 1024;
/** Dashboard-owned maximum number of cleanup stores aggregated into one result. */
export const persistentGatewayOpenClawCleanupStoreMaximum = 256;

export const persistentGatewayWebReadScopes = Object.freeze(["operator.read"] as const);
export const persistentGatewayTaskNotificationScopes = Object.freeze([
    "operator.write",
] as const);
export const persistentGatewayChatWriteScopes = Object.freeze([
    "operator.write",
] as const);
export const persistentGatewayAdminScopes = Object.freeze(["operator.admin"] as const);
export const persistentGatewaySessionScopedEventsCapability =
    "session-scoped-events" as const;

export type PersistentGatewayConnectionProfile =
    | "admin"
    | "chat-read-mutation"
    | "chat-write"
    | "task-notification-worker"
    | "web-read";

/** Exact Phase 4A application-event surface delivered beyond the transport boundary. */
export const persistentGatewayEventNames = Object.freeze([
    "cron",
    "session.message",
    "sessions.changed",
    "task",
] as const);

export type PersistentGatewayEventName = (typeof persistentGatewayEventNames)[number];

/** chat.send stays behind the task-notification port rather than the generic RPC port. */
export const persistentGatewayTaskNotificationMethod = "chat.send" as const;

/** Exact chat reads retained on the persistent operator.read connection. */
export const persistentGatewayChatReadMethods = Object.freeze([
    "chat.history",
    "chat.message.get",
    "models.list",
    "sessions.companion.state",
] as const);

/** Non-idempotent chat operation whose installed Gateway scope is operator.read. */
export const persistentGatewayChatReadMutationMethods = Object.freeze([
    "sessions.companion.ask",
] as const);

/** Exact chat mutations allowed on fresh, single-use operator.write sockets. */
export const persistentGatewayChatWriteMethods = Object.freeze([
    "chat.abort",
    "chat.send",
    "sessions.companion.reset",
] as const);

export type PersistentGatewayChatReadMethod =
    (typeof persistentGatewayChatReadMethods)[number];
export type PersistentGatewayChatReadMutationMethod =
    (typeof persistentGatewayChatReadMutationMethods)[number];
export type PersistentGatewayChatWriteMethod =
    (typeof persistentGatewayChatWriteMethods)[number];

/** Strict OpenClaw task reads retained on the persistent operator.read lane. */
export const persistentGatewayTaskReadMethods = Object.freeze([
    "tasks.get",
    "tasks.list",
] as const);
/** Strict task cancellation runs on a fresh one-shot operator.write lane. */
export const persistentGatewayTaskWriteMethods = Object.freeze(["tasks.cancel"] as const);
export type PersistentGatewayTaskReadMethod =
    (typeof persistentGatewayTaskReadMethods)[number];
export type PersistentGatewayTaskWriteMethod =
    (typeof persistentGatewayTaskWriteMethods)[number];

/** Dedicated Settings reads retained on the persistent operator.read lane. */
export const persistentGatewayOpenClawSettingsReadMethods = Object.freeze([
    "config.get",
    "skills.status",
] as const);
/** Dedicated Settings controls admitted only to fresh operator.admin sockets. */
export const persistentGatewayOpenClawSettingsWriteMethods = Object.freeze([
    "config.patch",
    "skills.update",
] as const);
export type PersistentGatewayOpenClawSettingsReadMethod =
    (typeof persistentGatewayOpenClawSettingsReadMethods)[number];
export type PersistentGatewayOpenClawSettingsWriteMethod =
    (typeof persistentGatewayOpenClawSettingsWriteMethods)[number];

/** Worker-only OpenClaw operations admitted only to fresh operator.admin sockets. */
export const persistentGatewayOpenClawServiceActionMethods = Object.freeze([
    "sessions.cleanup",
    "update.run",
] as const);
export type PersistentGatewayOpenClawServiceActionMethod =
    (typeof persistentGatewayOpenClawServiceActionMethods)[number];

/** Installed protocol-v4 top-level request error discriminants. */
export const persistentGatewayErrorCodes = Object.freeze([
    "AGENT_TIMEOUT",
    "APPROVAL_NOT_FOUND",
    "FORBIDDEN",
    "INVALID_REQUEST",
    "NOT_LINKED",
    "NOT_PAIRED",
    "UNAVAILABLE",
] as const);

export type PersistentGatewayErrorCode = (typeof persistentGatewayErrorCodes)[number];

/**
 * Exact long-lived data-plane surface. Dynamic session methods are additionally
 * constrained below so this lane can never silently require operator.admin.
 */
export const persistentGatewayWebReadMethods = Object.freeze([
    "cron.get",
    "cron.list",
    "cron.runs",
    "sessions.list",
    "system.info",
] as const);

/** @deprecated Use persistentGatewayWebReadMethods. */
export const persistentGatewayReadWriteMethods = persistentGatewayWebReadMethods;

/** Exact control-plane methods permitted on a fresh, single-use admin socket. */
export const persistentGatewayAdminMethods = Object.freeze([
    "cron.remove",
    "cron.run",
    "cron.scratch.get",
    "cron.scratch.set",
    "cron.update",
    "sessions.compact",
    "sessions.delete",
    "sessions.patch",
    "sessions.reset",
] as const);

export type PersistentGatewayWebReadMethod =
    (typeof persistentGatewayWebReadMethods)[number];
/** @deprecated Use PersistentGatewayWebReadMethod. */
export type PersistentGatewayReadWriteMethod = PersistentGatewayWebReadMethod;
export type PersistentGatewayAdminMethod = (typeof persistentGatewayAdminMethods)[number];

const webReadMethodSet = new Set<string>(persistentGatewayWebReadMethods);
const adminMethodSet = new Set<string>(persistentGatewayAdminMethods);
const chatReadMethodSet = new Set<string>(persistentGatewayChatReadMethods);
const chatReadMutationMethodSet = new Set<string>(
    persistentGatewayChatReadMutationMethods
);
const chatWriteMethodSet = new Set<string>(persistentGatewayChatWriteMethods);
const taskReadMethodSet = new Set<string>(persistentGatewayTaskReadMethods);
const taskWriteMethodSet = new Set<string>(persistentGatewayTaskWriteMethods);
const openClawSettingsReadMethodSet = new Set<string>(
    persistentGatewayOpenClawSettingsReadMethods
);
const openClawSettingsWriteMethodSet = new Set<string>(
    persistentGatewayOpenClawSettingsWriteMethods
);
const openClawServiceActionMethodSet = new Set<string>(
    persistentGatewayOpenClawServiceActionMethods
);
const eventNameSet = new Set<string>(persistentGatewayEventNames);

const boundedIdentifierSchema = v.pipe(
    v.string("Gateway frame identifier is invalid"),
    v.minLength(1, "Gateway frame identifier is invalid"),
    v.maxLength(128, "Gateway frame identifier is invalid")
);
const boundedProtocolNameSchema = v.pipe(
    v.string("Gateway protocol name is invalid"),
    v.minLength(1, "Gateway protocol name is invalid"),
    v.maxLength(256, "Gateway protocol name is invalid")
);
const nonnegativeSafeIntegerSchema = v.pipe(
    v.number("Gateway integer is invalid"),
    v.safeInteger("Gateway integer is invalid"),
    v.minValue(0, "Gateway integer is invalid")
);
const positiveSafeIntegerSchema = v.pipe(
    nonnegativeSafeIntegerSchema,
    v.minValue(1, "Gateway integer is invalid")
);
const gatewayScopeSchema = v.pipe(
    v.string("Gateway scope is invalid"),
    v.minLength(1, "Gateway scope is invalid"),
    v.maxLength(128, "Gateway scope is invalid")
);
const gatewayErrorSchema = v.object({
    code: v.picklist(persistentGatewayErrorCodes, "Gateway error code is invalid"),
    details: v.optional(v.unknown()),
    message: v.pipe(
        v.string("Gateway error message is invalid"),
        v.maxLength(4096, "Gateway error message is invalid")
    ),
    retryable: v.optional(v.boolean("Gateway retry policy is invalid")),
    retryAfterMs: v.optional(nonnegativeSafeIntegerSchema),
});

const gatewayResponseFrameSchema = v.object({
    error: v.optional(gatewayErrorSchema),
    id: boundedIdentifierSchema,
    ok: v.boolean("Gateway response outcome is invalid"),
    payload: v.optional(v.unknown()),
    type: v.literal("res"),
});

const gatewayStateVersionSchema = v.strictObject({
    health: nonnegativeSafeIntegerSchema,
    presence: nonnegativeSafeIntegerSchema,
});

const gatewayEventFrameSchema = v.strictObject({
    event: boundedProtocolNameSchema,
    payload: v.optional(v.unknown()),
    seq: v.optional(positiveSafeIntegerSchema),
    stateVersion: v.optional(gatewayStateVersionSchema),
    type: v.literal("event"),
});

const gatewayChallengeFrameSchema = v.object({
    event: v.literal("connect.challenge"),
    payload: v.object({
        nonce: v.pipe(
            v.string("Gateway challenge nonce is invalid"),
            v.minLength(1, "Gateway challenge nonce is invalid"),
            v.maxLength(256, "Gateway challenge nonce is invalid")
        ),
    }),
    type: v.literal("event"),
});

const gatewayHelloSchema = v.object({
    auth: v.object({
        role: v.literal("operator"),
        scopes: v.pipe(
            v.array(gatewayScopeSchema, "Gateway scopes are invalid"),
            v.maxLength(32, "Gateway scopes are invalid")
        ),
    }),
    features: v.object({
        events: v.pipe(
            v.array(boundedProtocolNameSchema, "Gateway event catalog is invalid"),
            v.maxLength(4096, "Gateway event catalog is invalid")
        ),
        methods: v.pipe(
            v.array(boundedProtocolNameSchema, "Gateway method catalog is invalid"),
            v.maxLength(4096, "Gateway method catalog is invalid")
        ),
    }),
    policy: v.object({
        maxBufferedBytes: positiveSafeIntegerSchema,
        maxPayload: positiveSafeIntegerSchema,
        tickIntervalMs: v.pipe(
            positiveSafeIntegerSchema,
            v.maxValue(5 * 60 * 1000, "Gateway tick policy is invalid")
        ),
    }),
    protocol: v.literal(openClawGatewayProtocolVersion),
    server: v.object({
        connId: boundedIdentifierSchema,
        version: v.pipe(
            v.string("Gateway server version is invalid"),
            v.minLength(1, "Gateway server version is invalid"),
            v.maxLength(256, "Gateway server version is invalid")
        ),
    }),
    snapshot: v.object({}),
    type: v.literal("hello-ok"),
});

const gatewayChatSendAcknowledgementSchema = v.object({
    runId: boundedIdentifierSchema,
    status: v.picklist(["started", "in_flight", "ok"]),
});

const gatewaySessionsSubscriptionAcknowledgementSchema = v.strictObject({
    subscribed: v.literal(true),
});

const chatSessionKeySchema = v.pipe(
    v.string("Gateway chat session key is invalid"),
    v.minLength(1, "Gateway chat session key is invalid"),
    v.maxLength(512, "Gateway chat session key is invalid"),
    v.check(hasNoControlCharacter, "Gateway chat session key is invalid")
);
const chatAgentIdSchema = v.pipe(
    v.string("Gateway chat agent id is invalid"),
    v.minLength(1, "Gateway chat agent id is invalid"),
    v.maxLength(512, "Gateway chat agent id is invalid"),
    v.check(hasNoControlCharacter, "Gateway chat agent id is invalid")
);
const chatRunIdSchema = v.pipe(
    v.string("Gateway chat run id is invalid"),
    v.minLength(1, "Gateway chat run id is invalid"),
    v.maxLength(256, "Gateway chat run id is invalid"),
    v.check(hasNoControlCharacter, "Gateway chat run id is invalid")
);
const chatMessageIdSchema = v.pipe(
    v.string("Gateway chat message id is invalid"),
    v.minLength(1, "Gateway chat message id is invalid"),
    v.maxLength(256, "Gateway chat message id is invalid"),
    v.check(hasNoControlCharacter, "Gateway chat message id is invalid")
);
const chatIdempotencyKeySchema = v.pipe(
    v.string("Gateway chat idempotency key is invalid"),
    v.minLength(16, "Gateway chat idempotency key is invalid"),
    v.maxLength(128, "Gateway chat idempotency key is invalid"),
    v.regex(/^[A-Za-z0-9_-]+$/u, "Gateway chat idempotency key is invalid")
);
const chatModelSchema = v.pipe(
    v.string("Gateway chat model is invalid"),
    v.maxLength(256, "Gateway chat model is invalid"),
    v.check(hasNoControlCharacter, "Gateway chat model is invalid")
);
const chatThinkingLevelSchema = v.pipe(
    v.string("Gateway chat thinking level is invalid"),
    v.maxLength(128, "Gateway chat thinking level is invalid"),
    v.check(hasNoControlCharacter, "Gateway chat thinking level is invalid")
);
const chatDeltaTextSchema = v.pipe(
    v.string("Gateway chat event text is invalid"),
    v.maxLength(64 * 1024, "Gateway chat event text is invalid"),
    v.check((text) => !text.includes("\0"), "Gateway chat event text is invalid")
);
const chatStopReasonSchema = v.pipe(
    v.string("Gateway chat stop reason is invalid"),
    v.maxLength(128, "Gateway chat stop reason is invalid"),
    v.check(hasNoControlCharacter, "Gateway chat stop reason is invalid")
);
const gatewaySessionLifecycleEventBaseSchemas = {
    sessionId: v.optional(chatRunIdSchema),
    sessionKey: v.optional(chatSessionKeySchema),
    ts: nonnegativeSafeIntegerSchema,
    updatedAt: v.optional(nonnegativeSafeIntegerSchema),
};
const gatewaySessionLifecycleEventSchema = v.variant("reason", [
    v.object({
        ...gatewaySessionLifecycleEventBaseSchemas,
        compacted: v.boolean("Gateway session lifecycle compaction state is invalid"),
        reason: v.literal("compact"),
    }),
    v.object({
        ...gatewaySessionLifecycleEventBaseSchemas,
        reason: v.literal("delete"),
    }),
    v.object({
        ...gatewaySessionLifecycleEventBaseSchemas,
        reason: v.literal("new"),
    }),
    v.object({
        ...gatewaySessionLifecycleEventBaseSchemas,
        reason: v.literal("reset"),
    }),
]);
const gatewaySessionActivityEventSchema = v.object({
    agentId: v.optional(chatAgentIdSchema),
    reason: v.optional(v.string()),
    sessionKey: chatSessionKeySchema,
    ts: nonnegativeSafeIntegerSchema,
    updatedAt: v.optional(nonnegativeSafeIntegerSchema),
});
const gatewayChatEventBaseSchemas = {
    agentId: v.optional(chatAgentIdSchema),
    runId: chatRunIdSchema,
    seq: positiveSafeIntegerSchema,
    sessionKey: chatSessionKeySchema,
};
const gatewayChatEventSchema = v.variant("state", [
    v.object({
        ...gatewayChatEventBaseSchemas,
        phase: v.picklist([
            "preparing_workspace",
            "provisioning_environment",
            "preparing_context",
            "starting_model",
        ]),
        state: v.literal("status"),
    }),
    v.object({
        ...gatewayChatEventBaseSchemas,
        deltaText: chatDeltaTextSchema,
        replace: v.optional(v.boolean()),
        state: v.literal("delta"),
    }),
    v.object({
        ...gatewayChatEventBaseSchemas,
        state: v.literal("final"),
        stopReason: v.optional(chatStopReasonSchema),
    }),
    v.object({
        ...gatewayChatEventBaseSchemas,
        state: v.literal("aborted"),
        stopReason: v.optional(chatStopReasonSchema),
    }),
    v.object({
        ...gatewayChatEventBaseSchemas,
        errorKind: v.optional(
            v.picklist(["refusal", "timeout", "rate_limit", "context_length", "unknown"])
        ),
        state: v.literal("error"),
        stopReason: v.optional(chatStopReasonSchema),
    }),
]);
/** Maximum encoded size of the allowlisted agent-stream data projection. */
export const persistentGatewayAgentEventDataMaximumBytes = 128 * 1024;
const gatewayAgentEventDataSchema = v.pipe(
    v.object({
        args: v.optional(v.unknown()),
        callId: v.optional(v.unknown()),
        completed: v.optional(v.unknown()),
        delta: v.optional(v.unknown()),
        explanation: v.optional(v.unknown()),
        input: v.optional(v.unknown()),
        isReasoningSnapshot: v.optional(v.unknown()),
        isError: v.optional(v.unknown()),
        item: v.optional(v.unknown()),
        itemId: v.optional(v.unknown()),
        kind: v.optional(v.unknown()),
        name: v.optional(v.unknown()),
        output: v.optional(v.unknown()),
        partialResult: v.optional(v.unknown()),
        payload: v.optional(v.unknown()),
        phase: v.optional(v.unknown()),
        progressText: v.optional(v.unknown()),
        replace: v.optional(v.unknown()),
        result: v.optional(v.unknown()),
        steps: v.optional(v.unknown()),
        text: v.optional(v.unknown()),
        tool_call_id: v.optional(v.unknown()),
        tool_name: v.optional(v.unknown()),
        toolCallId: v.optional(v.unknown()),
        toolName: v.optional(v.unknown()),
        type: v.optional(v.unknown()),
        willRetry: v.optional(v.unknown()),
    }),
    v.check(
        (data) =>
            jsonValueFitsByteBudget(data, persistentGatewayAgentEventDataMaximumBytes),
        "Gateway agent event data is outside its budget"
    )
);
const gatewaySupportedAgentStreams = Object.freeze([
    "assistant",
    "compaction",
    "thinking",
    "tool",
    "item",
    "plan",
    "run_status",
] as const);
const gatewayAgentEventSchema = v.object({
    agentId: v.optional(chatAgentIdSchema),
    data: gatewayAgentEventDataSchema,
    runId: chatRunIdSchema,
    seq: positiveSafeIntegerSchema,
    sessionKey: chatSessionKeySchema,
    stream: v.picklist(gatewaySupportedAgentStreams),
    ts: nonnegativeSafeIntegerSchema,
});
const gatewayUnsupportedAgentEventSchema = v.object({
    agentId: v.optional(chatAgentIdSchema),
    data: v.pipe(
        v.unknown(),
        v.check(
            (data) =>
                jsonValueFitsByteBudget(
                    data,
                    persistentGatewayAgentEventDataMaximumBytes
                ),
            "Gateway unsupported agent event data is outside its budget"
        )
    ),
    runId: chatRunIdSchema,
    seq: positiveSafeIntegerSchema,
    sessionKey: chatSessionKeySchema,
    stream: boundedProtocolNameSchema,
    ts: nonnegativeSafeIntegerSchema,
});
const gatewaySessionMessagesSubscriptionAcknowledgementSchema = v.strictObject({
    key: chatSessionKeySchema,
    subscribed: v.boolean(),
});

const gatewayChatHistoryParamsSchema = v.pipe(
    v.strictObject({
        agentId: v.optional(chatAgentIdSchema),
        limit: v.optional(v.pipe(positiveSafeIntegerSchema, v.maxValue(1000))),
        maxChars: v.optional(
            v.pipe(
                positiveSafeIntegerSchema,
                v.maxValue(persistentGatewayChatHistoryMaximumChars)
            )
        ),
        messageId: v.optional(chatMessageIdSchema),
        offset: v.optional(nonnegativeSafeIntegerSchema),
        sessionId: v.optional(chatRunIdSchema),
        sessionKey: chatSessionKeySchema,
    }),
    v.check(
        ({ messageId, offset, sessionId }) =>
            !(messageId !== undefined && offset !== undefined) &&
            !(sessionId !== undefined && messageId === undefined),
        "Gateway chat history parameters are invalid"
    )
);
const gatewayChatMessageGetParamsSchema = v.strictObject({
    agentId: v.optional(chatAgentIdSchema),
    maxChars: v.optional(v.pipe(positiveSafeIntegerSchema, v.maxValue(1024 * 1024))),
    messageId: chatMessageIdSchema,
    sessionKey: chatSessionKeySchema,
});
const gatewayModelsListParamsSchema = v.strictObject({
    agentId: chatAgentIdSchema,
    includeProviderCapabilities: v.literal(true),
    view: v.literal("all"),
});
const gatewayCompanionStateParamsSchema = v.strictObject({
    sessionKey: chatSessionKeySchema,
});
const gatewayCompanionAskParamsSchema = v.strictObject({
    question: v.pipe(
        v.string("Gateway companion question is invalid"),
        v.trim(),
        v.minLength(1, "Gateway companion question is invalid"),
        v.maxLength(400, "Gateway companion question is invalid")
    ),
    sessionKey: chatSessionKeySchema,
});

const gatewayChatAttachmentSchema = v.strictObject({
    content: v.pipe(
        v.string("Gateway chat attachment content is invalid"),
        v.maxLength(
            Math.ceil(chatAttachmentLimits.maximumFileBytes / 3) * 4,
            "Gateway chat attachment content is invalid"
        ),
        v.check(isCanonicalBase64, "Gateway chat attachment content is invalid")
    ),
    fileName: v.pipe(
        v.string("Gateway chat attachment file name is invalid"),
        v.minLength(1, "Gateway chat attachment file name is invalid"),
        v.maxLength(255, "Gateway chat attachment file name is invalid"),
        v.check(hasNoControlCharacter, "Gateway chat attachment file name is invalid")
    ),
    mimeType: v.pipe(
        v.string("Gateway chat attachment MIME type is invalid"),
        v.maxLength(127, "Gateway chat attachment MIME type is invalid"),
        v.regex(
            /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u,
            "Gateway chat attachment MIME type is invalid"
        )
    ),
    sizeBytes: v.pipe(
        positiveSafeIntegerSchema,
        v.maxValue(chatAttachmentLimits.maximumFileBytes)
    ),
    type: v.literal("file"),
});
const maximumSerializedGatewayRequestId = "\uD800".repeat(128);
const gatewayChatSendParamsObjectSchema = v.strictObject({
    attachments: v.optional(
        v.pipe(v.array(gatewayChatAttachmentSchema), v.maxLength(10))
    ),
    expectedRunId: v.optional(chatRunIdSchema),
    fastMode: v.optional(v.union([v.boolean(), v.literal("auto")])),
    idempotencyKey: chatIdempotencyKeySchema,
    message: v.pipe(
        v.string("Gateway chat message is invalid"),
        v.maxLength(256 * 1024, "Gateway chat message is invalid")
    ),
    queueMode: v.optional(v.picklist(["collect", "followup", "interrupt", "steer"])),
    sessionKey: chatSessionKeySchema,
    thinking: v.optional(chatThinkingLevelSchema),
});

function gatewayChatSendFitsOutboundFrame(
    parameters: v.InferOutput<typeof gatewayChatSendParamsObjectSchema>
): boolean {
    try {
        return (
            Buffer.byteLength(
                JSON.stringify({
                    id: maximumSerializedGatewayRequestId,
                    method: "chat.send",
                    params: parameters,
                    type: "req",
                }),
                "utf8"
            ) <= persistentGatewayChatOutboundFrameMaximumBytes
        );
    } catch {
        return false;
    }
}

const gatewayChatSendParamsSchema = v.pipe(
    gatewayChatSendParamsObjectSchema,
    v.check(
        ({ attachments }) =>
            (attachments ?? []).every(
                (attachment) =>
                    decodedBase64Bytes(attachment.content) <=
                        chatAttachmentLimits.maximumFileBytes &&
                    decodedBase64Bytes(attachment.content) === attachment.sizeBytes
            ) &&
            (attachments ?? []).reduce(
                (bytes, attachment) => bytes + decodedBase64Bytes(attachment.content),
                0
            ) <= chatAttachmentLimits.maximumAggregateRawBytes,
        "Gateway chat attachments exceed their aggregate raw-byte budget"
    ),
    v.check(
        gatewayChatSendFitsOutboundFrame,
        "Gateway chat send exceeds its serialized frame budget"
    )
);
const gatewayChatAbortParamsSchema = v.strictObject({
    preserveSideRuns: v.literal(false),
    runId: v.optional(chatRunIdSchema),
    sessionKey: chatSessionKeySchema,
});
const gatewayCompanionResetParamsSchema = gatewayCompanionStateParamsSchema;
const gatewayChatSessionPatchParamsSchema = v.strictObject({
    agentId: chatAgentIdSchema,
    expectedSessionId: v.optional(chatRunIdSchema),
    fastMode: v.optional(v.nullable(v.union([v.boolean(), v.literal("auto")]))),
    key: chatSessionKeySchema,
    model: v.optional(v.nullable(chatModelSchema)),
    thinkingLevel: v.optional(v.nullable(chatThinkingLevelSchema)),
});

const gatewayOpenClawSettingsEmptyParamsSchema = v.strictObject({});
const gatewayOpenClawSkillUpdateParamsSchema = v.strictObject({
    enabled: v.boolean("OpenClaw skill enabled state is invalid"),
    skillKey: openClawSkillKeySchema,
});
const gatewayOpenClawSessionsCleanupParamsSchema = v.strictObject({
    allAgents: v.literal(true),
    enforce: v.literal(true),
});
const gatewayOpenClawInstallationUpdateParamsSchema = v.strictObject({
    timeoutMs: v.literal(persistentGatewayOpenClawUpdateTimeoutMs),
});
const gatewayOpenClawOperationSensitiveTextSchema = v.pipe(
    v.string("OpenClaw operation response text is invalid"),
    v.maxLength(32 * 1024, "OpenClaw operation response text is invalid")
);
const gatewayOpenClawCleanupArtifactsSchema = v.strictObject({
    freedBytes: nonnegativeSafeIntegerSchema,
    olderThanMs: nonnegativeSafeIntegerSchema,
    removedFiles: nonnegativeSafeIntegerSchema,
    scannedFiles: nonnegativeSafeIntegerSchema,
});
const gatewayOpenClawCleanupDiskBudgetSchema = v.nullable(
    v.strictObject({
        freedBytes: nonnegativeSafeIntegerSchema,
        highWaterBytes: nonnegativeSafeIntegerSchema,
        maxBytes: nonnegativeSafeIntegerSchema,
        overBudget: v.boolean(),
        removedEntries: nonnegativeSafeIntegerSchema,
        removedFiles: nonnegativeSafeIntegerSchema,
        totalBytesAfter: nonnegativeSafeIntegerSchema,
        totalBytesBefore: nonnegativeSafeIntegerSchema,
    })
);
const gatewayOpenClawCleanupStoreSchema = v.strictObject({
    afterCount: nonnegativeSafeIntegerSchema,
    agentId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    applied: v.literal(true),
    appliedCount: nonnegativeSafeIntegerSchema,
    beforeCount: nonnegativeSafeIntegerSchema,
    capped: nonnegativeSafeIntegerSchema,
    diskBudget: gatewayOpenClawCleanupDiskBudgetSchema,
    dmScopeRetired: nonnegativeSafeIntegerSchema,
    dryRun: v.literal(false),
    missing: nonnegativeSafeIntegerSchema,
    mode: v.literal("enforce"),
    modelRunPruned: nonnegativeSafeIntegerSchema,
    pruned: nonnegativeSafeIntegerSchema,
    storePath: gatewayOpenClawOperationSensitiveTextSchema,
    unreferencedArtifacts: gatewayOpenClawCleanupArtifactsSchema,
    wouldMutate: v.boolean(),
});
const gatewayOpenClawCleanupResponseSchema = v.union([
    gatewayOpenClawCleanupStoreSchema,
    v.strictObject({
        allAgents: v.literal(true),
        dryRun: v.literal(false),
        mode: v.literal("enforce"),
        stores: v.pipe(
            v.array(gatewayOpenClawCleanupStoreSchema),
            v.maxLength(persistentGatewayOpenClawCleanupStoreMaximum)
        ),
    }),
]);
const gatewayOpenClawVersionSchema = v.pipe(
    v.string("OpenClaw update version is invalid"),
    v.minLength(1, "OpenClaw update version is invalid"),
    v.maxLength(128, "OpenClaw update version is invalid"),
    v.regex(
        /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
        "OpenClaw update version is invalid"
    )
);
const gatewayOpenClawUpdateVersionProjectionSchema = v.object({
    version: gatewayOpenClawVersionSchema,
});
const gatewayOpenClawUpdateResultSchema = v.object({
    after: v.optional(gatewayOpenClawUpdateVersionProjectionSchema),
    before: v.optional(gatewayOpenClawUpdateVersionProjectionSchema),
    status: v.picklist(["error", "ok", "skipped"]),
});
const gatewayOpenClawUpdateHandoffSchema = v.object({
    status: v.picklist(["already-running", "started", "unavailable"]),
});
const gatewayOpenClawUpdateResponseSchema = v.strictObject({
    handoff: v.optional(gatewayOpenClawUpdateHandoffSchema),
    ok: v.boolean(),
    restart: v.unknown(),
    result: gatewayOpenClawUpdateResultSchema,
    sentinel: v.unknown(),
});
const gatewayOpenClawSettingsNullableTextSchema = (maximum: number) =>
    v.nullable(
        v.pipe(
            v.string("OpenClaw settings text is invalid"),
            v.minLength(1, "OpenClaw settings text is invalid"),
            v.maxLength(maximum, "OpenClaw settings text is invalid"),
            v.check((value) => /\S/u.test(value), "OpenClaw settings text is invalid"),
            v.check(hasNoUnicodeControlOrFormat, "OpenClaw settings text is invalid")
        )
    );
const gatewayOpenClawSettingsHeartbeatSecondsSchema = v.pipe(
    v.string("OpenClaw heartbeat interval is invalid"),
    v.regex(/^(?:[1-9][0-9]{1,4})s$/u, "OpenClaw heartbeat interval is invalid"),
    v.check((value) => {
        const seconds = Number(value.slice(0, -1));
        return seconds >= 10 && seconds <= 86_400;
    }, "OpenClaw heartbeat interval is invalid")
);
const gatewayOpenClawSettingsChannelsSchema = v.pipe(
    v.record(openClawChannelIdSchema, v.strictObject({ enabled: v.boolean() })),
    v.check((channels) => {
        const ids = Object.keys(channels);
        return (
            ids.length > 0 &&
            ids.length <= openClawChannelMaximum &&
            !ids.includes("defaults") &&
            !ids.includes("modelByChannel")
        );
    }, "OpenClaw channels are outside their budget")
);
const gatewayOpenClawModelFallbacksSchema = v.pipe(
    v.array(openClawModelIdSchema),
    v.maxLength(openClawModelFallbackMaximum),
    v.check(
        (fallbacks) => new Set(fallbacks).size === fallbacks.length,
        "OpenClaw model fallbacks must be unique"
    )
);
const gatewayOpenClawModelLeavesSchema = v.pipe(
    v.strictObject({
        fallbacks: v.optional(gatewayOpenClawModelFallbacksSchema),
        primary: v.optional(openClawModelIdSchema),
    }),
    v.check(
        (model) => Object.keys(model).length > 0,
        "OpenClaw model patch must contain a changed leaf"
    )
);
const gatewayOpenClawModelsPatchSchema = v.strictObject({
    agents: v.strictObject({
        defaults: v.strictObject({
            model: gatewayOpenClawModelLeavesSchema,
        }),
    }),
});
const gatewayOpenClawSessionResetPatchSchema = v.strictObject({
    session: v.strictObject({
        reset: v.strictObject({
            idleMinutes: v.pipe(positiveSafeIntegerSchema, v.maxValue(10_080)),
            mode: v.literal("idle"),
        }),
    }),
});
const gatewayOpenClawHeartbeatLeavesSchema = v.pipe(
    v.strictObject({
        every: v.optional(gatewayOpenClawSettingsHeartbeatSecondsSchema),
        target: v.optional(gatewayOpenClawSettingsNullableTextSchema(128)),
    }),
    v.check(
        (heartbeat) => Object.keys(heartbeat).length > 0,
        "OpenClaw heartbeat patch must contain a changed leaf"
    )
);
const gatewayOpenClawHeartbeatPatchSchema = v.strictObject({
    agents: v.strictObject({
        defaults: v.strictObject({
            heartbeat: gatewayOpenClawHeartbeatLeavesSchema,
        }),
    }),
});
const gatewayOpenClawToolsSearchPatchSchema = v.pipe(
    v.strictObject({
        enabled: v.optional(v.boolean()),
        provider: v.optional(gatewayOpenClawSettingsNullableTextSchema(64)),
    }),
    v.check(
        (search) => Object.keys(search).length > 0,
        "OpenClaw web-search patch must contain a changed leaf"
    )
);
const gatewayOpenClawToolsWebPatchSchema = v.pipe(
    v.strictObject({
        fetch: v.optional(v.strictObject({ enabled: v.boolean() })),
        search: v.optional(gatewayOpenClawToolsSearchPatchSchema),
    }),
    v.check(
        (web) => Object.keys(web).length > 0,
        "OpenClaw web-tools patch must contain a changed leaf"
    )
);
const gatewayOpenClawToolsLeavesSchema = v.pipe(
    v.strictObject({
        agentToAgent: v.optional(v.strictObject({ enabled: v.boolean() })),
        elevated: v.optional(v.strictObject({ enabled: v.boolean() })),
        exec: v.optional(
            v.strictObject({
                ask: v.picklist(["off", "on-miss", "always"]),
                security: v.picklist(["allowlist", "deny", "full"]),
            })
        ),
        profile: v.optional(gatewayOpenClawSettingsNullableTextSchema(64)),
        sessions: v.optional(
            v.strictObject({
                visibility: v.nullable(v.picklist(["agent", "all", "self", "tree"])),
            })
        ),
        web: v.optional(gatewayOpenClawToolsWebPatchSchema),
    }),
    v.check(
        (tools) => Object.keys(tools).length > 0,
        "OpenClaw tools patch must contain a changed leaf"
    )
);
const gatewayOpenClawToolsPatchSchema = v.strictObject({
    tools: gatewayOpenClawToolsLeavesSchema,
});
const gatewayOpenClawChannelsPatchSchema = v.strictObject({
    channels: gatewayOpenClawSettingsChannelsSchema,
});
const gatewayOpenClawAgentToolPolicyListSchema = v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(256), v.check(hasNoUnicodeControlOrFormat))),
    v.maxLength(512)
);
const gatewayOpenClawAgentToolPatchSchema = v.strictObject({
    agents: v.strictObject({
        entries: v.pipe(
            v.record(
                openClawAgentIdSchema,
                v.strictObject({
                    tools: v.strictObject({
                        alsoAllow: gatewayOpenClawAgentToolPolicyListSchema,
                        deny: gatewayOpenClawAgentToolPolicyListSchema,
                    }),
                })
            ),
            v.check(
                (entries) => Object.keys(entries).length === 1,
                "OpenClaw agent tool patch must contain exactly one entry"
            )
        ),
    }),
});
const gatewayOpenClawConfigPatchRawSchema = v.union([
    gatewayOpenClawAgentToolPatchSchema,
    gatewayOpenClawChannelsPatchSchema,
    gatewayOpenClawHeartbeatPatchSchema,
    gatewayOpenClawModelsPatchSchema,
    gatewayOpenClawSessionResetPatchSchema,
    gatewayOpenClawToolsPatchSchema,
]);
const gatewayOpenClawConfigPatchParamsSchema = v.strictObject({
    baseHash: openClawConfigHashSchema,
    note: v.literal("Updated from Mira Dashboard settings"),
    raw: v.pipe(
        v.string("OpenClaw settings patch is invalid"),
        v.check(
            (raw) =>
                Buffer.byteLength(raw, "utf8") <=
                persistentGatewayOpenClawSettingsPatchMaximumBytes,
            "OpenClaw settings patch is outside its budget"
        )
    ),
    replacePaths: v.optional(
        v.pipe(
            v.array(v.pipe(v.string(), v.maxLength(256), v.check(hasNoControlCharacter))),
            v.minLength(1),
            v.maxLength(2)
        )
    ),
});
function configPatchParametersAreExact(parameters: unknown): boolean {
    const parsedParameters = v.safeParse(
        gatewayOpenClawConfigPatchParamsSchema,
        parameters
    );
    if (!parsedParameters.success) return false;
    let rawPatch: unknown;
    try {
        rawPatch = JSON.parse(parsedParameters.output.raw) as unknown;
    } catch {
        return false;
    }
    const parsedPatch = v.safeParse(gatewayOpenClawConfigPatchRawSchema, rawPatch);
    if (!parsedPatch.success) return false;
    const modelsPatch = v.safeParse(gatewayOpenClawModelsPatchSchema, rawPatch);
    if (modelsPatch.success) {
        const fallbacks = modelsPatch.output.agents.defaults.model.fallbacks;
        return fallbacks === undefined
            ? parsedParameters.output.replacePaths === undefined
            : parsedParameters.output.replacePaths?.length === 1 &&
                  parsedParameters.output.replacePaths[0] ===
                      "agents.defaults.model.fallbacks";
    }
    const agentPatch = v.safeParse(gatewayOpenClawAgentToolPatchSchema, rawPatch);
    if (agentPatch.success) {
        const agentId = Object.keys(agentPatch.output.agents.entries)[0];
        if (agentId === undefined) return false;
        return (
            parsedParameters.output.replacePaths?.length === 2 &&
            parsedParameters.output.replacePaths[0] ===
                `agents.entries.${agentId}.tools.alsoAllow` &&
            parsedParameters.output.replacePaths[1] ===
                `agents.entries.${agentId}.tools.deny`
        );
    }
    return parsedParameters.output.replacePaths === undefined;
}

const gatewayTaskStatusSchema = v.picklist([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
]);
const gatewayTaskIdSchema = v.pipe(
    v.string("Gateway task id is invalid"),
    v.minLength(1, "Gateway task id is invalid"),
    v.maxLength(256, "Gateway task id is invalid"),
    v.check(hasNoControlCharacter, "Gateway task id is invalid")
);
const gatewayTaskListParamsSchema = v.strictObject({
    agentId: v.optional(chatAgentIdSchema),
    cursor: v.optional(
        v.pipe(
            v.string("Gateway task cursor is invalid"),
            v.regex(/^(?:0|[1-9][0-9]*)$/u, "Gateway task cursor is invalid"),
            v.check(
                (cursor) => Number.isSafeInteger(Number(cursor)),
                "Gateway task cursor is invalid"
            )
        )
    ),
    limit: v.pipe(positiveSafeIntegerSchema, v.maxValue(200)),
    sessionKey: v.optional(chatSessionKeySchema),
    status: v.optional(
        v.pipe(
            v.array(gatewayTaskStatusSchema),
            v.minLength(1),
            v.maxLength(6),
            v.check((statuses) => new Set(statuses).size === statuses.length)
        )
    ),
});
const gatewayTaskGetParamsSchema = v.strictObject({ taskId: gatewayTaskIdSchema });
const gatewayTaskCancelParamsSchema = v.strictObject({
    reason: v.optional(
        v.pipe(
            v.string("Gateway task cancellation reason is invalid"),
            v.minLength(1, "Gateway task cancellation reason is invalid"),
            v.maxLength(500, "Gateway task cancellation reason is invalid"),
            v.check(
                (reason) => !reason.includes("\0"),
                "Gateway task cancellation reason is invalid"
            )
        )
    ),
    taskId: gatewayTaskIdSchema,
});

export interface PersistentGatewayResponseFrame {
    readonly error?: {
        readonly code: PersistentGatewayErrorCode;
        readonly details?: unknown;
        readonly message: string;
        readonly retryable?: boolean;
        readonly retryAfterMs?: number;
    };
    readonly id: string;
    readonly ok: boolean;
    readonly payload?: unknown;
    readonly type: "res";
}

export interface PersistentGatewayEventFrame {
    readonly event: PersistentGatewayEventName;
    readonly sessionMessage?: PersistentGatewaySessionMessageEvent;
    readonly sessionActivity?: PersistentGatewaySessionActivityEvent;
    readonly sessionLifecycle?: PersistentGatewaySessionLifecycleEvent;
    readonly seq?: number;
    readonly type: "event";
}

/** Sanitized canonical transcript update projected from session.message. */
export interface PersistentGatewaySessionMessageEvent {
    readonly sessionKey: string;
    readonly userMessage?: Readonly<{
        readonly attachments: readonly PersistentGatewaySessionAttachment[];
        readonly idempotencyKey: string;
        readonly messageId: string;
        readonly providerRunIds: readonly string[];
        readonly text: string;
    }>;
}

export interface PersistentGatewaySessionAttachment {
    readonly contentType: string;
    readonly fileName: string;
    readonly sizeBytes?: number;
    readonly url: string;
}

/** Sanitized ordinary session activity projected from sessions.changed. */
export interface PersistentGatewaySessionActivityEvent {
    readonly agentId?: string;
    readonly occurredAtMs: number;
    readonly reason?: string;
    readonly sessionKey: string;
    readonly updatedAtMs?: number;
}

/** Sanitized session transcript-generation boundary projected from sessions.changed. */
export interface PersistentGatewaySessionLifecycleEvent {
    readonly compacted?: boolean;
    readonly occurredAtMs: number;
    readonly reason: "compact" | "delete" | "new" | "reset";
    readonly sessionId?: string;
    readonly sessionKey?: string;
    readonly updatedAtMs?: number;
}

/** Payload-free projection used to consume every valid authenticated event safely. */
export interface PersistentGatewayEventEnvelope {
    readonly event: string;
    readonly seq?: number;
    readonly type: "event";
}

export type PersistentGatewayChatEvent =
    | Readonly<{
          readonly agentId?: string;
          readonly phase:
              | "preparing_workspace"
              | "provisioning_environment"
              | "preparing_context"
              | "starting_model";
          readonly runId: string;
          readonly seq: number;
          readonly sessionKey: string;
          readonly state: "status";
      }>
    | Readonly<{
          readonly agentId?: string;
          readonly deltaText: string;
          readonly replace?: boolean;
          readonly runId: string;
          readonly seq: number;
          readonly sessionKey: string;
          readonly state: "delta";
      }>
    | Readonly<{
          readonly agentId?: string;
          readonly runId: string;
          readonly seq: number;
          readonly sessionKey: string;
          readonly state: "final";
          readonly stopReason?: string;
      }>
    | Readonly<{
          readonly agentId?: string;
          readonly runId: string;
          readonly seq: number;
          readonly sessionKey: string;
          readonly state: "aborted";
          readonly stopReason?: string;
      }>
    | Readonly<{
          readonly agentId?: string;
          readonly errorKind?:
              | "refusal"
              | "timeout"
              | "rate_limit"
              | "context_length"
              | "unknown";
          readonly errorMessage?: string;
          readonly runId: string;
          readonly seq: number;
          readonly sessionKey: string;
          readonly state: "error";
          readonly stopReason?: string;
      }>;

export interface PersistentGatewayAgentEvent {
    readonly agentId?: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly runId: string;
    readonly seq: number;
    readonly sessionKey: string;
    readonly stream:
        | "assistant"
        | "compaction"
        | "thinking"
        | "tool"
        | "item"
        | "plan"
        | "run_status"
        | "unsupported";
    readonly ts: number;
}

export type PersistentGatewayPrivateChatEvent =
    | Readonly<{ event: "agent"; payload: PersistentGatewayAgentEvent }>
    | Readonly<{ event: "chat"; payload: PersistentGatewayChatEvent }>;

export interface PersistentGatewayHello {
    readonly auth: { readonly role: "operator"; readonly scopes: readonly string[] };
    readonly features: {
        readonly events: readonly string[];
        readonly methods: readonly string[];
    };
    readonly policy: {
        readonly maxBufferedBytes: number;
        readonly maxPayload: number;
        readonly tickIntervalMs: number;
    };
    readonly protocol: typeof openClawGatewayProtocolVersion;
    readonly server: { readonly connId: string; readonly version: string };
    readonly snapshot: Readonly<Record<string, never>>;
    readonly type: "hello-ok";
}

export interface PersistentGatewayConnectFrameInput {
    readonly clientVersion: string;
    readonly credential: string;
    readonly instanceId: string;
    readonly profile: PersistentGatewayConnectionProfile;
    readonly requestId: string;
}

function hasExactScopes(actual: readonly string[], expected: readonly string[]): boolean {
    return (
        actual.length === expected.length &&
        new Set(actual).size === actual.length &&
        expected.every((scope) => actual.includes(scope))
    );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValueFitsByteBudget(value: unknown, maximumBytes: number): boolean {
    try {
        const encoded = JSON.stringify(value);
        return (
            typeof encoded === "string" &&
            Buffer.byteLength(encoded, "utf8") <= maximumBytes
        );
    } catch {
        return false;
    }
}

function hasNoControlCharacter(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
            return false;
        }
    }
    return true;
}

function canonicalBase64Padding(value: string): number {
    if (value.endsWith("==")) return 2;
    return value.endsWith("=") ? 1 : 0;
}

function isCanonicalBase64(value: string): boolean {
    if (value.length === 0 || value.length % 4 !== 0) return false;
    const padding = canonicalBase64Padding(value);
    const contentLength = value.length - padding;
    if (contentLength % 4 === 1) return false;
    for (let index = 0; index < contentLength; index += 1) {
        const code = value.codePointAt(index);
        if (
            code === undefined ||
            !(
                (code >= 65 && code <= 90) ||
                (code >= 97 && code <= 122) ||
                (code >= 48 && code <= 57) ||
                code === 43 ||
                code === 47
            )
        ) {
            return false;
        }
    }
    return true;
}

function decodedBase64Bytes(value: string): number {
    if (!isCanonicalBase64(value)) return Number.POSITIVE_INFINITY;
    const padding = canonicalBase64Padding(value);
    return (value.length / 4) * 3 - padding;
}

function scopesForProfile(
    profile: PersistentGatewayConnectionProfile
):
    | typeof persistentGatewayAdminScopes
    | typeof persistentGatewayChatWriteScopes
    | typeof persistentGatewayWebReadScopes {
    switch (profile) {
        case "admin": {
            return persistentGatewayAdminScopes;
        }
        case "chat-read-mutation": {
            return persistentGatewayWebReadScopes;
        }
        case "chat-write": {
            return persistentGatewayChatWriteScopes;
        }
        case "task-notification-worker": {
            return persistentGatewayTaskNotificationScopes;
        }
        case "web-read": {
            return persistentGatewayWebReadScopes;
        }
    }
}

function displayNameForProfile(profile: PersistentGatewayConnectionProfile): string {
    switch (profile) {
        case "admin": {
            return "Mira Dashboard bounded admin request";
        }
        case "chat-read-mutation": {
            return "Mira Dashboard bounded chat read-scope mutation";
        }
        case "chat-write": {
            return "Mira Dashboard bounded chat write";
        }
        case "task-notification-worker": {
            return "Mira Dashboard task notification worker";
        }
        case "web-read": {
            return "Mira Dashboard persistent web reads";
        }
    }
}

function capabilitiesForProfile(
    _profile: PersistentGatewayConnectionProfile
): readonly string[] {
    return [persistentGatewaySessionScopedEventsCapability];
}

/**
 * Returns whether an untrusted name belongs to the long-lived lane.
 * @param method Candidate Gateway method.
 * @returns Whether the method belongs to the generic data-plane allowlist.
 */
export function isPersistentGatewayReadWriteMethod(
    method: string
): method is PersistentGatewayReadWriteMethod {
    return webReadMethodSet.has(method);
}

/**
 * Returns whether an untrusted name belongs to the single-use admin lane.
 * @param method Candidate Gateway method.
 * @returns Whether the method belongs to the bounded control-plane allowlist.
 */
export function isPersistentGatewayAdminMethod(
    method: string
): method is PersistentGatewayAdminMethod {
    return adminMethodSet.has(method);
}

export function isPersistentGatewayChatReadMethod(
    method: string
): method is PersistentGatewayChatReadMethod {
    return chatReadMethodSet.has(method);
}

export function isPersistentGatewayChatReadMutationMethod(
    method: string
): method is PersistentGatewayChatReadMutationMethod {
    return chatReadMutationMethodSet.has(method);
}

export function isPersistentGatewayChatWriteMethod(
    method: string
): method is PersistentGatewayChatWriteMethod {
    return chatWriteMethodSet.has(method);
}

export function isPersistentGatewayTaskReadMethod(
    method: string
): method is PersistentGatewayTaskReadMethod {
    return taskReadMethodSet.has(method);
}

export function isPersistentGatewayTaskWriteMethod(
    method: string
): method is PersistentGatewayTaskWriteMethod {
    return taskWriteMethodSet.has(method);
}

export function isPersistentGatewayOpenClawSettingsReadMethod(
    method: string
): method is PersistentGatewayOpenClawSettingsReadMethod {
    return openClawSettingsReadMethodSet.has(method);
}

export function isPersistentGatewayOpenClawSettingsWriteMethod(
    method: string
): method is PersistentGatewayOpenClawSettingsWriteMethod {
    return openClawSettingsWriteMethodSet.has(method);
}

export function isPersistentGatewayOpenClawServiceActionMethod(
    method: string
): method is PersistentGatewayOpenClawServiceActionMethod {
    return openClawServiceActionMethodSet.has(method);
}

/**
 * Enforces the installed Gateway's dynamic least-privilege rules before a
 * request reaches the long-lived read/write socket.
 */
export function assertPersistentGatewayReadWriteParameters(
    _method: PersistentGatewayReadWriteMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    if (!isRecord(parameters)) {
        throw new TypeError("Persistent Gateway request parameters are invalid");
    }
}

/** Admin parameters remain method-bound and must at least be one JSON object. */
export function assertPersistentGatewayAdminParameters(
    method: PersistentGatewayAdminMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    if (!isRecord(parameters)) {
        throw new TypeError("Persistent Gateway request parameters are invalid");
    }
    if (method === "sessions.patch") {
        const parsed = v.safeParse(gatewayChatSessionPatchParamsSchema, parameters);
        if (!parsed.success) {
            throw new TypeError("Persistent Gateway request parameters are invalid");
        }
    }
}

export function assertPersistentGatewayOpenClawSettingsReadParameters(
    _method: PersistentGatewayOpenClawSettingsReadMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    if (!v.safeParse(gatewayOpenClawSettingsEmptyParamsSchema, parameters).success) {
        throw new TypeError("Persistent Gateway request parameters are invalid");
    }
}

export function assertPersistentGatewayOpenClawSettingsWriteParameters(
    method: PersistentGatewayOpenClawSettingsWriteMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    const valid =
        method === "config.patch"
            ? configPatchParametersAreExact(parameters)
            : v.safeParse(gatewayOpenClawSkillUpdateParamsSchema, parameters).success;
    if (!valid) {
        throw new TypeError("Persistent Gateway request parameters are invalid");
    }
}

/** Locks worker-owned Service Actions to their source-audited fixed arguments. */
export function assertPersistentGatewayOpenClawServiceActionParameters(
    method: PersistentGatewayOpenClawServiceActionMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    const schema =
        method === "sessions.cleanup"
            ? gatewayOpenClawSessionsCleanupParamsSchema
            : gatewayOpenClawInstallationUpdateParamsSchema;
    if (!v.safeParse(schema, parameters).success) {
        throw new TypeError(
            "Persistent Gateway OpenClaw operation parameters are invalid"
        );
    }
}

export interface PersistentGatewayOpenClawCleanupStoreProjection {
    readonly artifactsRemoved: number;
    readonly bytesFreed: number;
    readonly diskEntriesRemoved: number;
    readonly diskFilesRemoved: number;
    readonly dmScopesRetired: number;
    readonly entriesAfter: number;
    readonly entriesBefore: number;
    readonly entriesCapped: number;
    readonly entriesPruned: number;
    readonly missingEntriesRemoved: number;
    readonly modelRunsPruned: number;
}

export type PersistentGatewayOpenClawServiceActionResponse =
    | {
          readonly method: "sessions.cleanup";
          readonly stores: readonly PersistentGatewayOpenClawCleanupStoreProjection[];
      }
    | {
          readonly afterVersion?: string;
          readonly beforeVersion?: string;
          readonly method: "update.run";
          readonly status: "accepted" | "completed" | "failed";
      };

function addGatewayOperationCounts(left: number, right: number): number {
    const total = left + right;
    if (!Number.isSafeInteger(total) || total < 0) {
        throw new TypeError("Persistent Gateway OpenClaw operation response is invalid");
    }
    return total;
}

/**
 * Removes paths, commands, process metadata, and output before the worker provider
 * can observe a privileged OpenClaw response.
 * @returns A bounded path-free operation projection.
 */
export function parsePersistentGatewayOpenClawServiceActionResponse(
    method: PersistentGatewayOpenClawServiceActionMethod,
    payload: unknown
): PersistentGatewayOpenClawServiceActionResponse {
    if (
        !jsonValueFitsByteBudget(
            payload,
            persistentGatewayOpenClawServiceActionResponseMaximumBytes
        )
    ) {
        throw new TypeError("Persistent Gateway OpenClaw operation response is invalid");
    }
    if (method === "sessions.cleanup") {
        const parsed = v.safeParse(gatewayOpenClawCleanupResponseSchema, payload);
        if (!parsed.success) {
            throw new TypeError(
                "Persistent Gateway OpenClaw operation response is invalid"
            );
        }
        const stores = "stores" in parsed.output ? parsed.output.stores : [parsed.output];
        return Object.freeze({
            method,
            stores: Object.freeze(
                stores.map((store) =>
                    Object.freeze({
                        artifactsRemoved: store.unreferencedArtifacts.removedFiles,
                        bytesFreed: addGatewayOperationCounts(
                            store.unreferencedArtifacts.freedBytes,
                            store.diskBudget?.freedBytes ?? 0
                        ),
                        diskEntriesRemoved: store.diskBudget?.removedEntries ?? 0,
                        diskFilesRemoved: store.diskBudget?.removedFiles ?? 0,
                        dmScopesRetired: store.dmScopeRetired,
                        entriesAfter: store.afterCount,
                        entriesBefore: store.beforeCount,
                        entriesCapped: store.capped,
                        entriesPruned: store.pruned,
                        missingEntriesRemoved: store.missing,
                        modelRunsPruned: store.modelRunPruned,
                    })
                )
            ),
        });
    }
    const parsed = v.safeParse(gatewayOpenClawUpdateResponseSchema, payload);
    if (!parsed.success) {
        throw new TypeError("Persistent Gateway OpenClaw operation response is invalid");
    }
    let status: "accepted" | "completed" | "failed" = "failed";
    if (parsed.output.handoff?.status === "started") {
        status = "accepted";
    } else if (parsed.output.ok && parsed.output.result.status === "ok") {
        status = "completed";
    }
    return Object.freeze({
        ...(parsed.output.result.after === undefined
            ? {}
            : { afterVersion: parsed.output.result.after.version }),
        ...(parsed.output.result.before === undefined
            ? {}
            : { beforeVersion: parsed.output.result.before.version }),
        method,
        status,
    });
}

export function assertPersistentGatewayChatReadParameters(
    method: PersistentGatewayChatReadMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    const valid = (() => {
        switch (method) {
            case "chat.history": {
                return v.safeParse(gatewayChatHistoryParamsSchema, parameters).success;
            }
            case "chat.message.get": {
                return v.safeParse(gatewayChatMessageGetParamsSchema, parameters).success;
            }
            case "models.list": {
                return v.safeParse(gatewayModelsListParamsSchema, parameters).success;
            }
            case "sessions.companion.state": {
                return v.safeParse(gatewayCompanionStateParamsSchema, parameters).success;
            }
        }
    })();
    if (!valid) {
        throw new TypeError("Persistent Gateway chat read parameters are invalid");
    }
}

export function assertPersistentGatewayChatReadMutationParameters(
    _method: PersistentGatewayChatReadMutationMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    if (!v.safeParse(gatewayCompanionAskParamsSchema, parameters).success) {
        throw new TypeError(
            "Persistent Gateway chat read-scope mutation parameters are invalid"
        );
    }
}

export function assertPersistentGatewayChatWriteParameters(
    method: PersistentGatewayChatWriteMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    let valid: boolean;
    switch (method) {
        case "chat.send": {
            valid = v.safeParse(gatewayChatSendParamsSchema, parameters).success;
            break;
        }
        case "chat.abort": {
            valid = v.safeParse(gatewayChatAbortParamsSchema, parameters).success;
            break;
        }
        case "sessions.companion.reset": {
            valid = v.safeParse(gatewayCompanionResetParamsSchema, parameters).success;
            break;
        }
    }
    if (!valid) {
        throw new TypeError("Persistent Gateway chat write parameters are invalid");
    }
}

export function assertPersistentGatewayTaskReadParameters(
    method: PersistentGatewayTaskReadMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    const schema =
        method === "tasks.list"
            ? gatewayTaskListParamsSchema
            : gatewayTaskGetParamsSchema;
    if (!v.safeParse(schema, parameters).success) {
        throw new TypeError("Persistent Gateway task read parameters are invalid");
    }
}

export function assertPersistentGatewayTaskWriteParameters(
    _method: PersistentGatewayTaskWriteMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    if (!v.safeParse(gatewayTaskCancelParamsSchema, parameters).success) {
        throw new TypeError("Persistent Gateway task write parameters are invalid");
    }
}

/**
 * Builds the only credential-bearing frame for either Phase 4 lane.
 * @param input Redacted-lifetime handshake inputs and requested lane.
 * @returns One protocol-v4 connect request.
 */
export function createPersistentGatewayConnectFrame(
    input: PersistentGatewayConnectFrameInput
): Readonly<Record<string, unknown>> {
    const scopes = scopesForProfile(input.profile);
    return Object.freeze({
        id: input.requestId,
        method: "connect",
        params: Object.freeze({
            auth: Object.freeze({ token: input.credential }),
            caps: Object.freeze(capabilitiesForProfile(input.profile)),
            client: Object.freeze({
                deviceFamily: "server",
                displayName: displayNameForProfile(input.profile),
                id: "gateway-client",
                instanceId: input.instanceId,
                mode: "backend",
                platform: process.platform,
                version: input.clientVersion,
            }),
            maxProtocol: openClawGatewayProtocolVersion,
            minProtocol: openClawGatewayProtocolVersion,
            role: "operator",
            scopes,
        }),
        type: "req",
    });
}

export function parsePersistentGatewayChallenge(
    value: unknown
): { readonly nonce: string } | undefined {
    const parsed = v.safeParse(gatewayChallengeFrameSchema, value);
    return parsed.success
        ? Object.freeze({ nonce: parsed.output.payload.nonce })
        : undefined;
}

export function parsePersistentGatewayResponse(
    value: unknown
): PersistentGatewayResponseFrame | undefined {
    const parsed = v.safeParse(gatewayResponseFrameSchema, value);
    if (!parsed.success) return undefined;
    const response = parsed.output;
    if (
        (response.ok && response.error !== undefined) ||
        (!response.ok && (response.error === undefined || response.payload !== undefined))
    ) {
        return undefined;
    }
    return response;
}

export function parsePersistentGatewayHello(
    value: unknown,
    profile: PersistentGatewayConnectionProfile
): PersistentGatewayHello | undefined {
    const parsed = v.safeParse(gatewayHelloSchema, value);
    if (!parsed.success) return undefined;
    const expectedScopes = scopesForProfile(profile);
    if (!hasExactScopes(parsed.output.auth.scopes, expectedScopes)) return undefined;
    if (!parsed.output.features.events.includes("tick")) return undefined;
    if (
        profile === "web-read" &&
        !persistentGatewayEventNames.every((event) =>
            parsed.output.features.events.includes(event)
        )
    ) {
        return undefined;
    }
    if (
        parsed.output.policy.maxPayload >
            persistentGatewayAuthenticatedFrameMaximumBytes ||
        parsed.output.policy.maxBufferedBytes >
            persistentGatewayBufferedAmountPolicyMaximumBytes
    ) {
        return undefined;
    }
    return parsed.output;
}

/**
 * Projects the installed chat.send acknowledgement onto its stable success fields.
 * @param value Untrusted successful response payload.
 * @returns The bounded acknowledgement projection, or undefined when incompatible.
 */
export function parsePersistentGatewayChatSendAcknowledgement(value: unknown):
    | {
          readonly runId: string;
          readonly status: "in_flight" | "ok" | "started";
      }
    | undefined {
    const parsed = v.safeParse(gatewayChatSendAcknowledgementSchema, value);
    if (!parsed.success) return undefined;
    return Object.freeze({ runId: parsed.output.runId, status: parsed.output.status });
}

function parsePersistentGatewaySessionLifecycleEvent(
    value: unknown
): PersistentGatewaySessionLifecycleEvent | undefined {
    const parsed = v.safeParse(gatewaySessionLifecycleEventSchema, value);
    if (!parsed.success) return undefined;
    return Object.freeze({
        ...(parsed.output.reason === "compact"
            ? { compacted: parsed.output.compacted }
            : {}),
        occurredAtMs: parsed.output.ts,
        reason: parsed.output.reason,
        ...(parsed.output.sessionId === undefined
            ? {}
            : { sessionId: parsed.output.sessionId }),
        ...(parsed.output.sessionKey === undefined
            ? {}
            : { sessionKey: parsed.output.sessionKey }),
        ...(parsed.output.updatedAt === undefined
            ? {}
            : { updatedAtMs: parsed.output.updatedAt }),
    });
}

function parsePersistentGatewaySessionActivityEvent(
    value: unknown
): PersistentGatewaySessionActivityEvent | undefined {
    if (
        value !== null &&
        typeof value === "object" &&
        "reason" in value &&
        ["compact", "delete", "new", "reset"].includes(String(value.reason))
    ) {
        return undefined;
    }
    const parsed = v.safeParse(gatewaySessionActivityEventSchema, value);
    if (!parsed.success) return undefined;
    return Object.freeze({
        ...(parsed.output.agentId === undefined
            ? {}
            : { agentId: parsed.output.agentId }),
        occurredAtMs: parsed.output.ts,
        ...(parsed.output.reason === undefined ? {} : { reason: parsed.output.reason }),
        sessionKey: parsed.output.sessionKey,
        ...(parsed.output.updatedAt === undefined
            ? {}
            : { updatedAtMs: parsed.output.updatedAt }),
    });
}

function persistentGatewaySessionUserText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return undefined;
    return value
        .flatMap((part) => {
            if (part === null || typeof part !== "object") return [];
            const candidate = part as Readonly<Record<string, unknown>>;
            return (candidate.type === "text" || candidate.type === "input_text") &&
                typeof candidate.text === "string"
                ? [candidate.text]
                : [];
        })
        .join("");
}

function persistentGatewaySessionAttachments(
    metadata: Readonly<Record<string, unknown>> | undefined,
    message: Readonly<Record<string, unknown>>
): readonly PersistentGatewaySessionAttachment[] {
    const media = Array.isArray(metadata?.media) ? metadata.media : message.media;
    if (!Array.isArray(media)) return [];
    if (media.length > 10) return [];
    return Object.freeze(
        media.flatMap((value) => {
            if (value === null || typeof value !== "object") return [];
            const fact = value as Readonly<Record<string, unknown>>;
            if (
                typeof fact.url !== "string" ||
                !/^media:\/\/inbound\/[0-9a-f-]{36}\.[a-z\d]{1,16}$/iu.test(fact.url) ||
                typeof fact.contentType !== "string" ||
                !/^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+$/iu.test(fact.contentType)
            ) {
                return [];
            }
            const fileName = fact.url.slice("media://inbound/".length);
            const sizeBytes =
                typeof fact.sizeBytes === "number" &&
                Number.isSafeInteger(fact.sizeBytes) &&
                fact.sizeBytes >= 0 &&
                fact.sizeBytes <= 25 * 1024 * 1024
                    ? fact.sizeBytes
                    : undefined;
            return [
                Object.freeze({
                    contentType: fact.contentType.toLowerCase(),
                    fileName,
                    ...(sizeBytes === undefined ? {} : { sizeBytes }),
                    url: fact.url,
                }),
            ];
        })
    );
}

function parsePersistentGatewaySessionMessageEvent(
    value: unknown
): PersistentGatewaySessionMessageEvent | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const record = value as Readonly<Record<string, unknown>>;
    const sessionKey = record.sessionKey;
    const parsed = v.safeParse(chatSessionKeySchema, sessionKey);
    if (!parsed.success) return undefined;
    const message =
        record.message !== null && typeof record.message === "object"
            ? (record.message as Readonly<Record<string, unknown>>)
            : undefined;
    if (message?.role !== "user") {
        return Object.freeze({ sessionKey: parsed.output });
    }
    const text = persistentGatewaySessionUserText(message.content);
    const activeRunIds = Array.isArray(record.activeRunIds)
        ? (record.activeRunIds as readonly unknown[])
        : undefined;
    if (text === undefined) {
        return Object.freeze({ sessionKey: parsed.output });
    }
    const metadata =
        message.__openclaw !== null && typeof message.__openclaw === "object"
            ? (message.__openclaw as Readonly<Record<string, unknown>>)
            : undefined;
    const attachments = persistentGatewaySessionAttachments(metadata, message);
    const messageId = v.safeParse(
        chatMessageIdSchema,
        record.messageId ?? metadata?.id ?? message.id
    );
    const rawIdempotencyKey = metadata?.idempotencyKey ?? message.idempotencyKey;
    const idempotencyKey = v.safeParse(
        chatMessageIdSchema,
        normalizeChatProviderUserIdentity(rawIdempotencyKey) ?? messageId.output
    );
    const providerRunIds = [
        ...(metadata?.runId === undefined ? [] : [metadata.runId]),
        ...(activeRunIds ?? []),
    ].flatMap((candidate) => {
        const runId = v.safeParse(chatRunIdSchema, candidate);
        return runId.success ? [runId.output] : [];
    });
    const uniqueProviderRunIds = [...new Set(providerRunIds)].slice(0, 32);
    const parsedText = v.safeParse(chatMessageTextSchema, text);
    if (
        !messageId.success ||
        !idempotencyKey.success ||
        uniqueProviderRunIds.length === 0 ||
        !parsedText.success
    ) {
        return Object.freeze({ sessionKey: parsed.output });
    }
    return Object.freeze({
        sessionKey: parsed.output,
        userMessage: Object.freeze({
            attachments,
            idempotencyKey: idempotencyKey.output,
            messageId: messageId.output,
            providerRunIds: Object.freeze(uniqueProviderRunIds),
            text: parsedText.output,
        }),
    });
}

export function parsePersistentGatewayEvent(
    value: unknown
): PersistentGatewayEventFrame | undefined {
    const parsed = v.safeParse(gatewayEventFrameSchema, value);
    if (!parsed.success || !eventNameSet.has(parsed.output.event)) return undefined;
    const sessionLifecycle =
        parsed.output.event === "sessions.changed"
            ? parsePersistentGatewaySessionLifecycleEvent(parsed.output.payload)
            : undefined;
    const sessionActivity =
        parsed.output.event === "sessions.changed" && sessionLifecycle === undefined
            ? parsePersistentGatewaySessionActivityEvent(parsed.output.payload)
            : undefined;
    const sessionMessage =
        parsed.output.event === "session.message"
            ? parsePersistentGatewaySessionMessageEvent(parsed.output.payload)
            : undefined;
    if (parsed.output.event === "session.message" && sessionMessage === undefined) {
        return undefined;
    }
    return Object.freeze({
        event: parsed.output.event as PersistentGatewayEventName,
        ...(sessionMessage === undefined ? {} : { sessionMessage }),
        ...(sessionActivity === undefined ? {} : { sessionActivity }),
        ...(sessionLifecycle === undefined ? {} : { sessionLifecycle }),
        ...(parsed.output.seq === undefined ? {} : { seq: parsed.output.seq }),
        type: parsed.output.type,
    });
}

/**
 * Validates an authenticated event envelope without exposing an unreviewed payload.
 * Domain payloads are projected separately only for the explicit event allowlist.
 * @param value Untrusted decoded Gateway frame.
 * @returns A payload-free event envelope, or undefined for malformed input.
 */
export function parsePersistentGatewayEventEnvelope(
    value: unknown
): PersistentGatewayEventEnvelope | undefined {
    const parsed = v.safeParse(gatewayEventFrameSchema, value);
    if (!parsed.success) return undefined;
    return Object.freeze({
        event: parsed.output.event,
        ...(parsed.output.seq === undefined ? {} : { seq: parsed.output.seq }),
        type: parsed.output.type,
    });
}

/**
 * Validates and projects the private session-scoped chat event payload. The
 * generic listener receives only the payload-free envelope and can never call
 * this parser implicitly.
 * @param value Untrusted decoded Gateway frame.
 * @returns A validated private chat payload, or undefined for malformed input.
 */
export function parsePersistentGatewayChatEvent(
    value: unknown
): PersistentGatewayChatEvent | undefined {
    const frame = v.safeParse(gatewayEventFrameSchema, value);
    if (!frame.success || frame.output.event !== "chat") return undefined;
    const parsed = v.safeParse(gatewayChatEventSchema, frame.output.payload);
    if (!parsed.success) return undefined;
    return Object.freeze(parsed.output);
}

export function parsePersistentGatewayPrivateChatEvent(
    value: unknown
): PersistentGatewayPrivateChatEvent | undefined {
    const frame = v.safeParse(gatewayEventFrameSchema, value);
    if (!frame.success) return undefined;
    if (frame.output.event === "chat") {
        const payload = v.safeParse(gatewayChatEventSchema, frame.output.payload);
        return payload.success
            ? Object.freeze({ event: "chat", payload: Object.freeze(payload.output) })
            : undefined;
    }
    // Control-UI-visible runs are broadcast as `agent`, except tool activity:
    // the Gateway sends that to broad session subscribers as `session.tool`.
    // Both envelopes carry the same bounded agent payload contract, so normalize
    // the latter before it crosses the private chat boundary.
    if (frame.output.event === "agent" || frame.output.event === "session.tool") {
        const payload = v.safeParse(gatewayAgentEventSchema, frame.output.payload);
        if (payload.success) {
            const projectedPayload =
                payload.output.stream === "compaction"
                    ? {
                          ...payload.output,
                          data: {
                              ...(payload.output.data.completed === undefined
                                  ? {}
                                  : {
                                        completed: payload.output.data.completed,
                                    }),
                              ...(payload.output.data.phase === undefined
                                  ? {}
                                  : { phase: payload.output.data.phase }),
                              ...(payload.output.data.willRetry === undefined
                                  ? {}
                                  : {
                                        willRetry: payload.output.data.willRetry,
                                    }),
                          },
                      }
                    : payload.output;
            return Object.freeze({
                event: "agent",
                payload: Object.freeze({
                    ...projectedPayload,
                    data: Object.freeze(projectedPayload.data),
                }),
            });
        }
        const unsupported = v.safeParse(
            gatewayUnsupportedAgentEventSchema,
            frame.output.payload
        );
        if (
            !unsupported.success ||
            gatewaySupportedAgentStreams.some(
                (stream) => stream === unsupported.output.stream
            )
        ) {
            return undefined;
        }
        return Object.freeze({
            event: "agent",
            payload: Object.freeze({
                ...(unsupported.output.agentId === undefined
                    ? {}
                    : { agentId: unsupported.output.agentId }),
                data: Object.freeze({}),
                runId: unsupported.output.runId,
                seq: unsupported.output.seq,
                sessionKey: unsupported.output.sessionKey,
                stream: "unsupported" as const,
                ts: unsupported.output.ts,
            }),
        });
    }
    return undefined;
}

/**
 * Accepts only the installed sessions.subscribe success projection.
 * @param value Untrusted successful response payload.
 * @returns True only for the exact subscribed acknowledgement.
 */
export function parsePersistentGatewaySessionsSubscriptionAcknowledgement(
    value: unknown
): true | undefined {
    return v.safeParse(gatewaySessionsSubscriptionAcknowledgementSchema, value).success
        ? true
        : undefined;
}

export function parsePersistentGatewaySessionMessagesSubscriptionAcknowledgement(
    value: unknown,
    subscribed: boolean
): Readonly<{ key: string; subscribed: boolean }> | undefined {
    const parsed = v.safeParse(
        gatewaySessionMessagesSubscriptionAcknowledgementSchema,
        value
    );
    if (!parsed.success || parsed.output.subscribed !== subscribed) return undefined;
    return Object.freeze({
        key: parsed.output.key,
        subscribed: parsed.output.subscribed,
    });
}
