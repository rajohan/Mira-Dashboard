import {
    type ChatHistoryMessage,
    type ChatThinkingDisplay,
    mergeChatAttachments,
    mergeChatImages,
    mergeChatMessageProvenance,
} from "../chatTypes";
import { stripEquivalentChatTextPrefix } from "../chatUtilities";
import {
    MAX_CHAT_RUNTIME_ASSISTANT_SEGMENTS_PER_RUN,
    type ChatRunState,
    type ChatRuntimeEvent,
    type ChatRuntimeMessageEntry,
    hasNonTextDetails,
    mergeChatStreamText,
    withRuntimeMessageProvenance,
} from "./chatStateModel";

/**
 * Builds the next assistant text from one runtime stream event.
 *
 * @param previousText - Text already projected for the run.
 * @param incomingText - Text carried by the new event.
 * @param mode - Provider merge mode for the event.
 * @param canUseText - Whether this source may mutate the visible text.
 * @param isCompletedSessionEcho - Whether the event only repeats completed text.
 * @returns Projected assistant text.
 */
function nextAssistantText(
    previousText: string,
    incomingText: string,
    mode: Extract<ChatRuntimeEvent, { kind: "assistant" }>["mode"],
    canUseText: boolean,
    isCompletedSessionEcho: boolean
): string {
    if (!canUseText || isCompletedSessionEcho) {
        return previousText;
    }
    if (mode === "replace") {
        return incomingText;
    }
    if (mode === "append") {
        return `${previousText}${incomingText}`;
    }
    return mergeChatStreamText(previousText, incomingText);
}
function mergeThinking(
    previous: ChatThinkingDisplay[] = [],
    incoming: ChatThinkingDisplay[] = []
): ChatThinkingDisplay[] {
    const next = [...previous];
    for (const [incomingIndex, block] of incoming.entries()) {
        let matchingIndex =
            incomingIndex < next.length && !next[incomingIndex]?.id ? incomingIndex : -1;
        if (block.id) {
            matchingIndex = next.findIndex((candidate) => candidate.id === block.id);
        }
        if (matchingIndex === -1) {
            next.push(block);
            continue;
        }

        const existing = next[matchingIndex]!;
        next[matchingIndex] = {
            ...existing,
            ...block,
            text: block.snapshot
                ? block.text
                : mergeChatStreamText(existing.text, block.text),
        };
    }
    return next;
}

export function mergeMessageDetails(
    previous: ChatHistoryMessage | undefined,
    incoming: ChatHistoryMessage,
    text: string
): ChatHistoryMessage {
    return {
        ...previous,
        ...incoming,
        attachments: mergeChatAttachments(previous?.attachments, incoming.attachments),
        images: mergeChatImages(previous?.images, incoming.images),
        provenance: mergeChatMessageProvenance(incoming.provenance, previous?.provenance),
        text,
        thinking: mergeThinking(previous?.thinking, incoming.thinking),
        toolCalls: incoming.toolCalls?.length ? incoming.toolCalls : previous?.toolCalls,
        toolResult: incoming.toolResult || previous?.toolResult,
    };
}

function assistantTextContribution(
    previousText: string,
    nextText: string,
    incomingText: string,
    mode: Extract<ChatRuntimeEvent, { kind: "assistant" }>["mode"],
    canUseText: boolean,
    isCompletedSessionEcho: boolean
): string {
    if (!canUseText || isCompletedSessionEcho) {
        return "";
    }
    if (mode === "replace") {
        return incomingText;
    }
    return nextText.startsWith(previousText)
        ? nextText.slice(previousText.length)
        : incomingText;
}

function assistantSegmentMessage(
    incoming: ChatHistoryMessage,
    text: string
): ChatHistoryMessage {
    return {
        ...incoming,
        content: text,
        text,
        toolCalls: undefined,
        toolResult: undefined,
    };
}

function hasAssistantSegmentContent(message: ChatHistoryMessage): boolean {
    return Boolean(message.text || message.images?.length || message.attachments?.length);
}

export function latestAssistantBoundarySequence(run: ChatRunState): number {
    return Math.max(
        -1,
        run.assistantBoundarySequence ?? -1,
        ...run.commentary.map((entry) => entry.sequence),
        ...run.diagnostics.map((entry) => entry.sequence),
        ...run.userMessages.map((entry) => entry.sequence)
    );
}

