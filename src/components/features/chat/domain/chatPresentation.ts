import {
    type ChatHistoryMessage,
    type ChatVisibilitySettings,
    isRenderableChatHistoryMessage,
    mergeChatAttachments,
    TOOL_ROLE_VARIANTS,
} from "../chatTypes";

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function createChatVisibility(
    shouldShowThinking: boolean,
    shouldShowTools: boolean
): ChatVisibilitySettings {
    return { shouldShowThinking, shouldShowTools };
}

/** Removes thinking content without disturbing explicit media on the message. */
export function stripThinkingFromMessage(
    message: ChatHistoryMessage
): ChatHistoryMessage {
    if (!Array.isArray(message.content)) {
        return { ...message, thinking: undefined };
    }

    const content = message.content.filter(
        (block) => !isRecord(block) || block.type !== "thinking"
    );
    return {
        ...message,
        content,
        thinking: undefined,
    };
}

function applyFinalThinkingPreference(
    messages: ChatHistoryMessage[],
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal: boolean
): ChatHistoryMessage[] {
    if (shouldKeepThinkingAfterFinal && visibility.shouldShowThinking) {
        return messages;
    }

    const reversed: ChatHistoryMessage[] = [];
    let response: Array<{
        message: ChatHistoryMessage;
        primaryAnswer: boolean;
        retainableThinking: boolean;
        withoutThinking: ChatHistoryMessage;
    }> = [];

    const flush = () => {
        const answerRunIds = new Set(
            response
                .filter((entry) => entry.primaryAnswer)
                .map((entry) => entry.message.runId)
                .filter((runId): runId is string => Boolean(runId))
        );
        const hasUnscopedAnswer = response.some(
            (entry) => entry.primaryAnswer && !entry.message.runId
        );
        const scopedRunIds = new Set(
            response
                .map((entry) => entry.message.runId)
                .filter((runId): runId is string => Boolean(runId))
        );
        const hasAnswer = response.some((entry) => entry.primaryAnswer);

        for (const entry of response) {
            const thinkingHasFinal = entry.message.runId
                ? answerRunIds.has(entry.message.runId) ||
                  (hasUnscopedAnswer && scopedRunIds.size <= 1)
                : hasAnswer;
            reversed.push(
                entry.retainableThinking && !thinkingHasFinal
                    ? entry.message
                    : entry.withoutThinking
            );
        }
        response = [];
    };

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        const withoutThinking = stripThinkingFromMessage(message);
        if (message.role.toLowerCase() === "user") {
            flush();
            reversed.push(withoutThinking);
            continue;
        }

        const hasToolDetails = Boolean(message.toolCalls?.length || message.toolResult);
        const hasPrimaryContent = Boolean(
            withoutThinking.text.trim() ||
            withoutThinking.images?.length ||
            (withoutThinking.attachments?.length &&
                !hasToolDetails &&
                !withoutThinking.hasOnlyHiddenToolAttachments)
        );
        const isDiagnosticTool = hasToolDetails && !hasPrimaryContent;
        const isPrimaryAnswer = Boolean(
            message.role.toLowerCase() === "assistant" &&
            hasPrimaryContent &&
            !isDiagnosticTool &&
            isRenderableChatHistoryMessage(withoutThinking, visibility)
        );
        response.push({
            message,
            primaryAnswer: isPrimaryAnswer,
            retainableThinking: Boolean(
                visibility.shouldShowThinking &&
                message.role.toLowerCase() === "assistant" &&
                message.thinking?.length &&
                (isDiagnosticTool || !hasPrimaryContent)
            ),
            withoutThinking,
        });
    }
    flush();

    return reversed
        .toReversed()
        .filter((message) => isRenderableChatHistoryMessage(message, visibility));
}

/**
 * Applies visibility as a pure projection. Raw messages are never mutated or
 * discarded, so toggling diagnostics can always reveal the same current run.
 */
export function presentChatMessages(
    messages: ChatHistoryMessage[],
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal = true
): ChatHistoryMessage[] {
    const visible: ChatHistoryMessage[] = [];
    let pendingToolMedia:
        | {
              attachments: NonNullable<ChatHistoryMessage["attachments"]>;
              runId?: string;
          }
        | undefined;

    const flushToolMedia = () => {
        if (!pendingToolMedia) {
            return;
        }
        visible.push({
            attachments: pendingToolMedia.attachments,
            content: "",
            hasOnlyHiddenToolAttachments: true,
            role: "assistant",
            runId: pendingToolMedia.runId,
            text: "",
        });
        pendingToolMedia = undefined;
    };

    for (const message of messages) {
        const role = message.role.toLowerCase();
        const isTool = TOOL_ROLE_VARIANTS.includes(role);
        const hasToolDetails = Boolean(message.toolCalls?.length || message.toolResult);
        const isToolDiagnostic = Boolean(
            isTool || (hasToolDetails && !message.text.trim() && !message.images?.length)
        );
        if (
            isToolDiagnostic &&
            !visibility.shouldShowTools &&
            Boolean(message.attachments?.length)
        ) {
            if (pendingToolMedia && pendingToolMedia.runId !== message.runId) {
                flushToolMedia();
            }
            pendingToolMedia = {
                attachments: mergeChatAttachments(
                    pendingToolMedia?.attachments,
                    message.attachments
                ),
                runId: message.runId,
            };
            continue;
        }

        if (
            role === "user" ||
            (pendingToolMedia &&
                role === "assistant" &&
                pendingToolMedia.runId !== message.runId)
        ) {
            flushToolMedia();
        }
        if (!isRenderableChatHistoryMessage(message, visibility)) {
            continue;
        }
        if (pendingToolMedia && role === "assistant") {
            visible.push({
                ...message,
                attachments: mergeChatAttachments(
                    message.attachments,
                    pendingToolMedia.attachments
                ),
                hasOnlyHiddenToolAttachments: !message.attachments?.length,
            });
            pendingToolMedia = undefined;
            continue;
        }
        visible.push(message);
    }
    flushToolMedia();

    return applyFinalThinkingPreference(
        visible,
        visibility,
        shouldKeepThinkingAfterFinal
    );
}
