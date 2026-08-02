import type { CanonicalChatEvent, CanonicalChatLifecycle } from "./canonical";
import {
    isNonWorkTool,
    isPreambleItem,
    isThinkingItem,
    itemStrings,
    itemTexts,
    normalizeAssistant,
    openClawCompactionRunId,
    rawString,
    stringValue,
} from "./openClawAdapterValues";
import { type CanonicalChatEventDraft, isToolFailureError } from "./openClawRuntimeDraft";
import {
    OPENCLAW_WORK_STREAMS,
    openClawItemToolData,
    openClawProgress,
    openClawToolMessage,
} from "./openClawToolAdapter";

type CanonicalChatTextSource = Extract<
    CanonicalChatEvent,
    { kind: "assistant" }
>["source"];

/**
 * Converts OpenClaw runtime stream payloads into canonical event drafts.
 * @param eventName Provider event name.
 * @param data Normalized provider payload.
 * @param common Shared run identity and timestamp.
 * @returns Canonical event drafts.
 */
export function runtimeStreamDrafts(
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
    } else if (stream === "item" && isPreambleItem(data)) {
        appendItemCommentaryDraft(drafts, data, common);
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

function appendItemCommentaryDraft(
    drafts: CanonicalChatEventDraft[],
    data: Record<string, unknown>,
    common: { runId?: string; sessionKey: string; timestamp: string }
): void {
    const snapshotText = itemTexts(data, [
        "progressText",
        "summary",
        "text",
        "meta",
        "content",
    ])[0];
    const textDelta = itemTexts(data, ["delta"])[0];
    const text = snapshotText || textDelta;
    if (!text) {
        return;
    }
    const itemId = itemStrings(data, ["itemId", "id"])[0];
    drafts.push({
        ...common,
        kind: "commentary",
        message: {
            content: "",
            intent: "commentary",
            role: "assistant",
            runId: common.runId,
            runtimeKey: itemId ? `commentary:${itemId}` : undefined,
            text,
            timestamp: common.timestamp,
        },
        mode: snapshotText ? "replace" : "append",
    });
}
