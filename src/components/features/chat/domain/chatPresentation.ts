import {
    allChatMessageImages,
    type ChatHistoryMessage,
    type ChatVisibilitySettings,
    isRenderableChatHistoryMessage,
    mergeChatAttachments,
    mergeChatImages,
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

interface PrimaryAnswerDetails {
    hasPrimaryContent: boolean;
    hasToolOutput: boolean;
    isPrimaryAnswerContent: boolean;
    withoutThinking: ChatHistoryMessage;
}

function primaryAnswerDetails(message: ChatHistoryMessage): PrimaryAnswerDetails {
    const withoutThinking = stripThinkingFromMessage(message);
    const hasToolOutput = Boolean(message.toolCalls?.length || message.toolResult);
    const hasVisibleAttachments = Boolean(
        withoutThinking.attachments?.length &&
        !withoutThinking.hasOnlyHiddenToolAttachments &&
        (!hasToolOutput || message.isFinal === true)
    );
    const hasPrimaryContent = Boolean(
        hasVisibleAttachments ||
        withoutThinking.text.trim() ||
        withoutThinking.images?.length
    );
    return {
        hasPrimaryContent,
        hasToolOutput,
        isPrimaryAnswerContent:
            hasPrimaryContent && (!hasToolOutput || message.isFinal === true),
        withoutThinking,
    };
}

/** Identifies answer content independently from role and visibility settings. */
export function hasPrimaryAnswerContent(message: ChatHistoryMessage): boolean {
    return primaryAnswerDetails(message).isPrimaryAnswerContent;
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
                !thinkingHasFinal && entry.retainableThinking
                    ? entry.message
                    : entry.withoutThinking
            );
        }
        response = [];
    };

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        const details = primaryAnswerDetails(message);
        const { hasPrimaryContent, hasToolOutput, withoutThinking } = details;
        if (message.role.toLowerCase() === "user") {
            flush();
            reversed.push(withoutThinking);
            continue;
        }

        const isDiagnosticTool = hasToolOutput && !hasPrimaryContent;
        const isPrimaryAnswer = Boolean(
            message.role.toLowerCase() === "assistant" &&
            details.isPrimaryAnswerContent &&
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
        if (message.role.toLowerCase() === "user") {
            segment += 1;
        }
        return segment;
    });
    let completedWindowStart = 0;
    for (const [finalIndex, message] of messages.entries()) {
        if (!isExplicitFinalMessage(message)) {
            continue;
        }
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
        if (isStartingNewRuntimeRun) {
            return groupStart;
        }
        const interveningMessages = messages.slice(previousUser + 1, nextUser);
        const isGatewayRestartContinuation =
            /^\[System\]\s+Your previous turn was interrupted by a gateway restart\b/iu.test(
                nextUserMessage.text.trim()
            );
        const hasPriorAnswer = interveningMessages.some((candidate) =>
            isPrimaryAssistantMessage(candidate)
        );
        if (hasPriorAnswer && !isGatewayRestartContinuation) {
            return groupStart;
        }
        const hasContinuationEvidence = interveningMessages.some((candidate) =>
            hasToolDetails(candidate)
        );
        if (!hasContinuationEvidence) {
            return groupStart;
        }
        groupStart = previousUser;
    }
    return groupStart;
}

function isPrimaryAssistantMessage(message: ChatHistoryMessage): boolean {
    return message.role.toLowerCase() === "assistant" && hasPrimaryAnswerContent(message);
}

function isExplicitFinalMessage(message: ChatHistoryMessage): boolean {
    const role = message.role.toLowerCase();
    return (
        (role === "assistant" || role === "system") &&
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
    const rangeEnd =
        finalIndex === -1
            ? nextSegmentIndex === -1
                ? messages.length
                : nextSegmentIndex
            : finalIndex;
    let latestPrerequisiteIndex = -1;

    for (const [index, message] of messages.entries()) {
        if (index < rangeStart || index >= rangeEnd) {
            continue;
        }
        const isUser = message.role.toLowerCase() === "user";
        const isCompatibleSteer = Boolean(
            isUser && (!message.runId || message.runId.startsWith("dashboard-chat-"))
        );
        if (
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

/** Extracts every assistant thinking shape into one bubble per run or response. */
function collapseRunThinking(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
    const segments = responseSegments(messages);
    const groups = new Map<string, ThinkingGroup>();

    for (const [index, message] of messages.entries()) {
        if (message.role.toLowerCase() !== "assistant" || !message.thinking?.length) {
            continue;
        }
        const segment = segments[index] ?? 0;
        const key = message.runId ? `run:${message.runId}` : `segment:${segment}`;
        const group = groups.get(key) || {
            blocks: [],
            firstIndex: index,
            runId: message.runId,
            segment,
            template: message,
        };
        mergeThinkingBlocks(group.blocks, message.thinking);
        if (message.local === true || group.template.local !== true) {
            group.template = message;
        }
        groups.set(key, group);
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
                (isExplicitFinalMessage(message) || isPrimaryAssistantMessage(message))
        );
        const isAbandonedUnscopedThinking =
            !group.runId && group.segment < latestSegment && !hasSettledAnswer;
        if (isAbandonedUnscopedThinking) {
            continue;
        }
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
        collapsed.push(stripThinkingFromMessage(message));
    }
    const trailingGroups = groupsByAnchorIndex
        .get(messages.length)
        ?.toSorted((left, right) => left.order - right.order);
    if (trailingGroups) {
        collapsed.push(...trailingGroups.map((group) => group.message));
    }
    return collapsed;
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
              images: NonNullable<ChatHistoryMessage["images"]>;
              local?: boolean;
              runId?: string;
              runtimeKey?: string;
              timestamp?: string;
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

    for (const message of collapseRunThinking(messages)) {
        const role = message.role.toLowerCase();
        const isTool = TOOL_ROLE_VARIANTS.includes(role);
        const hasToolDetails = Boolean(message.toolCalls?.length || message.toolResult);
        const isToolDiagnostic = Boolean(
            isTool || (hasToolDetails && !message.text.trim())
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
