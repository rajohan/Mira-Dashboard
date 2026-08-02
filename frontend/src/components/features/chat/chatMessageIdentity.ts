import {
    chatAttachmentIdentity,
    chatContentFingerprint,
    chatImageDownloadUrl,
    type ChatHistoryMessage,
    mergeChatAttachments,
    mergeChatImages,
    TOOL_ROLE_VARIANTS,
} from "./chatTypes";

function canonicalChatValue(value: unknown, ancestors: Set<object>): unknown {
    if (value === null) {
        return ["null"];
    }
    if (value === undefined) {
        return ["undefined"];
    }
    if (typeof value === "bigint") {
        return ["bigint", value.toString()];
    }
    if (typeof value === "number") {
        let encoded: number | string = Number.isFinite(value) ? value : String(value);
        if (Object.is(value, -0)) {
            encoded = "-0";
        }
        return ["number", encoded];
    }
    if (typeof value === "string" || typeof value === "boolean") {
        return [typeof value, value];
    }
    if (typeof value === "symbol") {
        return ["symbol", value.description ?? ""];
    }
    if (typeof value === "function") {
        return ["function", value.name || "anonymous"];
    }
    if (typeof value !== "object") {
        return [typeof value];
    }
    if (ancestors.has(value)) {
        return ["circular"];
    }

    const nestedAncestors = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        return ["array", value.map((item) => canonicalChatValue(item, nestedAncestors))];
    }
    const constructorName = value.constructor?.name || "Object";
    return [
        "object",
        constructorName,
        Object.entries(value as Record<string, unknown>)
            .toSorted(([left], [right]) => {
                if (left < right) {
                    return -1;
                }
                if (left > right) {
                    return 1;
                }
                return 0;
            })
            .map(([key, item]) => [key, canonicalChatValue(item, nestedAncestors)]),
    ];
}

/**
 * Serializes JSON-like chat payloads independently of object key order.
 * @param value Value to process.
 * @returns Serialized JSON-like chat payloads independently of object key order.
 */
export function stableChatStringify(value: unknown): string {
    return JSON.stringify(canonicalChatValue(value, new Set())) ?? "undefined";
}
/**
 * Returns a stable media identity independent of the turn carrying it.
 * @returns a stable media identity independent of the turn carrying it.
 */
export function messageMediaIdentity(message: ChatHistoryMessage): string | undefined {
    if (!message.images?.length && !message.attachments?.length) {
        return undefined;
    }

    return [
        "media",
        ...(message.images || []).map((image) => {
            const data =
                image.data || image.source?.data || chatImageDownloadUrl(image) || "";
            return [
                image.mimeType || image.source?.media_type || "image",
                chatContentFingerprint(data),
            ].join(":");
        }),
        ...(message.attachments || []).map((attachment) =>
            chatAttachmentIdentity(attachment)
        ),
    ].join("::");
}

/**
 * Returns a diagnostic identity for tool/thinking rows without primary text.
 * @returns a diagnostic identity for tool/thinking rows without primary text.
 */
export function diagnosticMessageIdentity(
    message: ChatHistoryMessage
): string | undefined {
    if (message.runtimeKey) {
        return `runtime:${message.runtimeKey}`;
    }

    const toolCalls = message.toolCalls || [];
    if (toolCalls.length > 0) {
        const fallbackScope = message.timestamp || message.runId || "unknown";
        return [
            "tool-calls",
            ...toolCalls.map((toolCall, index) =>
                [
                    toolCall.id || "no-id-" + fallbackScope + "-" + index,
                    toolCall.name,
                    stableChatStringify(toolCall.arguments ?? undefined),
                ].join("::")
            ),
        ].join("::");
    }

    if (message.toolResult) {
        const fallbackScope = message.timestamp || message.runId || "unknown";
        return [
            "tool-result",
            message.toolResult.id || "no-id-" + fallbackScope,
            message.toolResult.name || "tool",
            message.toolResult.content.trim(),
        ].join("::");
    }

    if (message.thinking?.length) {
        return ["thinking", message.thinking.map((block) => block.text).join("\n")].join(
            "::"
        );
    }

    return messageMediaIdentity(message);
}

/**
 * Returns a stable key for carrying tool results between matching tool rows.
 * @returns a stable key for carrying tool results between matching tool rows.
 */
