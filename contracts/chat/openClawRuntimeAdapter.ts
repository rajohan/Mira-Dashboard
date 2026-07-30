import {
    CANONICAL_CHAT_EVENT_SCHEMA_VERSION,
    type CanonicalChatEvent,
    type CanonicalChatLifecycle,
    type CanonicalChatMessage,
    type CanonicalChatToolCall,
} from "../chatCanonical";
import {
    stableCanonicalChatStringify,
    uniqueCanonicalChatIds,
} from "../chatCanonicalUtilities";
import {
    asRecord,
    isNonWorkTool,
    isThinkingItem,
    itemStrings,
    itemTexts,
    normalizeAssistant,
    openClawCompactionRunId,
    openClawEventContext,
    openClawPayloadView,
    openClawSequence,
    rawString,
    stringValue,
} from "./openClawAdapterValues";
import {
    OPENCLAW_WORK_STREAMS,
    openClawItemToolData,
    openClawProgress,
    openClawToolMessage,
} from "./openClawToolAdapter";

type WithoutCanonicalMetadata<Event> = Event extends unknown
    ? Omit<
          Event,
          "id" | "lifecycle" | "origin" | "provider" | "schemaVersion" | "sequence"
      >
    : never;
type CanonicalChatEventDraft = WithoutCanonicalMetadata<CanonicalChatEvent>;
type CanonicalChatTextSource = Extract<
    CanonicalChatEvent,
    { kind: "assistant" }
>["source"];
interface RuntimeDraftLimitContext {
    eventName: string;
    runId?: string;
    runtimeSequence: number;
    sessionKey: string;
}

export interface OpenClawRuntimeEnvelopeInput {
    event: unknown;
    payload: unknown;
    runtimeRecordedAt: number;
    runtimeRunAliases?: string[];
    runtimeSequence: number;
    type: "event";
}

export type CanonicalizedOpenClawRuntimeEnvelope<
    Envelope extends OpenClawRuntimeEnvelopeInput = OpenClawRuntimeEnvelopeInput,
> = Envelope & {
    canonicalEvents: CanonicalChatEvent[];
};

const MAX_DRAFTS_PER_ENVELOPE = 15;

function isToolFailureError(value: string | undefined): boolean {
    const normalized = value?.trim() || "";
    return (
        normalized.startsWith("⚠️ 🛠️") ||
        /^tool (?:call|execution) failed\b/iu.test(normalized) ||
        /\bcodex native tool failed\b/iu.test(normalized)
    );
}

function chatEventDrafts(
    state: string | undefined,
    payload: Record<string, unknown>,
    common: {
        runId?: string;
        sessionKey: string;
        timestamp: string;
    }
): CanonicalChatEventDraft[] {
    if (state === "delta") {
        const message = normalizeAssistant(
            payload.message ??
                payload.deltaText ??
                payload.delta ??
                payload.content ??
                payload.text,
            common.runId
        );
        return [
            {
                ...common,
                kind: "assistant",
                message: {
                    ...message,
                    content: "",
                    timestamp: common.timestamp,
                },
                mode: payload.replace === true ? "replace" : "merge",
                source: "chat",
            },
        ];
    }
    if (!["final", "aborted", "error"].includes(state || "")) {
        return [];
    }
    const rawMessage = payload.message ?? payload.content ?? payload.text;
    const message =
        rawMessage === undefined
            ? undefined
            : normalizeAssistant(rawMessage, common.runId);
    const isCommand = asRecord(payload.message)?.command === true;
    const explicitError = stringValue(payload.errorMessage) || stringValue(payload.error);
    const isMessageToolFailure = state === "error" && isToolFailureError(message?.text);
    let error = state === "error" ? "Chat run failed" : undefined;
    if (isMessageToolFailure) {
        error = message?.text;
    }
    if (explicitError) {
        error = explicitError;
    }
    const isToolFailure = isToolFailureError(explicitError) || isMessageToolFailure;
    const isDuplicateToolFailureMessage = Boolean(
        isToolFailure &&
        message &&
        (message.text.trim() === error?.trim() || isToolFailureError(message.text))
    );
    let outcome: Exclude<CanonicalChatLifecycle, "active"> = "error";
    if (state === "aborted") {
        outcome = "aborted";
    }
    if (state === "final") {
        outcome = "completed";
    }
    return [
        {
            ...common,
            authoritative: true,
            kind: "finish",
            error,
            message:
                message && !isDuplicateToolFailureMessage
                    ? {
                          ...message,
                          content: "",
                          role: isCommand ? "system" : message.role,
                          local: isCommand || undefined,
                          timestamp: common.timestamp,
                      }
                    : undefined,
            outcome,
            toolFailure: isToolFailure || undefined,
        },
    ];
}

