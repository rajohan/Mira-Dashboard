import {
    boundCanonicalChatToolValue,
    MAX_CANONICAL_TOOL_RESULT_CHARACTERS,
    truncateCanonicalChatText,
} from "../../../../../../contracts/chatCanonicalUtilities";
import {
    type ChatHistoryMessage,
    type ChatToolCallDisplay,
    type ChatToolResultDisplay,
    mergeChatAttachments,
    mergeChatImages,
    mergeChatMessageProvenance,
} from "../chatTypes";
import { messageDeleteKey, stableChatStringify } from "../chatUtilities";
import { mergeMessageDetails } from "./chatStateAssistant";
import {
    MAX_CHAT_RUNTIME_ASSISTANT_SEGMENTS_PER_RUN,
    MAX_CHAT_RUNTIME_COMMENTARY_PER_RUN,
    MAX_CHAT_RUNTIME_CONTROLS_PER_SESSION,
    MAX_CHAT_RUNTIME_DIAGNOSTICS_PER_RUN,
    type ChatRunState,
    type ChatRuntimeEvent,
    type ChatRuntimeMessageEntry,
    mergeChatStreamText,
    withRuntimeMessageProvenance,
} from "./chatStateModel";

function isToolCallMatching(
    toolCall: ChatToolCallDisplay,
    result: ChatToolResultDisplay
): boolean {
    if (toolCall.id || result.id) {
        return Boolean(toolCall.id && result.id && toolCall.id === result.id);
    }
    return Boolean(result.name && toolCall.name === result.name);
}

function isSameToolCall(left: ChatToolCallDisplay, right: ChatToolCallDisplay): boolean {
    if (left.id || right.id) {
        return Boolean(left.id && right.id && left.id === right.id);
    }
    return (
        left.name === right.name &&
        stableChatStringify(left.arguments ?? undefined) ===
            stableChatStringify(right.arguments ?? undefined)
    );
}

function hasSameToolCallShape(
    left: ChatToolCallDisplay,
    right: ChatToolCallDisplay
): boolean {
    return (
        left.name === right.name &&
        stableChatStringify(left.arguments ?? undefined) ===
            stableChatStringify(right.arguments ?? undefined)
    );
}

function uniqueMatchingDiagnosticIndex(
    diagnostics: ChatRuntimeMessageEntry[],
    predicate: (entry: ChatRuntimeMessageEntry) => boolean
): number {
    const indexes = diagnostics.flatMap((entry, index) =>
        predicate(entry) ? [index] : []
    );
    return indexes.length === 1 ? indexes[0]! : -1;
}

function mergeToolDiagnostic(
    previous: ChatHistoryMessage | undefined,
    incoming: ChatHistoryMessage
): ChatHistoryMessage {
    if (!previous) {
        return incoming;
    }

    const incomingCall = incoming.toolCalls?.[0];
    const incomingResult = incoming.toolResult || incomingCall?.toolResult;
    const calls = [...(previous.toolCalls || [])];
    let callIndex = -1;
    if (incomingCall) {
        callIndex = calls.findIndex(
            (candidate) =>
                Boolean(
                    incomingCall.id && candidate.id && incomingCall.id === candidate.id
                ) ||
                (!incomingCall.id &&
                    !candidate.id &&
                    hasSameToolCallShape(candidate, incomingCall))
        );
        if (callIndex === -1 && incomingCall.id) {
            const shapeMatches = calls.flatMap((candidate, index) =>
                !candidate.id && hasSameToolCallShape(candidate, incomingCall)
                    ? [index]
                    : []
            );
            callIndex = shapeMatches.length === 1 ? shapeMatches[0]! : -1;
        }
        if (callIndex === -1) {
            calls.push(incomingCall);
            callIndex = calls.length - 1;
        } else {
            calls[callIndex] = {
                ...calls[callIndex]!,
                ...incomingCall,
                toolResult: incomingCall.toolResult || calls[callIndex]?.toolResult,
            };
        }
    }

    if (incomingResult) {
        if (callIndex === -1) {
            callIndex = calls.findLastIndex((candidate) =>
                isToolCallMatching(candidate, incomingResult)
            );
        }
        if (callIndex !== -1) {
            calls[callIndex] = {
                ...calls[callIndex]!,
                toolResult: incomingResult,
            };
        }
    }

    const toolResult = incomingResult || previous.toolResult;
    return {
        ...previous,
        ...incoming,
        attachments: mergeChatAttachments(previous.attachments, incoming.attachments),
        images: mergeChatImages(previous.images, incoming.images),
        provenance: mergeChatMessageProvenance(incoming.provenance, previous.provenance),
        toolCalls: calls.length > 0 ? calls : incoming.toolCalls,
        toolResult,
    };
}