function applyAssistantSegment(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "assistant" }>,
    incoming: ChatHistoryMessage,
    previousText: string,
    nextText: string,
    canUseText: boolean,
    isCompletedSessionEcho: boolean
): ChatRuntimeMessageEntry[] | undefined {
    const previousSegments = run.assistantSegments || [];
    let contribution = assistantTextContribution(
        previousText,
        nextText,
        incoming.text,
        event.mode,
        canUseText,
        isCompletedSessionEcho
    );
    const startsNewSegment =
        previousSegments.length === 0 ||
        run.lastContentKind !== "assistant" ||
        (run.assistantBoundarySequence ?? -1) > (run.assistantSequence ?? -1);
    const previousSegment = startsNewSegment ? undefined : previousSegments.at(-1);
    if (event.mode === "replace") {
        const sealedText = (
            startsNewSegment ? previousSegments : previousSegments.slice(0, -1)
        )
            .map((entry) => entry.message.text)
            .join("");
        if (sealedText) {
            contribution =
                stripEquivalentChatTextPrefix(contribution, sealedText) ?? contribution;
        }
    }
    let segmentText = contribution;
    if (previousSegment) {
        if (event.mode === "replace") {
            segmentText = contribution;
        } else if (event.mode === "append") {
            segmentText = `${previousSegment.message.text}${contribution}`;
        } else {
            segmentText = mergeChatStreamText(previousSegment.message.text, contribution);
        }
    }
    const segmentIncoming = assistantSegmentMessage(incoming, segmentText);
    if (!hasAssistantSegmentContent(segmentIncoming)) {
        return run.assistantSegments;
    }
    const segment: ChatRuntimeMessageEntry = {
        key: previousSegment?.key || `assistant:${event.sequence}`,
        message: previousSegment
            ? mergeMessageDetails(previousSegment.message, segmentIncoming, segmentText)
            : segmentIncoming,
        sequence: previousSegment?.sequence ?? event.sequence,
    };
    const segments = previousSegment
        ? [...previousSegments.slice(0, -1), segment]
        : [...previousSegments, segment];
    return segments.slice(-MAX_CHAT_RUNTIME_ASSISTANT_SEGMENTS_PER_RUN);
}

export function applyAssistantEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "assistant" }>
): ChatRunState {
    const isSessionUpdateAfterCanonicalFinal =
        run.phase !== "active" &&
        event.source === "session" &&
        run.assistantSource === "chat";
    const canUseText =
        !isSessionUpdateAfterCanonicalFinal &&
        (!event.message.text ||
            !run.assistantSource ||
            run.assistantSource === event.source ||
            run.phase !== "active");
    const sourcedMessage = withRuntimeMessageProvenance(event.message, event);
    const incoming = canUseText
        ? sourcedMessage
        : { ...sourcedMessage, content: [], text: "" };
    if (!incoming.text && !hasNonTextDetails(incoming)) {
        return run;
    }

    const previousText = run.assistant?.text || "";
    const isCompletedSessionEcho = Boolean(
        run.phase !== "active" &&
        event.source === "session" &&
        previousText.trim() &&
        previousText.trim() === incoming.text.trim()
    );
    const text = nextAssistantText(
        previousText,
        incoming.text,
        event.mode,
        canUseText,
        isCompletedSessionEcho
    );
    const assistant = mergeMessageDetails(run.assistant, incoming, text);
    const assistantSegments = applyAssistantSegment(
        run,
        event,
        incoming,
        previousText,
        text,
        canUseText,
        isCompletedSessionEcho
    );
    let assistantSource = run.assistantSource;
    if (incoming.text) {
        assistantSource =
            event.mode === "replace"
                ? event.source
                : (run.assistantSource ?? event.source);
    }
    return {
        ...run,
        assistant:
            event.mode === "replace"
                ? {
                      ...assistant,
                      toolCalls: incoming.toolCalls,
                      toolResult: incoming.toolResult,
                  }
                : assistant,
        assistantSegments,
        assistantSequence: event.sequence,
        assistantSource,
    };
}
