import {
    type ChatHistoryMessage,
    isRenderableChatHistoryMessage,
    mergeChatMessageProvenance,
} from "../chatTypes";
import {
    hasPrimaryAnswerContent,
    isAnswerCapableRole,
    isThinkingOnlyMessage,
    stripThinkingFromMessage,
} from "./chatAnswerContent";

function hasToolDetails(message: ChatHistoryMessage): boolean {
    return Boolean(message.toolCalls?.length || message.toolResult);
}

interface ThinkingGroup {
    blocks: NonNullable<ChatHistoryMessage["thinking"]>;
    firstIndex: number;
    runId?: string;
    segment: number;
    template: ChatHistoryMessage;
}

function mergeThinkingBlocks(
    target: NonNullable<ChatHistoryMessage["thinking"]>,
    incoming: NonNullable<ChatHistoryMessage["thinking"]>
): void {
    for (const block of incoming) {
        let matchingIndex = block.id
            ? target.findIndex((candidate) => candidate.id === block.id)
            : -1;
        if (matchingIndex === -1) {
            matchingIndex = target.findIndex(
                (candidate) =>
                    candidate.text === block.text && (!block.id || !candidate.id)
            );
        }
        if (matchingIndex === -1) {
            target.push(block);
        } else {
            target[matchingIndex] = { ...target[matchingIndex], ...block };
        }
    }
}

function responseSegments(messages: ChatHistoryMessage[]): number[] {
    let segment = 0;
    const segments = messages.map((message) => {
        if (message.role.toLowerCase() === "user") segment += 1;
        return segment;
    });
    let completedWindowStart = 0;
    for (const [finalIndex, message] of messages.entries()) {
        if (!isExplicitFinalMessage(message)) continue;
        const userIndexes = messages
            .slice(completedWindowStart, finalIndex)
            .flatMap((candidate, offset) =>
                candidate.role.toLowerCase() === "user"
                    ? [completedWindowStart + offset]
                    : []
            );
        const groupStart = completedResponseStart(messages, userIndexes);
        if (groupStart !== undefined) {
            const completedSegment = segments[groupStart]!;
            for (let index = groupStart; index <= finalIndex; index += 1) {
                segments[index] = completedSegment;
            }
        }
        completedWindowStart = finalIndex + 1;
    }
    return segments;
}

function completedResponseStart(
    messages: ChatHistoryMessage[],
    userIndexes: number[]
): number | undefined {
    let groupStart = userIndexes.at(-1);
    for (let index = userIndexes.length - 2; index >= 0; index -= 1) {
        const previousUser = userIndexes[index]!;
        const nextUser = userIndexes[index + 1]!;
        const previousUserMessage = messages[previousUser]!;
        const nextUserMessage = messages[nextUser]!;
        const isStartingNewRuntimeRun =
            nextUserMessage.runtimeSequence !== undefined &&
            nextUserMessage.runId !== undefined &&
            nextUserMessage.runId !== previousUserMessage.runId;
        if (isStartingNewRuntimeRun) return groupStart;

        const interveningMessages = messages.slice(previousUser + 1, nextUser);
        const isGatewayRestartContinuation =
            /^\[System\]\s+Your previous turn was interrupted by a gateway restart\b/iu.test(
                nextUserMessage.text.trim()
            );
        const hasPriorAnswer = interveningMessages.some((message) =>
            isSettledAnswerMessage(message)
        );
        if (hasPriorAnswer && !isGatewayRestartContinuation) return groupStart;
        const hasContinuationEvidence = interveningMessages.some(
            (candidate) =>
                hasToolDetails(candidate) ||
                isThinkingOnlyMessage(candidate) ||
                candidate.isToolUse === true
        );
        if (!hasContinuationEvidence) return groupStart;
        groupStart = previousUser;
    }
    return groupStart;
}

function isPrimaryAssistantMessage(message: ChatHistoryMessage): boolean {
    return message.role.toLowerCase() === "assistant" && hasPrimaryAnswerContent(message);
}

function isSettledAnswerMessage(message: ChatHistoryMessage): boolean {
    return isAnswerCapableRole(message.role) && hasPrimaryAnswerContent(message);
}

function isExplicitFinalMessage(message: ChatHistoryMessage): boolean {
    return (
        isAnswerCapableRole(message.role) &&
        message.isFinal === true &&
        hasPrimaryAnswerContent(message)
    );
}

