import { type ChatHistoryMessage, mergeChatAttachments } from "../chatTypes";
import {
    normalizeOpenClawHistoryMessage,
    type RawOpenClawHistoryMessage,
} from "./openClawHistoryNormalizer";

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

/** Folds OpenClaw tool-result rows into their canonical assistant call. */
export function adaptOpenClawHistory(
    messages: RawOpenClawHistoryMessage[] | undefined
): ChatHistoryMessage[] {
    const normalized = (messages || []).map((message) =>
        normalizeOpenClawHistoryMessage(message)
    );
    const result: ChatHistoryMessage[] = [];
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
                index > latestUserIndex &&
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
            timestamp: message.timestamp || assistant.timestamp,
            toolCalls,
            toolResult:
                toolCalls.length === 1 ? message.toolResult : assistant.toolResult,
        };
    }
    return result;
}
