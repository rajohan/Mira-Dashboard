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

        const hasToolOutput = Boolean(message.toolCalls?.length || message.toolResult);
        const hasPrimaryContent = Boolean(
            withoutThinking.text.trim() ||
            withoutThinking.images?.length ||
            (withoutThinking.attachments?.length &&
                !hasToolOutput &&
                !withoutThinking.hasOnlyHiddenToolAttachments)
        );
        const isDiagnosticTool = hasToolOutput && !hasPrimaryContent;
        const isPrimaryAnswer = Boolean(
            message.role.toLowerCase() === "assistant" &&
            hasPrimaryContent &&
            !hasToolOutput &&
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
    return messages.map((message) => {
        if (message.role.toLowerCase() === "user") {
            segment += 1;
        }
        return segment;
    });
}

function isPrimaryAssistantMessage(message: ChatHistoryMessage): boolean {
    const withoutThinking = stripThinkingFromMessage(message);
    return Boolean(
        message.role.toLowerCase() === "assistant" &&
        !hasToolDetails(withoutThinking) &&
        (withoutThinking.text.trim() ||
            withoutThinking.images?.length ||
            withoutThinking.attachments?.length)
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
    const finalIndex = messages.findIndex(
        (message, index) =>
            index >= group.firstIndex &&
            isInGroup(message, index) &&
            isPrimaryAssistantMessage(message)
    );
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
            (isUser && (isInGroup(message, index) || isCompatibleSteer)) ||
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
    for (const group of groups.values()) {
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