function thinkingAnchorIndex(
    messages: ChatHistoryMessage[],
    segments: number[],
    group: ThinkingGroup
): number {
    const isInGroup = (message: ChatHistoryMessage, index: number) =>
        group.runId ? message.runId === group.runId : segments[index] === group.segment;
    const matchingUserBeforeThinking = messages.findLastIndex(
        (message, index) =>
            index <= group.firstIndex &&
            message.role.toLowerCase() === "user" &&
            (isInGroup(message, index) || !message.runId)
    );
    const rangeStart = matchingUserBeforeThinking === -1 ? 0 : matchingUserBeforeThinking;
    const explicitFinalIndex = messages.findIndex(
        (message, index) =>
            index >= group.firstIndex &&
            isInGroup(message, index) &&
            isExplicitFinalMessage(message)
    );
    const finalIndex =
        explicitFinalIndex === -1
            ? messages.findIndex(
                  (message, index) =>
                      index >= group.firstIndex &&
                      isInGroup(message, index) &&
                      isPrimaryAssistantMessage(message)
              )
            : explicitFinalIndex;
    const nextSegmentIndex = group.runId
        ? -1
        : segments.findIndex(
              (segment, index) => index > group.firstIndex && segment !== group.segment
          );
    let rangeEnd = finalIndex;
    if (rangeEnd === -1) {
        rangeEnd = nextSegmentIndex === -1 ? messages.length : nextSegmentIndex;
    }
    let latestPrerequisiteIndex = -1;

    for (const [index, message] of messages.entries()) {
        if (index < rangeStart || index >= rangeEnd) continue;
        const isUser = message.role.toLowerCase() === "user";
        const isControl = message.intent === "control";
        const isCommentary = message.intent === "commentary";
        const isCompatibleSteer =
            isUser && (!message.runId || message.runId.startsWith("dashboard-chat-"));
        if (
            isCommentary ||
            isControl ||
            (isUser && (isCompatibleSteer || isInGroup(message, index))) ||
            (isInGroup(message, index) && hasToolDetails(message))
        ) {
            latestPrerequisiteIndex = index;
        }
    }

    const requestedAnchor =
        latestPrerequisiteIndex === -1 ? group.firstIndex : latestPrerequisiteIndex + 1;
    return finalIndex === -1 ? requestedAnchor : Math.min(requestedAnchor, finalIndex);
}

function standaloneThinkingMessage(group: ThinkingGroup): ChatHistoryMessage {
    const template = stripThinkingFromMessage(group.template);
    return {
        ...template,
        attachments: undefined,
        content: group.blocks.map((block) => ({
            id: block.id,
            text: block.text,
            type: "thinking",
        })),
        images: undefined,
        role: "assistant",
        runId: group.runId,
        text: "",
        thinking: group.blocks,
        toolCalls: undefined,
        toolResult: undefined,
    };
}

function collapseRunThinking(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
    const segments = responseSegments(messages);
    const groups = new Map<string, ThinkingGroup>();

    for (const [index, message] of messages.entries()) {
        const role = message.role.toLowerCase();
        if (!isAnswerCapableRole(role) || !message.thinking?.length) continue;
        const segment = segments[index] ?? 0;
        const key = message.runId ? `run:${message.runId}` : `segment:${segment}`;
        const group = groups.get(key);
        if (!group) {
            const blocks: ThinkingGroup["blocks"] = [];
            mergeThinkingBlocks(blocks, message.thinking);
            groups.set(key, {
                blocks,
                firstIndex: index,
                runId: message.runId,
                segment,
                template: message,
            });
            continue;
        }
        mergeThinkingBlocks(group.blocks, message.thinking);
        const shouldReplaceTemplate =
            message.local === true || group.template.local !== true;
        const primaryTemplate = shouldReplaceTemplate ? message : group.template;
        const foldedTemplate = shouldReplaceTemplate ? group.template : message;
        group.template = {
            ...primaryTemplate,
            provenance: mergeChatMessageProvenance(
                primaryTemplate.provenance,
                foldedTemplate.provenance
            ),
        };
    }

    const groupsByAnchorIndex = new Map<
        number,
        Array<{ message: ChatHistoryMessage; order: number }>
    >();
    const latestSegment = Math.max(0, ...segments);
    for (const group of groups.values()) {
        const hasSettledAnswer = messages.some(
            (message, index) =>
                segments[index] === group.segment &&
                (isExplicitFinalMessage(message) || isSettledAnswerMessage(message))
        );
        const isAbandonedUnscopedThinking =
            !group.runId && group.segment < latestSegment && !hasSettledAnswer;
        if (isAbandonedUnscopedThinking) continue;
        const anchorIndex = thinkingAnchorIndex(messages, segments, group);
        const anchoredGroups = groupsByAnchorIndex.get(anchorIndex) || [];
        anchoredGroups.push({
            message: standaloneThinkingMessage(group),
            order: group.firstIndex,
        });
        groupsByAnchorIndex.set(anchorIndex, anchoredGroups);
    }

    const collapsed: ChatHistoryMessage[] = [];
    for (const [index, message] of messages.entries()) {
        const anchoredGroups = groupsByAnchorIndex
            .get(index)
            ?.toSorted((left, right) => left.order - right.order);
        if (anchoredGroups) {
            collapsed.push(...anchoredGroups.map((group) => group.message));
        }
        const withoutThinking = stripThinkingFromMessage(message);
        if (
            !message.thinking?.length ||
            isRenderableChatHistoryMessage(withoutThinking, {
                shouldShowThinking: true,
                shouldShowTools: true,
            })
        ) {
            collapsed.push(withoutThinking);
        }
    }
    const trailingGroups = groupsByAnchorIndex
        .get(messages.length)
        ?.toSorted((left, right) => left.order - right.order);
    if (trailingGroups) {
        collapsed.push(...trailingGroups.map((group) => group.message));
    }
    return collapsed;
}

// Normalizes thinking into stable standalone messages before visibility policy.
export function structureChatMessages(
    messages: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    return collapseRunThinking(messages);
}