function runtimeStreamDrafts(
    eventName: string,
    data: Record<string, unknown>,
    common: {
        runId?: string;
        sessionKey: string;
        timestamp: string;
    }
): CanonicalChatEventDraft[] {
    const streamRaw =
        stringValue(data.stream) ||
        (eventName === "session.compaction" ? "compaction" : "");
    const stream = streamRaw === "command_output" ? "command-output" : streamRaw;
    const phase = stringValue(data.phase) || "";
    if (
        (stream === "tool" || eventName === "session.tool") &&
        isNonWorkTool(stringValue(data.name) || stringValue(data.toolName) || "tool")
    ) {
        return [];
    }

    const drafts: CanonicalChatEventDraft[] = [];
    const progress = openClawProgress(eventName, stream, phase, data);
    if (progress.text || progress.operation || progress.operationPhase) {
        drafts.push({
            ...common,
            kind: "status",
            operation: progress.operation,
            operationPhase: progress.operationPhase,
            text: progress.text,
        });
    }

    if (stream === "assistant") {
        const text =
            rawString(data.delta) ||
            rawString(data.text) ||
            rawString(data.deltaText) ||
            rawString(data.summary) ||
            rawString(data.content) ||
            "";
        if (text) {
            drafts.push({
                ...common,
                kind: "assistant",
                message: {
                    ...normalizeAssistant(text, common.runId),
                    content: "",
                },
                mode: rawString(data.delta) ? "append" : "merge",
                source: "runtime" as CanonicalChatTextSource,
            });
        }
    } else if (stream === "thinking" || stream === "reasoning") {
        appendThinkingDraft(drafts, data, common);
    } else if (stream === "item" && isThinkingItem(data)) {
        appendItemThinkingDraft(drafts, data, common);
    }

    let normalizedToolData: Record<string, unknown> | undefined;
    if (stream === "tool" || eventName === "session.tool") {
        normalizedToolData = data;
    }
    if (stream === "item") {
        normalizedToolData = openClawItemToolData(data);
    }
    const tool = normalizedToolData
        ? openClawToolMessage(normalizedToolData, common.runId, common.timestamp)
        : undefined;
    if (tool) {
        drafts.push({
            ...common,
            kind: "tool",
            message: tool.message,
            toolKey: tool.key,
        });
    }

    const isTerminal =
        eventName === "model.completed" ||
        eventName === "session.ended" ||
        (stream === "lifecycle" && (phase === "end" || phase === "error"));
    if (isTerminal) {
        const explicitError =
            stringValue(data.errorMessage) ||
            stringValue(data.promptError) ||
            stringValue(data.error);
        const status = stringValue(data.status);
        const isAborted = data.aborted === true || status === "aborted";
        const isError =
            Boolean(explicitError) ||
            phase === "error" ||
            status === "error" ||
            status === "failed";
        let outcome: Exclude<CanonicalChatLifecycle, "active"> = isError
            ? "error"
            : "completed";
        if (isAborted) {
            outcome = "aborted";
        }
        const terminalError =
            explicitError || (outcome === "error" ? "Chat run failed" : undefined);
        drafts.push({
            ...common,
            kind: "finish",
            error: terminalError,
            outcome,
            settlesCompactionRunId:
                stream === "lifecycle" && (phase === "end" || phase === "error")
                    ? openClawCompactionRunId(common.sessionKey, common.runId)
                    : undefined,
            toolFailure: isToolFailureError(terminalError) || undefined,
        });
    } else if (phase === "start" && !progress.text && OPENCLAW_WORK_STREAMS.has(stream)) {
        drafts.push({ ...common, kind: "status", text: "Thinking" });
    }
    return drafts;
}

function appendThinkingDraft(
    drafts: CanonicalChatEventDraft[],
    data: Record<string, unknown>,
    common: { runId?: string; sessionKey: string; timestamp: string }
): void {
    const delta = rawString(data.delta);
    const text =
        delta ||
        rawString(data.text) ||
        rawString(data.deltaText) ||
        rawString(data.summary) ||
        rawString(data.content) ||
        "";
    if (!text) {
        return;
    }
    drafts.push({
        ...common,
        kind: "thinking",
        message: {
            role: "assistant",
            content: "",
            text: "",
            thinking: [{ snapshot: delta === undefined, text }],
            timestamp: common.timestamp,
            runId: common.runId,
        },
    });
}

