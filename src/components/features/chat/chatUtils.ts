import type { ChatHistoryMessage } from "./chatTypes";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const CHAT_HISTORY_LIMIT = 1000;
export const OPTIMISTIC_MESSAGE_RETENTION_MS = 120_000;
export const ACTIVE_RUN_MARKER_TTL_MS = 2 * 60 * 60 * 1000;

export interface ChatModelOption {
    id?: string;
    label?: string;
    name?: string;
}

export function dataUrlToBase64(dataUrl: string): string {
    const commaIndex = dataUrl.indexOf(",");
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

export function base64ToText(base64: string): string {
    const binary = window.atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
}

export function messageIdentity(message: ChatHistoryMessage): string {
    return `${message.role.toLowerCase()}::${message.text.trim()}`;
}

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

        if (isLocalUiMessage) {
            return true;
        }

        const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : 0;
        return (
            Number.isFinite(timestamp) &&
            now - timestamp < OPTIMISTIC_MESSAGE_RETENTION_MS
        );
    });

    return dedupeMessages([...nextMessages, ...recentMissingMessages]);
}

export function activeRunStorageKey(sessionKey: string): string {
    return `mira-dashboard-chat-active-run:${sessionKey}`;
}

export function hasActiveRunMarker(sessionKey: string): boolean {
    const key = activeRunStorageKey(sessionKey);
    const raw = window.localStorage.getItem(key) || window.sessionStorage.getItem(key);

    if (!raw) {
        return false;
    }

    try {
        const parsed = JSON.parse(raw) as { startedAt?: string };
        const startedAt = parsed.startedAt ? new Date(parsed.startedAt).getTime() : 0;
        if (
            Number.isFinite(startedAt) &&
            Date.now() - startedAt < ACTIVE_RUN_MARKER_TTL_MS
        ) {
            return true;
        }
    } catch {
        // Legacy marker format; clear it below.
    }

    clearActiveRunMarker(sessionKey);
    return false;
}

export function markActiveRun(sessionKey: string): void {
    window.localStorage.setItem(
        activeRunStorageKey(sessionKey),
        JSON.stringify({ startedAt: new Date().toISOString() })
    );
}

export function clearActiveRunMarker(sessionKey: string): void {
    window.localStorage.removeItem(activeRunStorageKey(sessionKey));
    window.sessionStorage.removeItem(activeRunStorageKey(sessionKey));
}

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

export function displayMimeType(file: File): string {
    return file.type || "application/octet-stream";
}