function matchingDiagnosticIndex(
    diagnostics: ChatRuntimeMessageEntry[],
    key: string,
    kind: "thinking" | "tool",
    message: ChatHistoryMessage
): number {
    let index = diagnostics.findLastIndex((entry) => entry.key === key);
    if (kind === "tool") {
        const incomingCall = message.toolCalls?.[0];
        const result =
            message.toolResult ||
            message.toolCalls?.find((call) => call.toolResult)?.toolResult;
        const hasStableId = Boolean(incomingCall?.id || result?.id);
        if (result && !hasStableId) {
            index = diagnostics.findLastIndex((entry) =>
                entry.message.toolCalls?.some(
                    (call) => !call.toolResult && isToolCallMatching(call, result)
                )
            );
        } else if (incomingCall && !hasStableId) {
            index = diagnostics.findLastIndex((entry) =>
                entry.message.toolCalls?.some(
                    (call) => !call.toolResult && isSameToolCall(call, incomingCall)
                )
            );
        } else if (index === -1 && incomingCall) {
            index = uniqueMatchingDiagnosticIndex(
                diagnostics,
                (entry) =>
                    entry.message.toolCalls?.some(
                        (call) => !call.id && hasSameToolCallShape(call, incomingCall)
                    ) === true
            );
        }
        if (index === -1 && result) {
            index = uniqueMatchingDiagnosticIndex(
                diagnostics,
                (entry) =>
                    entry.message.toolCalls?.some(
                        (call) =>
                            !call.id &&
                            !call.toolResult &&
                            (!result.name || call.name === result.name)
                    ) === true
            );
        }
    }
    return index;
}

function mergeDiagnosticEntry(
    diagnostics: ChatRuntimeMessageEntry[],
    key: string,
    kind: "thinking" | "tool",
    incoming: ChatHistoryMessage,
    sequence: number,
    uniqueSuffix: number | string
): ChatRuntimeMessageEntry[] {
    const next = [...diagnostics];
    const index = matchingDiagnosticIndex(next, key, kind, incoming);
    const previous = index === -1 ? undefined : next[index]?.message;
    const message =
        kind === "tool"
            ? mergeToolDiagnostic(previous, incoming)
            : mergeMessageDetails(previous, incoming, incoming.text);
    const uniqueKey =
        index === -1 && next.some((entry) => entry.key === key)
            ? `${key}:${uniqueSuffix}`
            : key;
    const entry = {
        key: next[index]?.key || uniqueKey,
        message,
        sequence: Math.min(next[index]?.sequence ?? sequence, sequence),
    };
    if (index === -1) {
        next.push(entry);
    } else {
        next[index] = entry;
    }
    return next.length <= MAX_CHAT_RUNTIME_DIAGNOSTICS_PER_RUN
        ? next
        : next.slice(-MAX_CHAT_RUNTIME_DIAGNOSTICS_PER_RUN);
}

function boundedDiagnosticToolResult(
    result: ChatToolResultDisplay | undefined
): ChatToolResultDisplay | undefined {
    return result
        ? {
              ...result,
              content: truncateCanonicalChatText(
                  result.content,
                  MAX_CANONICAL_TOOL_RESULT_CHARACTERS
              ),
              images: mergeChatImages([], result.images),
          }
        : undefined;
}