function appendItemThinkingDraft(
    drafts: CanonicalChatEventDraft[],
    data: Record<string, unknown>,
    common: { runId?: string; sessionKey: string; timestamp: string }
): void {
    const delta = itemTexts(data, ["delta"])[0];
    const text =
        delta ||
        itemTexts(data, ["progressText", "summary", "text", "meta", "content"])[0];
    if (!text) {
        return;
    }
    drafts.push({
        ...common,
        kind: "thinking",
        message: {
            role: "assistant",
            content: "",
            text: "",
            thinking: [
                {
                    id: itemStrings(data, ["itemId", "id"])[0],
                    snapshot: delta === undefined,
                    text,
                },
            ],
            timestamp: common.timestamp,
            runId: common.runId,
        },
    });
}

function canonicalOpenClawOrigin(eventName: string): CanonicalChatEvent["origin"] {
    if (eventName === "chat") {
        return "openclaw-chat";
    }
    if (eventName.startsWith("session.")) {
        return "openclaw-session";
    }
    return "openclaw-runtime";
}

function canonicalOpenClawFormat(
    eventName: string
): CanonicalChatEvent["provider"]["format"] {
    if (eventName === "chat") {
        return "openclaw-chat";
    }
    if (eventName === "session.message") {
        return "openclaw-session-message";
    }
    if (eventName === "session.tool") {
        return "openclaw-session-tool";
    }
    return eventName === "agent" ? "openclaw-agent" : "openclaw-runtime";
}

function canonicalOpenClawLifecycle(
    draft: CanonicalChatEventDraft
): CanonicalChatLifecycle {
    if (draft.kind === "finish") {
        return draft.outcome;
    }
    if (draft.kind !== "status" || !draft.operation) {
        return "active";
    }
    if (draft.operationPhase === "complete") {
        return "completed";
    }
    return draft.operationPhase === "inactive" ? "aborted" : "active";
}

function canonicalOpenClawProvider(
    eventName: string,
    payload: Record<string, unknown>
): CanonicalChatEvent["provider"] {
    const message = asRecord(payload.message);
    const messageRole = (
        stringValue(message?.role) || stringValue(payload.role)
    )?.toLowerCase();
    const canUseSessionMetadata =
        eventName !== "session.message" || messageRole !== "user";
    return {
        eventName,
        format: canonicalOpenClawFormat(eventName),
        model:
            stringValue(message?.model) ||
            (canUseSessionMetadata ? stringValue(payload.model) : undefined),
        provider:
            stringValue(message?.provider) ||
            (canUseSessionMetadata
                ? stringValue(payload.provider) || stringValue(payload.modelProvider)
                : undefined),
        state: stringValue(payload.state),
        stream: stringValue(payload.stream),
    };
}

function canonicalOpenClawEventId(
    sessionKey: string,
    sequence: number,
    kind: CanonicalChatEvent["kind"]
): string {
    return `openclaw:${encodeURIComponent(sessionKey)}:${sequence}:${kind}`;
}

/**
 * Converts one raw OpenClaw envelope into provider-independent events.
 * @param raw Raw value.
 * @param fallbackSequence Fallback sequence value.
 * @returns Converted one raw OpenClaw envelope into provider-independent events.
 */
export function adaptOpenClawRuntimeEvent(
    raw: unknown,
    fallbackSequence: number
): CanonicalChatEvent[] {
    const context = openClawEventContext(raw);
    if (!context) {
        return [];
    }
    const { eventName, payload, runId, sessionKey, timestamp } = context;
    if (eventName === "session.started" && !runId) {
        return [];
    }
    const common = { runId, sessionKey, timestamp };
    const eventPayload = openClawPayloadView(payload);
    const rawRuntimeRunAliases = asRecord(raw)?.runtimeRunAliases;
    const runtimeRunAliases = uniqueCanonicalChatIds(
        Array.isArray(rawRuntimeRunAliases)
            ? rawRuntimeRunAliases.map((alias) => stringValue(alias))
            : []
    );
    const runtimeSequence = openClawSequence(raw, fallbackSequence);
    const sequence = runtimeSequence * 16;
    let drafts = runtimeStreamDrafts(eventName, eventPayload, common);
    if (eventName === "session.message") {
        drafts = sessionMessageDrafts(eventPayload, common, sequence);
    }
    if (eventName === "chat") {
        drafts = chatEventDrafts(stringValue(eventPayload.state), eventPayload, common);
    }
    const boundedDrafts = boundedRuntimeDrafts(drafts, {
        eventName,
        runId,
        runtimeSequence,
        sessionKey,
    });
    const normalizedDrafts: CanonicalChatEventDraft[] =
        runId && runtimeRunAliases.length > 0 && boundedDrafts.length === 0
            ? [{ ...common, kind: "identity" }]
            : boundedDrafts;
    const origin = canonicalOpenClawOrigin(eventName);
    const provider = canonicalOpenClawProvider(eventName, eventPayload);
    return normalizedDrafts.map((draft, index) => {
        const canonicalSequence = sequence + index;
        return {
            ...draft,
            id: canonicalOpenClawEventId(sessionKey, canonicalSequence, draft.kind),
            lifecycle: canonicalOpenClawLifecycle(draft),
            origin,
            provider,
            ...(runtimeRunAliases.length > 0 && {
                runAliases: runtimeRunAliases,
            }),
            schemaVersion: CANONICAL_CHAT_EVENT_SCHEMA_VERSION,
            sequence: canonicalSequence,
        };
    });
}

