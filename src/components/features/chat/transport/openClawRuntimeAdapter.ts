import type { ChatHistoryMessage, ChatToolCallDisplay } from "../chatTypes";
import { stableChatStringify } from "../chatUtilities";
import type { ChatRuntimeEvent, ChatTextSource } from "../domain/chatState";
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

type WithoutSequence<Event> = Event extends unknown ? Omit<Event, "sequence"> : never;
type ChatRuntimeEventDraft = WithoutSequence<ChatRuntimeEvent>;
const MAX_DRAFTS_PER_ENVELOPE = 15;

function isToolFailureError(value: string | undefined): boolean {
    const normalized = value?.trim() || "";
    return (
        normalized.startsWith("⚠️ 🛠️") ||
        /^tool (?:call|execution) failed\b/iu.test(normalized) ||
        /\bcodex native tool failed\b/iu.test(normalized)
    );
}

export interface OpenClawRuntimeEnvelope {
    event?: unknown;
    payload?: unknown;
    runtimeRecordedAt?: unknown;
    runtimeSequence?: unknown;
    type?: unknown;
}

export interface OpenClawRuntimeSnapshot {
    completed?: boolean;
    events?: unknown[];
    throughSequence?: number;
}

function chatEventDrafts(
    state: string | undefined,
    payload: Record<string, unknown>,
    common: {
        runId?: string;
        sessionKey: string;
        timestamp: string;
    }
): ChatRuntimeEventDraft[] {
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
                message: { ...message, timestamp: common.timestamp },
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
    const error =
        explicitError ||
        (isMessageToolFailure
            ? message?.text
            : state === "error"
              ? "Chat run failed"
              : undefined);
    const isToolFailure = isToolFailureError(explicitError) || isMessageToolFailure;
    const isDuplicateToolFailureMessage = Boolean(
        isToolFailure &&
        message &&
        (message.text.trim() === error?.trim() || isToolFailureError(message.text))
    );
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
                          role: isCommand ? "system" : message.role,
                          local: isCommand || undefined,
                          timestamp: common.timestamp,
                      }
                    : undefined,
            outcome:
                state === "final"
                    ? "completed"
                    : state === "aborted"
                      ? "aborted"
                      : "error",
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
): ChatRuntimeEventDraft[] {
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

    const drafts: ChatRuntimeEventDraft[] = [];
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
                message: normalizeAssistant(text, common.runId),
                mode: rawString(data.delta) ? "append" : "merge",
                source: "runtime" as ChatTextSource,
            });
        }
    } else if (stream === "thinking" || stream === "reasoning") {
        appendThinkingDraft(drafts, data, common);
    } else if (stream === "item" && isThinkingItem(data)) {
        appendItemThinkingDraft(drafts, data, common);
    }

    const normalizedToolData =
        stream === "item"
            ? openClawItemToolData(data)
            : stream === "tool" || eventName === "session.tool"
              ? data
              : undefined;
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
        const outcome = isAborted ? "aborted" : isError ? "error" : "completed";
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
    } else if (!progress.text && OPENCLAW_WORK_STREAMS.has(stream) && phase === "start") {
        drafts.push({ ...common, kind: "status", text: "Thinking" });
    }
    return drafts;
}

function appendThinkingDraft(
    drafts: ChatRuntimeEventDraft[],
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
            content: [{ text, type: "thinking" }],
            text: "",
            thinking: [{ snapshot: delta === undefined, text }],
            timestamp: common.timestamp,
            runId: common.runId,
        },
    });
}

function appendItemThinkingDraft(
    drafts: ChatRuntimeEventDraft[],
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
            content: [{ text, type: "thinking" }],
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

/** Converts one raw OpenClaw envelope into provider-independent events. */
export function adaptOpenClawRuntimeEvent(
    raw: unknown,
    fallbackSequence: number
): ChatRuntimeEvent[] {
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
    const sequence = openClawSequence(raw, fallbackSequence) * 16;
    const drafts =
        eventName === "chat"
            ? chatEventDrafts(stringValue(eventPayload.state), eventPayload, common)
            : eventName === "session.message"
              ? sessionMessageDrafts(eventPayload, common, sequence)
              : runtimeStreamDrafts(eventName, eventPayload, common);
    return boundedRuntimeDrafts(drafts).map((draft, index) => ({
        ...draft,
        sequence: sequence + index,
    })) as ChatRuntimeEvent[];
}

function boundedRuntimeDrafts(drafts: ChatRuntimeEventDraft[]): ChatRuntimeEventDraft[] {
    if (drafts.length <= MAX_DRAFTS_PER_ENVELOPE) {
        return drafts;
    }
    const finishIndex = drafts.findLastIndex((draft) => draft.kind === "finish");
    if (finishIndex === -1) {
        return drafts.slice(0, MAX_DRAFTS_PER_ENVELOPE);
    }
    const terminalStart =
        drafts[finishIndex - 1]?.kind === "assistant" ? finishIndex - 1 : finishIndex;
    const terminalDrafts = drafts.slice(terminalStart, finishIndex + 1);
    return [
        ...drafts.slice(0, MAX_DRAFTS_PER_ENVELOPE - terminalDrafts.length),
        ...terminalDrafts,
    ];
}

function sessionMessageDrafts(
    data: Record<string, unknown>,
    common: { runId?: string; sessionKey: string; timestamp: string },
    sequence: number
): ChatRuntimeEventDraft[] {
    const nestedMessage = asRecord(data.message);
    const stopReason =
        stringValue(nestedMessage?.stopReason) || stringValue(data.stopReason);
    const isTerminalAssistantMessage = stopReason?.toLowerCase() === "stop";
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
        const drafts = sessionAssistantDiagnosticDrafts(message, common, sequence);
        const hasPrimaryContent = Boolean(
            message.text.trim() || message.images?.length || message.attachments?.length
        );
        if (hasPrimaryContent) {
            drafts.push({
                ...common,
                kind: "assistant",
                message: {
                    ...message,
                    content: message.text,
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
                message: { ...message, timestamp: common.timestamp },
            },
        ];
    }
    if (role.startsWith("tool") && message.toolResult) {
        return [
            {
                ...common,
                kind: "tool",
                message: { ...message, timestamp: common.timestamp },
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
        : `tool:${name}:${stableChatStringify(arguments_ ?? undefined)}`;
}

function sessionAssistantDiagnosticDrafts(
    message: ChatHistoryMessage,
    common: { runId?: string; sessionKey: string; timestamp: string },
    sequence: number
): ChatRuntimeEventDraft[] {
    const drafts: ChatRuntimeEventDraft[] = [];
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
                content: thinking.map((block) => ({
                    id: block.id,
                    text: block.text,
                    type: "thinking",
                })),
                text: "",
                thinking,
                timestamp: common.timestamp,
                runId: common.runId,
            },
        });
    }
    const toolCalls = message.toolCalls || [];
    for (const toolCall of toolCalls) {
        drafts.push(sessionToolCallDraft(toolCall, common));
    }
    return drafts;
}

function sessionToolCallDraft(
    toolCall: ChatToolCallDisplay,
    common: { runId?: string; sessionKey: string; timestamp: string }
): ChatRuntimeEventDraft {
    return {
        ...common,
        kind: "tool",
        message: {
            role: "assistant",
            content: "",
            text: "",
            toolCalls: [toolCall],
            timestamp: common.timestamp,
            runId: common.runId,
        },
        toolKey: sessionToolKey(toolCall.id, toolCall.name, toolCall.arguments),
    };
}
