import type { ChatRuntimeEvent, ChatTextSource } from "../domain/chatState";
import {
    asRecord,
    isNonWorkTool,
    isThinkingItem,
    itemStrings,
    itemTexts,
    normalizeAssistant,
    openClawEventContext,
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
    payload: Record<string, unknown>,
    common: {
        runId?: string;
        sessionKey: string;
        timestamp: string;
    }
): ChatRuntimeEventDraft[] {
    const streamRaw = stringValue(payload.stream) || "";
    const stream = streamRaw === "command_output" ? "command-output" : streamRaw;
    const data = asRecord(payload.data) || {};
    const phase = stringValue(data.phase) || "";
    if (
        (stream === "tool" || eventName === "session.tool") &&
        isNonWorkTool(stringValue(data.name) || stringValue(data.toolName) || "tool")
    ) {
        return [];
    }

    const drafts: ChatRuntimeEventDraft[] = [];
    const progress = openClawProgress(eventName, stream, phase, data);
    if (progress.text || progress.operation) {
        drafts.push({
            ...common,
            kind: "status",
            operation: progress.operation,
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
            stringValue(data.error) ||
            stringValue(payload.errorMessage) ||
            stringValue(payload.error);
        const status = stringValue(data.status) || stringValue(payload.status);
        const isAborted =
            data.aborted === true || payload.aborted === true || status === "aborted";
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
    const drafts =
        eventName === "chat"
            ? chatEventDrafts(stringValue(payload.state), payload, common)
            : eventName === "session.message"
              ? sessionMessageDrafts(payload, common)
              : runtimeStreamDrafts(eventName, payload, common);
    const sequence = openClawSequence(raw, fallbackSequence) * 16;
    return drafts.slice(0, 15).map((draft, index) => ({
        ...draft,
        sequence: sequence + index,
    })) as ChatRuntimeEvent[];
}

function sessionMessageDrafts(
    payload: Record<string, unknown>,
    common: { runId?: string; sessionKey: string; timestamp: string }
): ChatRuntimeEventDraft[] {
    const nestedMessage = asRecord(payload.message);
    const topLevelRole = stringValue(payload.role);
    const rawMessage = topLevelRole
        ? {
              ...nestedMessage,
              content:
                  nestedMessage?.content ??
                  (nestedMessage
                      ? undefined
                      : (payload.message ??
                        payload.content ??
                        payload.deltaText ??
                        payload.text)),
              role: topLevelRole,
          }
        : (payload.message ?? payload.content ?? payload.deltaText ?? payload.text);
    const message = normalizeAssistant(rawMessage, common.runId);
    return message.role.toLowerCase() === "assistant"
        ? [
              {
                  ...common,
                  kind: "assistant",
                  message: { ...message, timestamp: common.timestamp },
                  mode: "merge",
                  source: "session",
              },
          ]
        : [];
}