export function toolCallRowIdentity(message: ChatHistoryMessage): string | undefined {
    if (!message.toolCalls?.length) {
        return undefined;
    }

    return [
        "tool-calls",
        message.runId || message.timestamp || message.text.trim() || "no-row",
        ...message.toolCalls.map((toolCall, index) =>
            [
                toolCall.id || `no-id-${index}`,
                toolCall.name,
                stableChatStringify(toolCall.arguments ?? undefined),
            ].join("::")
        ),
    ].join("::");
}

/**
 * Returns whether message carries non-text details beyond primary text.
 * @returns Whether message carries non-text details beyond primary text.
 */
export function hasChatMessageDetails(message: ChatHistoryMessage): boolean {
    return Boolean(
        (message.thinking?.length || 0) > 0 ||
        (message.toolCalls?.length || 0) > 0 ||
        message.toolResult ||
        (message.images?.length || 0) > 0 ||
        (message.attachments?.length || 0) > 0
    );
}

/**
 * Carries non-text message details from a richer copy onto a canonical row.
 * @returns Merge chat message details result.
 */
export function mergeChatMessageDetails(
    message: ChatHistoryMessage,
    fallback: ChatHistoryMessage
): ChatHistoryMessage {
    return {
        ...message,
        images: mergeChatImages(message.images, fallback.images),
        attachments: mergeChatAttachments(message.attachments, fallback.attachments),
        thinking: (message.thinking?.length ? message : fallback).thinking,
        toolCalls:
            message.toolCalls?.length && fallback.toolCalls?.length
                ? mergeToolCallsWithResults(message.toolCalls, fallback.toolCalls)
                : (message.toolCalls?.length ? message : fallback).toolCalls,
        toolResult: message.toolResult || fallback.toolResult,
    };
}

/**
 * Returns user text normalized to the whitespace rendered by Markdown.
 * @param text Text value.
 * @returns user text normalized to the whitespace rendered by Markdown.
 */
