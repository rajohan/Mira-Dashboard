import type { CanonicalChatThinking, CanonicalChatToolCall } from "./canonical";
import {
    boundCanonicalChatToolValue,
    MAX_CANONICAL_CHAT_TEXT_CHARACTERS,
    truncateCanonicalChatText,
} from "./canonicalUtilities";

const MAX_CANONICAL_CHAT_THINKING_BLOCKS = 100;
const MAX_CANONICAL_CHAT_TEXT_BLOCKS = 1000;
const MAX_CANONICAL_CHAT_TOOL_CALLS = 100;
const CANONICAL_CHAT_TEXT_BLOCK_LIMIT_MARKER =
    "… [additional content omitted by Dashboard]";

/**
 * Extracts thinking blocks from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical thinking blocks.
 */
export function extractCanonicalChatThinking(content: unknown): CanonicalChatThinking[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const blocks: CanonicalChatThinking[] = [];
    for (const item of content) {
        if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            (item as { type?: unknown }).type !== "thinking"
        ) {
            continue;
        }
        const record = item as Record<string, unknown>;
        let text = typeof record.text === "string" ? record.text : "";
        if (typeof record.thinking === "string") {
            text = record.thinking;
        }
        if (text.trim()) {
            blocks.push({ text: truncateCanonicalChatText(text, 256 * 1024) });
        }
        if (blocks.length >= MAX_CANONICAL_CHAT_THINKING_BLOCKS) {
            break;
        }
    }
    return blocks;
}

/**
 * Extracts tool calls from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical tool calls.
 */
export function extractCanonicalChatToolCalls(content: unknown): CanonicalChatToolCall[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const calls: CanonicalChatToolCall[] = [];
    for (const item of content) {
        if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            (item as { type?: unknown }).type !== "toolCall"
        ) {
            continue;
        }
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const name = typeof record.name === "string" ? record.name.trim() : "";
        calls.push({
            arguments: boundCanonicalChatToolValue(record.arguments),
            id: id || undefined,
            name: name || "tool",
        });
        if (calls.length >= MAX_CANONICAL_CHAT_TOOL_CALLS) {
            break;
        }
    }
    return calls;
}

function canonicalChatTextBlock(item: unknown): string {
    if (typeof item === "string") {
        return item;
    }
    if (!item || typeof item !== "object") {
        return "";
    }
    const block = item as Record<string, unknown>;
    if (typeof block.text === "string") {
        return block.text;
    }
    return ["image", "image_url", "input_image"].includes(String(block.type))
        ? "[image]"
        : "";
}

/**
 * Normalizes text from OpenClaw string and content-block variants.
 * @param content Provider content.
 * @returns Normalized text.
 */
export function normalizeCanonicalChatText(content: unknown): string {
    if (typeof content === "string") {
        return truncateCanonicalChatText(content, MAX_CANONICAL_CHAT_TEXT_CHARACTERS);
    }
    if (Array.isArray(content)) {
        const items = content as unknown[];
        const blocks: string[] = [];
        let retainedCharacters = 0;
        const blockCount = Math.min(items.length, MAX_CANONICAL_CHAT_TEXT_BLOCKS);
        for (let index = 0; index < blockCount; index += 1) {
            const blockText = canonicalChatTextBlock(items[index]);
            if (!blockText) {
                continue;
            }
            const separator = blocks.length > 0 ? "\n\n" : "";
            const remainingCharacters =
                MAX_CANONICAL_CHAT_TEXT_CHARACTERS -
                retainedCharacters -
                separator.length;
            if (blockText.length > remainingCharacters) {
                const retained = blocks.join("\n\n");
                const boundedCandidate = `${retained}${separator}${blockText.slice(
                    0,
                    Math.max(0, remainingCharacters + 1)
                )}`;
                return truncateCanonicalChatText(
                    boundedCandidate,
                    MAX_CANONICAL_CHAT_TEXT_CHARACTERS
                );
            }
            blocks.push(blockText);
            retainedCharacters += separator.length + blockText.length;
        }
        const retained = blocks.join("\n\n");
        if (items.length > MAX_CANONICAL_CHAT_TEXT_BLOCKS) {
            return truncateCanonicalChatText(
                `${retained}${retained ? "\n\n" : ""}${CANONICAL_CHAT_TEXT_BLOCK_LIMIT_MARKER}`,
                MAX_CANONICAL_CHAT_TEXT_CHARACTERS
            );
        }
        return retained;
    }
    if (content && typeof content === "object") {
        const maybe = content as Record<string, unknown>;
        return typeof maybe.text === "string"
            ? truncateCanonicalChatText(maybe.text, MAX_CANONICAL_CHAT_TEXT_CHARACTERS)
            : "";
    }
    return "";
}