/**
 * Rebuilds canonical events after any backend mutation of a provider envelope.
 * @param envelope Sequenced OpenClaw provider envelope.
 * @returns Envelope carrying canonical events derived from its current payload.
 */
export function withCanonicalOpenClawEvents<
    Envelope extends OpenClawRuntimeEnvelopeInput,
>(envelope: Envelope): CanonicalizedOpenClawRuntimeEnvelope<Envelope> {
    return {
        ...envelope,
        canonicalEvents: adaptOpenClawRuntimeEvent(envelope, envelope.runtimeSequence),
    };
}

/**
 * Preserves canonical content while applying rewritten provider run/session identity.
 * @param envelope Canonical envelope whose provider identity changed.
 * @returns Envelope with identity-consistent canonical events.
 */
export function withCurrentCanonicalOpenClawIdentity<
    Envelope extends CanonicalizedOpenClawRuntimeEnvelope,
>(envelope: Envelope): Envelope {
    const context = openClawEventContext(envelope);
    if (!context) {
        return envelope;
    }
    const rawRuntimeRunAliases = asRecord(envelope)?.runtimeRunAliases;
    const runAliases = uniqueCanonicalChatIds(
        Array.isArray(rawRuntimeRunAliases)
            ? rawRuntimeRunAliases.map((alias) => stringValue(alias))
            : []
    );
    return {
        ...envelope,
        canonicalEvents: envelope.canonicalEvents.map((event) => ({
            ...event,
            id: canonicalOpenClawEventId(context.sessionKey, event.sequence, event.kind),
            ...("message" in event &&
                event.message && {
                    message: {
                        ...event.message,
                        runId: context.runId,
                    },
                }),
            runAliases: runAliases.length > 0 ? runAliases : undefined,
            runId: context.runId,
            sessionKey: context.sessionKey,
        })),
    };
}

function boundedRuntimeDrafts(
    drafts: CanonicalChatEventDraft[],
    context: RuntimeDraftLimitContext
): CanonicalChatEventDraft[] {
    if (drafts.length <= MAX_DRAFTS_PER_ENVELOPE) {
        return drafts;
    }
    const finishIndex = drafts.findLastIndex((draft) => draft.kind === "finish");
    let boundedDrafts = drafts.slice(0, MAX_DRAFTS_PER_ENVELOPE);
    if (finishIndex !== -1) {
        const terminalStart =
            drafts[finishIndex - 1]?.kind === "assistant" ? finishIndex - 1 : finishIndex;
        const terminalDrafts = drafts.slice(terminalStart, finishIndex + 1);
        boundedDrafts = [
            ...drafts.slice(0, MAX_DRAFTS_PER_ENVELOPE - terminalDrafts.length),
            ...terminalDrafts,
        ];
    }
    if (process.env.NODE_ENV !== "production") {
        console.warn(
            "[openClawRuntimeAdapter] Dropped runtime drafts above the per-envelope limit",
            {
                ...context,
                droppedDrafts: drafts.length - boundedDrafts.length,
            }
        );
    }
    return boundedDrafts;
}