function userMessageTextIdentity(text: string): string {
    const lines = text
        .replaceAll(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trimEnd());
    const identityLines: string[] = [];
    let isInCodeFence = false;
    let wasBlankLine = false;

    for (const line of lines) {
        const isFenceDelimiter = /^\s*(?:```|~~~)/u.test(line);
        const isCollapsibleBlankLine = !isInCodeFence && line.length === 0;
        if (!isCollapsibleBlankLine || !wasBlankLine) {
            identityLines.push(line);
        }
        wasBlankLine = isCollapsibleBlankLine;
        if (isFenceDelimiter) {
            isInCodeFence = !isInCodeFence;
            wasBlankLine = false;
        }
    }

    return identityLines.join("\n").trim();
}

/**
 * Carries local tool results onto matching history tool calls.
 * @returns Merge tool calls with results result.
 */
export function mergeToolCallsWithResults(
    messageToolCalls: NonNullable<ChatHistoryMessage["toolCalls"]>,
    previousToolCalls: NonNullable<ChatHistoryMessage["toolCalls"]>
): NonNullable<ChatHistoryMessage["toolCalls"]> {
    const consumedPreviousIndexes = new Set<number>();

    return messageToolCalls.map((toolCall) => {
        if (toolCall.toolResult) {
            return toolCall;
        }

        const previousToolCallIndex = previousToolCalls.findIndex((candidate, index) => {
            if (consumedPreviousIndexes.has(index)) {
                return false;
            }

            if (toolCall.id || candidate.id) {
                return Boolean(
                    toolCall.id && candidate.id && toolCall.id === candidate.id
                );
            }

            return (
                toolCall.name === candidate.name &&
                stableChatStringify(toolCall.arguments ?? undefined) ===
                    stableChatStringify(candidate.arguments ?? undefined)
            );
        });

        if (previousToolCallIndex === -1) {
            return toolCall;
        }

        consumedPreviousIndexes.add(previousToolCallIndex);
        const previousToolCall = previousToolCalls[previousToolCallIndex];

        return previousToolCall?.toolResult
            ? { ...toolCall, toolResult: previousToolCall.toolResult }
            : toolCall;
    });
}
/**
 * Performs message IDentity.
 * @returns Message IDentity result.
 */
export function messageIdentity(message: ChatHistoryMessage): string {
    const role = message.role.toLowerCase();
    const controlIdentity =
        message.intent === "control"
            ? message.controlId || message.runtimeKey
            : undefined;
    if (controlIdentity) {
        return `${role}::control::${controlIdentity}`;
    }
    const diagnosticIdentity = diagnosticMessageIdentity(message);
    const mediaIdentity = messageMediaIdentity(message);
    const textIdentity =
        role === "user" ? userMessageTextIdentity(message.text) : message.text.trim();
    const userMediaTurnIdentity =
        role === "user" && !textIdentity && mediaIdentity
            ? [mediaIdentity, message.runId || message.timestamp || "no-turn"].join("::")
            : undefined;
    const assistantMediaTurnIdentity =
        role === "assistant" && !textIdentity && mediaIdentity
            ? [mediaIdentity, message.runId || message.timestamp || "no-turn"].join("::")
            : undefined;
    const isToolResultRole = TOOL_ROLE_VARIANTS.includes(role);
    const identity = isToolResultRole
        ? diagnosticIdentity || textIdentity
        : textIdentity ||
          userMediaTurnIdentity ||
          assistantMediaTurnIdentity ||
          diagnosticIdentity;
    return `${role}::${identity || ""}`;
}

/**
 * Performs message delete key.
 * @returns Message delete key result.
 */
export function messageDeleteKey(message: ChatHistoryMessage): string {
    const textIdentity = message.text.trim();
    const diagnosticIdentity = diagnosticMessageIdentity(message);
    const stableTextDiagnosticIdentity =
        message.toolCalls?.length || message.toolResult
            ? diagnosticIdentity
            : messageMediaIdentity(message);
    const contentIdentity = textIdentity
        ? [textIdentity, stableTextDiagnosticIdentity].filter(Boolean).join("::")
        : diagnosticIdentity || "no-text";
    const keyParts = [
        message.role.toLowerCase(),
        message.timestamp || "no-time",
        message.runId || "no-run",
    ];
    if (message.runtimeKey) {
        keyParts.push(message.runtimeKey);
    }
    keyParts.push(`v2:${chatContentFingerprint(contentIdentity)}`);
    return keyParts.join("::");
}

/**
 * Performs assistant text looks recovered.
 * @param left Left value.
 * @param right Right value.
 * @returns Assistant text looks recovered result.
 */
export function isRecoveredAssistantText(left: string, right: string): boolean {
    const normalizedLeft = left.trim();
    const normalizedRight = right.trim();
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    if (normalizedLeft === normalizedRight) {
        return true;
    }
    if (normalizedLeft.length < 20 || normalizedRight.length < 20) {
        return false;
    }

    return (
        normalizedLeft.includes(normalizedRight) ||
        normalizedRight.includes(normalizedLeft)
    );
}

const CHAT_TEXT_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
});

function normalizedChatTextPrefix(text: string): string {
    return text.normalize("NFKC").replaceAll(/\s+/gu, " ");
}

/**
 * Removes a semantically equivalent prefix while preserving the original remainder.
 * This tolerates Unicode normalization and collapsed whitespace from provider finals.
 * @param text Full provider text.
 * @param prefix Previously sealed assistant text.
 * @returns The untouched remainder, or undefined when the prefix does not match.
 */
export function stripEquivalentChatTextPrefix(
    text: string,
    prefix: string
): string | undefined {
    if (text.startsWith(prefix)) {
        return text.slice(prefix.length);
    }
    const normalizedPrefix = normalizedChatTextPrefix(prefix);
    if (!normalizedPrefix) {
        return undefined;
    }
    let normalizedCandidate = "";
    for (const part of CHAT_TEXT_GRAPHEME_SEGMENTER.segment(text)) {
        const normalizedPart = normalizedChatTextPrefix(part.segment);
        normalizedCandidate +=
            normalizedCandidate.endsWith(" ") && normalizedPart.startsWith(" ")
                ? normalizedPart.slice(1)
                : normalizedPart;
        if (!normalizedPrefix.startsWith(normalizedCandidate)) {
            return undefined;
        }
        if (normalizedCandidate === normalizedPrefix) {
            let end = part.index + part.segment.length;
            if (normalizedPrefix.endsWith(" ")) {
                end += text.slice(end).match(/^\s+/u)?.[0].length ?? 0;
            }
            return text.slice(end);
        }
    }
    return undefined;
}