function boundedRuntimeDiagnosticMessage(
    message: ChatHistoryMessage
): ChatHistoryMessage {
    return {
        ...message,
        content: boundCanonicalChatToolValue(message.content),
        images: mergeChatImages([], message.images),
        text: truncateCanonicalChatText(
            message.text,
            MAX_CANONICAL_TOOL_RESULT_CHARACTERS
        ),
        thinking: message.thinking?.slice(0, 100).map((block) => ({
            ...block,
            text: truncateCanonicalChatText(
                block.text,
                MAX_CANONICAL_TOOL_RESULT_CHARACTERS
            ),
        })),
        toolCalls: message.toolCalls?.slice(0, 100).map((call) => ({
            ...call,
            arguments: boundCanonicalChatToolValue(call.arguments),
            toolResult: boundedDiagnosticToolResult(call.toolResult),
        })),
        toolResult: boundedDiagnosticToolResult(message.toolResult),
    };
}

export function applyDiagnosticEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "thinking" | "tool" }>
): ChatRunState {
    const key = event.kind === "tool" ? event.toolKey : "thinking:primary";
    return {
        ...run,
        assistantBoundarySequence: event.sequence,
        diagnostics: mergeDiagnosticEntry(
            run.diagnostics,
            key,
            event.kind,
            boundedRuntimeDiagnosticMessage({
                ...withRuntimeMessageProvenance(event.message, event),
                timestamp: event.message.timestamp || event.timestamp,
            }),
            event.sequence,
            event.sequence
        ),
    };
}

export function applyUserEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "user" }>
): ChatRunState {
    const message = {
        ...withRuntimeMessageProvenance(event.message, event),
        timestamp: event.message.timestamp || event.timestamp,
    };
    const key = `user:${messageDeleteKey(message)}`;
    if (run.userMessages.some((entry) => entry.key === key)) {
        return run;
    }
    return {
        ...run,
        assistantBoundarySequence: event.sequence,
        userMessages: [
            ...run.userMessages,
            {
                key,
                message,
                sequence: event.sequence,
            },
        ],
    };
}

export function applyControlEvent(
    controls: ChatRuntimeMessageEntry[],
    event: Extract<ChatRuntimeEvent, { kind: "control" }>
): ChatRuntimeMessageEntry[] {
    const controlId = event.message.controlId;
    const key = `control:${controlId || event.id || event.sequence}`;
    const incoming = {
        ...withRuntimeMessageProvenance(event.message, event),
        intent: "control" as const,
        runId: undefined,
        runtimeKey: key,
        runtimeSequence: event.sequence,
        timestamp: event.message.timestamp || event.timestamp,
    };
    const index = controls.findIndex(
        (entry) =>
            entry.key === key ||
            Boolean(controlId && entry.message.controlId === controlId)
    );
    const next = [...controls];
    const entry = {
        key: next[index]?.key || key,
        message: mergeMessageDetails(next[index]?.message, incoming, incoming.text),
        sequence: Math.min(next[index]?.sequence ?? event.sequence, event.sequence),
    };
    if (index === -1) {
        next.push(entry);
    } else {
        next[index] = entry;
    }
    return next.length <= MAX_CHAT_RUNTIME_CONTROLS_PER_SESSION
        ? next
        : next.slice(-MAX_CHAT_RUNTIME_CONTROLS_PER_SESSION);
}

