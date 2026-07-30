import type { CanonicalChatHistoryRow } from "../../../../../../contracts/chatCanonicalHistory";
import {
    type ChatHistoryMessage,
    mergeChatAttachments,
    mergeChatMessageProvenance,
} from "../chatTypes";

function matchingToolCallIndex(
    message: ChatHistoryMessage,
    candidate: ChatHistoryMessage
): number {
    const result = message.toolResult;
    if (
        !result ||
        candidate.role.toLowerCase() !== "assistant" ||
        (message.runId && candidate.runId && message.runId !== candidate.runId)
    ) {
        return -1;
    }
    return (
        candidate.toolCalls?.findIndex((toolCall) => {
            if (toolCall.toolResult) {
                return false;
            }
            if (toolCall.id || result.id) {
                return Boolean(toolCall.id && result.id && toolCall.id === result.id);
            }
            return Boolean(result.name && toolCall.name === result.name);
        }) ?? -1
    );
}

/**
 * Folds OpenClaw tool-result rows into their canonical assistant call.
 * @param existing Existing value.
 * @param rows Canonical history rows.
 * @returns Append open claw history result.
 */
export function appendOpenClawHistory(
    existing: ChatHistoryMessage[],
    rows: CanonicalChatHistoryRow[] | undefined
): ChatHistoryMessage[] {
    const normalized = (rows || []).map(
        (row): ChatHistoryMessage => ({
            ...row.message,
            provenance: {
                id: row.id,
                provider: row.provider,
                sequence: row.sequence,
                source: "openclaw-history",
            },
        })
    );
    const result: ChatHistoryMessage[] = [...existing];
    for (const message of normalized) {
        if (!message.toolResult || !message.role.toLowerCase().startsWith("tool")) {
            result.push(message);
            continue;
        }
        const latestUserIndex = result.findLastIndex(
            (candidate) => candidate.role.toLowerCase() === "user"
        );
        const assistantIndex = result.findLastIndex(
            (candidate, index) =>
                (message.runId
                    ? candidate.runId === message.runId
                    : Boolean(message.toolResult?.id) || index > latestUserIndex) &&
                matchingToolCallIndex(message, candidate) !== -1
        );
        if (assistantIndex === -1) {
            result.push(message);
            continue;
        }

        const assistant = result[assistantIndex]!;
        const toolCallIndex = matchingToolCallIndex(message, assistant);
        const toolCalls = [...(assistant.toolCalls || [])];
        toolCalls[toolCallIndex] = {
            ...toolCalls[toolCallIndex]!,
            toolResult: message.toolResult,
        };
        result[assistantIndex] = {
            ...assistant,
            attachments: mergeChatAttachments(assistant.attachments, message.attachments),
            provenance: mergeChatMessageProvenance(
                assistant.provenance,
                message.provenance
            ),
            timestamp: message.timestamp || assistant.timestamp,
            toolCalls,
            toolResult: (toolCalls.length === 1 ? message : assistant).toolResult,
        };
    }
    return result;
}

/**
 * Folds OpenClaw tool-result rows into their canonical assistant call.
 * @param rows Canonical history rows.
 * @returns Adapt open claw history result.
 */
export function adaptOpenClawHistory(
    rows: CanonicalChatHistoryRow[] | undefined
): ChatHistoryMessage[] {
    return appendOpenClawHistory([], rows);
}
