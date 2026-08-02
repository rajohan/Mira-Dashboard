import {
    allChatMessageImages,
    type ChatHistoryMessage,
    type ChatVisibilitySettings,
    isRenderableChatHistoryMessage,
    mergeChatAttachments,
    mergeChatImages,
    TOOL_ROLE_VARIANTS,
} from "../chatTypes";
import {
    chatAnswerDetails,
    isAnswerCapableRole,
    isThinkingOnlyMessage,
} from "./chatAnswerContent";
import { structureChatMessages } from "./chatThinkingStructure";

export function createChatVisibility(
    shouldShowThinking: boolean,
    shouldShowTools: boolean
): ChatVisibilitySettings {
    return { shouldShowThinking, shouldShowTools };
}

function applyFinalThinkingPreference(
    messages: ChatHistoryMessage[],
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal: boolean
): ChatHistoryMessage[] {
    if (shouldKeepThinkingAfterFinal && visibility.shouldShowThinking) return messages;

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
            const isThinkingHasFinal = entry.message.runId
                ? answerRunIds.has(entry.message.runId) ||
                  (hasUnscopedAnswer && scopedRunIds.size <= 1)
                : hasAnswer;
            reversed.push(
                !isThinkingHasFinal && entry.retainableThinking
                    ? entry.message
                    : entry.withoutThinking
            );
        }
        response = [];
    };

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        const details = chatAnswerDetails(message);
        const { hasPrimaryContent, hasToolOutput, withoutThinking } = details;
        if (message.role.toLowerCase() === "user") {
            flush();
            reversed.push(withoutThinking);
            continue;
        }
        const isDiagnosticTool = hasToolOutput && !hasPrimaryContent;
        const role = message.role.toLowerCase();
        response.push({
            message,
            primaryAnswer:
                isAnswerCapableRole(role) &&
                details.isPrimaryAnswerContent &&
                isRenderableChatHistoryMessage(withoutThinking, visibility),
            retainableThinking: Boolean(
                visibility.shouldShowThinking &&
                role === "assistant" &&
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

/** Applies visibility to already-structured messages. */
export function presentStructuredChatMessages(
    messages: ChatHistoryMessage[],
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal = true
): ChatHistoryMessage[] {
    const visible: ChatHistoryMessage[] = [];
    let pendingToolMedia:
        | {
              attachments: NonNullable<ChatHistoryMessage["attachments"]>;
              images: NonNullable<ChatHistoryMessage["images"]>;
              local?: boolean;
              runId?: string;
              runtimeKey?: string;
              timestamp?: string;
          }
        | undefined;

    const flushToolMedia = () => {
        if (!pendingToolMedia) return;
        visible.push({
            attachments: pendingToolMedia.attachments,
            content: "",
            hasOnlyHiddenToolAttachments: true,
            images: pendingToolMedia.images,
            local: pendingToolMedia.local,
            role: "assistant",
            runId: pendingToolMedia.runId,
            runtimeKey: pendingToolMedia.runtimeKey,
            text: "",
            timestamp: pendingToolMedia.timestamp,
        });
        pendingToolMedia = undefined;
    };

    for (const message of messages) {
        const role = message.role.toLowerCase();
        const isTool = TOOL_ROLE_VARIANTS.includes(role);
        const hasToolDetails = Boolean(message.toolCalls?.length || message.toolResult);
        const isToolDiagnostic = Boolean(
            isTool || message.isToolUse || (hasToolDetails && !message.text.trim())
        );
        const toolImages = allChatMessageImages(message);
        if (
            isToolDiagnostic &&
            !visibility.shouldShowTools &&
            ((message.attachments?.length || 0) > 0 || toolImages.length > 0)
        ) {
            if (pendingToolMedia && pendingToolMedia.runId !== message.runId) {
                flushToolMedia();
            }
            pendingToolMedia = {
                attachments: mergeChatAttachments(
                    pendingToolMedia?.attachments,
                    message.attachments
                ),
                images: mergeChatImages(pendingToolMedia?.images, toolImages),
                local: pendingToolMedia
                    ? pendingToolMedia.local === true && message.local === true
                    : message.local,
                runId: message.runId,
                runtimeKey: pendingToolMedia?.runtimeKey || message.runtimeKey,
                timestamp: pendingToolMedia?.timestamp || message.timestamp,
            };
            continue;
        }

        const canReceivePendingToolMedia =
            isAnswerCapableRole(role) && !isThinkingOnlyMessage(message);
        if (
            role === "user" ||
            (pendingToolMedia &&
                canReceivePendingToolMedia &&
                pendingToolMedia.runId !== message.runId)
        ) {
            flushToolMedia();
        }
        if (!isRenderableChatHistoryMessage(message, visibility)) continue;
        if (pendingToolMedia && canReceivePendingToolMedia) {
            visible.push({
                ...message,
                attachments: mergeChatAttachments(
                    message.attachments,
                    pendingToolMedia.attachments
                ),
                hasOnlyHiddenToolAttachments:
                    pendingToolMedia.attachments.length > 0 &&
                    (message.attachments?.length || 0) === 0,
                images: mergeChatImages(message.images, pendingToolMedia.images),
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

/** Structures and applies visibility as a pure projection. */
export function presentChatMessages(
    messages: ChatHistoryMessage[],
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal = true
): ChatHistoryMessage[] {
    return presentStructuredChatMessages(
        structureChatMessages(messages),
        visibility,
        shouldKeepThinkingAfterFinal
    );
}