export function applyCommentaryEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "commentary" }>
): ChatRunState {
    const messageKey = event.message.runtimeKey?.trim();
    const key = messageKey || `commentary:${event.id || event.sequence}`;
    const incoming = {
        ...withRuntimeMessageProvenance(event.message, event),
        intent: "commentary" as const,
        local: true,
        runId: run.runId,
        runtimeKey: key,
        runtimeSequence: event.sequence,
        timestamp: event.message.timestamp || event.timestamp,
    };
    const index = run.commentary.findIndex((entry) => entry.key === key);
    const commentary = [...run.commentary];
    const previous = commentary[index];
    const text =
        event.mode === "replace"
            ? incoming.text
            : mergeChatStreamText(previous?.message.text || "", incoming.text);
    const entry = {
        key: previous?.key || key,
        message: mergeMessageDetails(previous?.message, incoming, text),
        sequence: Math.min(previous?.sequence ?? event.sequence, event.sequence),
    };
    if (index === -1) {
        commentary.push(entry);
    } else {
        commentary[index] = entry;
    }
    return {
        ...run,
        assistantBoundarySequence: event.sequence,
        commentary:
            commentary.length <= MAX_CHAT_RUNTIME_COMMENTARY_PER_RUN
                ? commentary
                : commentary.slice(-MAX_CHAT_RUNTIME_COMMENTARY_PER_RUN),
    };
}

export function mergeRunDiagnostics(
    older: ChatRunState,
    newer: ChatRunState
): ChatRuntimeMessageEntry[] {
    let diagnostics: ChatRuntimeMessageEntry[] = [];
    for (const [runIndex, run] of [older, newer].entries()) {
        for (const [entryIndex, entry] of run.diagnostics.entries()) {
            const kind =
                entry.message.toolCalls?.length || entry.message.toolResult
                    ? "tool"
                    : "thinking";
            diagnostics = mergeDiagnosticEntry(
                diagnostics,
                kind === "thinking" ? "thinking:primary" : entry.key,
                kind,
                entry.message,
                entry.sequence,
                `merge-${runIndex}-${entryIndex}-${run.lastSequence}`
            );
        }
    }
    return diagnostics;
}

export function mergeRunUserMessages(
    older: ChatRunState,
    newer: ChatRunState
): ChatRuntimeMessageEntry[] {
    const entries = new Map<string, ChatRuntimeMessageEntry>();
    for (const entry of [...older.userMessages, ...newer.userMessages]) {
        entries.set(entry.key, entry);
    }
    return entries
        .values()
        .toArray()
        .toSorted(
            (left, right) =>
                left.sequence - right.sequence || left.key.localeCompare(right.key)
        );
}

export function mergeRunCommentary(
    older: ChatRunState,
    newer: ChatRunState
): ChatRuntimeMessageEntry[] {
    const entries = new Map<string, ChatRuntimeMessageEntry>();
    for (const entry of [...older.commentary, ...newer.commentary]) {
        const previous = entries.get(entry.key);
        entries.set(
            entry.key,
            previous
                ? {
                      key: previous.key,
                      message: mergeMessageDetails(
                          previous.message,
                          entry.message,
                          entry.message.text || previous.message.text
                      ),
                      sequence: Math.min(previous.sequence, entry.sequence),
                  }
                : entry
        );
    }
    return entries
        .values()
        .toArray()
        .toSorted(
            (left, right) =>
                left.sequence - right.sequence || left.key.localeCompare(right.key)
        )
        .slice(-MAX_CHAT_RUNTIME_COMMENTARY_PER_RUN);
}

export function mergeRunAssistantSegments(
    older: ChatRunState,
    newer: ChatRunState
): ChatRuntimeMessageEntry[] | undefined {
    const entries = new Map<string, ChatRuntimeMessageEntry>();
    for (const entry of [
        ...(older.assistantSegments || []),
        ...(newer.assistantSegments || []),
    ]) {
        const previous = entries.get(entry.key);
        entries.set(
            entry.key,
            previous
                ? {
                      key: previous.key,
                      message: mergeMessageDetails(
                          previous.message,
                          entry.message,
                          entry.message.text || previous.message.text
                      ),
                      sequence: Math.min(previous.sequence, entry.sequence),
                  }
                : entry
        );
    }
    if (entries.size === 0) {
        return undefined;
    }
    return entries
        .values()
        .toArray()
        .toSorted(
            (left, right) =>
                left.sequence - right.sequence || left.key.localeCompare(right.key)
        )
        .slice(-MAX_CHAT_RUNTIME_ASSISTANT_SEGMENTS_PER_RUN);
}
