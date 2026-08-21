import type {
    ChatDisplayMessage,
    ChatDisplaySettings,
    ChatMessagePart,
    ChatReadAloudView,
} from "./chatTypes.ts";

/**
 * Applies browser-owned thinking and tool visibility without mutating history.
 * @param message Canonical display message.
 * @param display Current per-session display settings.
 * @returns Parts that are eligible to render in the transcript.
 */
export function visibleChatMessageParts(
    message: ChatDisplayMessage,
    display: ChatDisplaySettings
): readonly ChatMessagePart[] {
    return message.parts.filter(
        (part) =>
            (part.kind !== "thinking" ||
                (display.showThinking &&
                    (part.status === "running" || display.keepThinkingAfterFinal))) &&
            (part.kind !== "tool" || display.showTools)
    );
}

/**
 * Keeps virtual rows only when their bubble can render meaningful content or state.
 * @param message Canonical display message.
 * @param display Current per-session display settings.
 * @param readAloud Shared speech lifecycle, when configured.
 * @returns Whether the transcript should allocate and measure a row.
 */
export function chatMessageHasVisibleContent(
    message: ChatDisplayMessage,
    display: ChatDisplaySettings,
    readAloud?: ChatReadAloudView
): boolean {
    return (
        visibleChatMessageParts(message, display).length > 0 ||
        message.attachments.length > 0 ||
        message.delivery === "sending" ||
        message.hydration !== undefined ||
        readAloud?.errorMessageId === message.id
    );
}

/**
 * Filters rows before virtualization so hidden diagnostics consume no layout space.
 * @param messages Canonical transcript rows.
 * @param display Current per-session display settings.
 * @param readAloud Shared speech lifecycle, when configured.
 * @returns Only rows that can render visible content or state.
 */
export function visibleChatTranscriptMessages(
    messages: readonly ChatDisplayMessage[],
    display: ChatDisplaySettings,
    readAloud?: ChatReadAloudView
): readonly ChatDisplayMessage[] {
    return messages.filter((message) =>
        chatMessageHasVisibleContent(message, display, readAloud)
    );
}