function sessionMessageDrafts(
    data: Record<string, unknown>,
    common: { runId?: string; sessionKey: string; timestamp: string },
    sequence: number
): CanonicalChatEventDraft[] {
    const nestedMessage = asRecord(data.message);
    const stopReason =
        stringValue(nestedMessage?.stopReason) || stringValue(data.stopReason);
    const isTerminalAssistantMessage = stopReason?.toLowerCase() === "stop";
    const isToolUseAssistantMessage = stopReason?.toLowerCase() === "tooluse";
    const topLevelRole = stringValue(data.role);
    const rawMessage = topLevelRole
        ? {
              ...data,
              ...nestedMessage,
              content:
                  nestedMessage?.content ??
                  (nestedMessage
                      ? undefined
                      : (data.message ?? data.content ?? data.deltaText ?? data.text)),
              role: topLevelRole,
          }
        : (data.message ?? data.content ?? data.deltaText ?? data.text);
    const message = normalizeAssistant(rawMessage, common.runId);
    const role = message.role.toLowerCase();
    if (role === "assistant") {
        const drafts = sessionAssistantDiagnosticDrafts(
            message,
            common,
            sequence,
            isToolUseAssistantMessage
        );
        const hasPrimaryContent = Boolean(
            message.text.trim() || message.images?.length || message.attachments?.length
        );
        if (hasPrimaryContent && !isToolUseAssistantMessage) {
            drafts.push({
                ...common,
                kind: "assistant",
                message: {
                    ...message,
                    content: "",
                    text: message.text,
                    thinking: undefined,
                    toolCalls: undefined,
                    toolResult: undefined,
                    timestamp: common.timestamp,
                },
                mode: isTerminalAssistantMessage ? "replace" : "merge",
                source: "session",
            });
        }
        if (isTerminalAssistantMessage) {
            drafts.push({
                ...common,
                kind: "finish",
                outcome: "completed",
            });
        }
        return drafts;
    }
    if (role === "user") {
        return [
            {
                ...common,
                kind: "user",
                message: {
                    ...message,
                    content: "",
                    timestamp: common.timestamp,
                },
            },
        ];
    }
    if (role.startsWith("tool") && message.toolResult) {
        return [
            {
                ...common,
                kind: "tool",
                message: {
                    ...message,
                    content: "",
                    timestamp: common.timestamp,
                },
                toolKey: sessionToolKey(
                    message.toolResult.id,
                    message.toolResult.name || "tool"
                ),
            },
        ];
    }
    return [];
}

function sessionToolKey(
    id: string | undefined,
    name: string,
    arguments_?: unknown
): string {
    return id
        ? `tool:${id}`
        : `tool:${name}:${stableCanonicalChatStringify(arguments_ ?? undefined)}`;
}

function sessionAssistantDiagnosticDrafts(
    message: CanonicalChatMessage,
    common: { runId?: string; sessionKey: string; timestamp: string },
    sequence: number,
    shouldCarryPrimaryMedia = false
): CanonicalChatEventDraft[] {
    const drafts: CanonicalChatEventDraft[] = [];
    if (message.thinking?.length) {
        const thinking = message.thinking.map((block, index) => ({
            ...block,
            id: block.id || `session-thinking:${sequence}:${index}`,
        }));
        drafts.push({
            ...common,
            kind: "thinking",
            message: {
                role: "assistant",
                content: "",
                text: "",
                thinking,
                timestamp: common.timestamp,
                runId: common.runId,
            },
        });
    }
    const toolCalls = message.toolCalls || [];
    for (const [index, toolCall] of toolCalls.entries()) {
        // Media belongs to the provider turn, so one draft owns it to avoid
        // rendering the same image or attachment once per sibling tool call.
        drafts.push(
            sessionToolCallDraft(
                toolCall,
                common,
                shouldCarryPrimaryMedia && index === 0 ? message : undefined
            )
        );
    }
    if (
        shouldCarryPrimaryMedia &&
        toolCalls.length === 0 &&
        (message.images?.length || message.attachments?.length)
    ) {
        drafts.push({
            ...common,
            kind: "assistant",
            message: {
                ...message,
                content: "",
                text: "",
                thinking: undefined,
                toolCalls: undefined,
                toolResult: undefined,
                timestamp: common.timestamp,
            },
            mode: "merge",
            source: "session",
        });
    }
    return drafts;
}

function sessionToolCallDraft(
    toolCall: CanonicalChatToolCall,
    common: { runId?: string; sessionKey: string; timestamp: string },
    primaryMedia?: CanonicalChatMessage
): CanonicalChatEventDraft {
    return {
        ...common,
        kind: "tool",
        message: {
            role: "assistant",
            content: "",
            text: "",
            attachments: primaryMedia?.attachments,
            images: primaryMedia?.images,
            isToolUse: primaryMedia?.isToolUse,
            toolCalls: [toolCall],
            timestamp: common.timestamp,
            runId: common.runId,
        },
        toolKey: sessionToolKey(toolCall.id, toolCall.name, toolCall.arguments),
    };
}
