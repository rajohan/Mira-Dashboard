import type { ChatHistoryMessage } from "./chatTypes";

/** Defines max attachment bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Defines max attachments. */
export const MAX_ATTACHMENTS = 10;
/** Defines chat history limit. */
export const CHAT_HISTORY_LIMIT = 1000;
/** Defines optimistic message retention milliseconds. */
export const OPTIMISTIC_MESSAGE_RETENTION_MS = 120_000;

/** Represents chat model option. */
export interface ChatModelOption {
    id?: string;
    label?: string;
    name?: string;
}

/** Performs data URL to base64. */
export function dataUrlToBase64(dataUrl: string): string {
    const commaIndex = dataUrl.indexOf(",");
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

/** Performs base64 to text. */
export function base64ToText(base64: string): string {
    const binary = window.atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
}

/** Performs message IDentity. */
export function messageIdentity(message: ChatHistoryMessage): string {
    return `${message.role.toLowerCase()}::${message.text.trim()}`;
}

/** Performs message delete key. */
export function messageDeleteKey(message: ChatHistoryMessage): string {
    return [
        message.role.toLowerCase(),
        message.timestamp || "no-time",
        message.runId || "no-run",
        message.text.trim(),
    ].join("::");
}

/** Performs assistant text looks recovered. */
function assistantTextLooksRecovered(left: string, right: string): boolean {
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

/** Performs dedupe messages. */
export function dedupeMessages(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
    const seen = new Set<string>();
    const deduped: ChatHistoryMessage[] = [];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) {
            continue;
        }

        const identity = messageIdentity(message);
        if (message.text.trim() && seen.has(identity)) {
            continue;
        }

        seen.add(identity);
        deduped.unshift(message);
    }

    return deduped;
}

/** Performs message timestamp milliseconds. */
function messageTimestampMs(message: ChatHistoryMessage): number | null {
    const timestamp = message.timestamp
        ? new Date(message.timestamp).getTime()
        : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
}

/** Performs insert messages by timestamp. */
function insertMessagesByTimestamp(
    baseMessages: ChatHistoryMessage[],
    messagesToInsert: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    const merged = [...baseMessages];
    const orderedInsertions = [...messagesToInsert].sort((left, right) => {
        const leftTimestamp = messageTimestampMs(left);
        const rightTimestamp = messageTimestampMs(right);

        if (leftTimestamp === null && rightTimestamp === null) {
            return 0;
        }

        if (leftTimestamp === null) {
            return 1;
        }

        if (rightTimestamp === null) {
            return -1;
        }

        return leftTimestamp - rightTimestamp;
    });

    for (const message of orderedInsertions) {
        const timestamp = messageTimestampMs(message);

        if (timestamp === null) {
            merged.push(message);
            continue;
        }

        const insertionIndex = merged.findIndex((candidate) => {
            const candidateTimestamp = messageTimestampMs(candidate);
            return candidateTimestamp !== null && candidateTimestamp > timestamp;
        });

        if (insertionIndex === -1) {
            merged.push(message);
        } else {
            merged.splice(insertionIndex, 0, message);
        }
    }

    return merged;
}

/** Performs merge with recent optimistic messages. */
export function mergeWithRecentOptimisticMessages(
    previousMessages: ChatHistoryMessage[],
    nextMessages: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    if (previousMessages.length === 0) {
        return dedupeMessages(nextMessages);
    }

    if (nextMessages.length === 0) {
        return previousMessages;
    }

    const nextIdentities = new Set(nextMessages.map(messageIdentity));
    const nextAssistantTexts = nextMessages
        .filter((message) => message.role.toLowerCase() === "assistant")
        .map((message) => message.text);
    const now = Date.now();
    const recentMissingMessages = previousMessages.filter((message) => {
        const role = message.role.toLowerCase();
        const isOptimisticRole = role === "user" || role === "assistant";
        const isLocalUiMessage = message.local === true || role === "system";

        if (!isOptimisticRole && !isLocalUiMessage) {
            return false;
        }

        if (!message.text.trim()) {
            return false;
        }

        if (nextIdentities.has(messageIdentity(message))) {
            return false;
        }

        if (
            role === "assistant" &&
            nextAssistantTexts.some((nextText) =>
                assistantTextLooksRecovered(message.text, nextText)
            )
        ) {
            return false;
        }

        if (isLocalUiMessage) {
            return true;
        }

        const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : 0;
        return (
            Number.isFinite(timestamp) &&
            now - timestamp < OPTIMISTIC_MESSAGE_RETENTION_MS
        );
    });

    return dedupeMessages(insertMessagesByTimestamp(nextMessages, recentMissingMessages));
}

/** Performs read file as data URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
                return;
            }

            reject(new Error(`Could not read ${file.name}`));
        });
        reader.addEventListener("error", () =>
            reject(reader.error || new Error(`Could not read ${file.name}`))
        );
        reader.readAsDataURL(file);
    });
}

/** Performs display mime type. */
export function displayMimeType(file: File): string {
    return file.type || "application/octet-stream";
}
