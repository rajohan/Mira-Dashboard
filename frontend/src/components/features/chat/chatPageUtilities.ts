import type { Session } from "../../../../../contracts/sessions";
import { timestampFromDateString } from "../../../utils/date";
import type { ChatHistoryMessage } from "./chatTypes";
import { mergeWithRecentOptimisticMessages } from "./chatUtilities";

const CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY =
    "mira-dashboard-chat-diagnostic-visibility";

export interface StoredChatDiagnosticVisibility {
    keepThinkingAfterFinal: boolean;
    thinking: boolean;
    toolDetailsExpanded: boolean;
    tools: boolean;
}

const DEFAULT_CHAT_DIAGNOSTIC_VISIBILITY: StoredChatDiagnosticVisibility = {
    keepThinkingAfterFinal: false,
    thinking: false,
    toolDetailsExpanded: false,
    tools: false,
};

function deletedMessagesStorageKey(sessionKey: string): string {
    return `openclaw:deleted:${sessionKey}`;
}

function isOpaqueDeletedMessageKey(value: string): boolean {
    return (
        /::v2:\d+:[0-9a-z]+:[0-9a-z]+$/u.test(value) ||
        /^chat-user-recovery:v1:(?:no-time|time-\d+):\d+:[0-9a-z]+:[0-9a-z]+$/u.test(
            value
        ) ||
        /^chat-row-occurrence:v1:\d+:\d+:\d+:[0-9a-z]+:[0-9a-z]+$/u.test(value)
    );
}

export function isResetSlashCommand(text: string): boolean {
    return /^\/(?:new|reset)(?:\s|$)/iu.test(text);
}

export function readDeletedMessageKeys(sessionKey: string): Set<string> {
    if (!sessionKey || globalThis.window === undefined) {
        return new Set();
    }
    try {
        const storageKey = deletedMessagesStorageKey(sessionKey);
        const raw = localStorage.getItem(storageKey);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        if (!Array.isArray(parsed)) {
            localStorage.setItem(storageKey, "[]");
            return new Set();
        }
        const opaqueKeys = parsed.filter(
            (value): value is string =>
                typeof value === "string" && isOpaqueDeletedMessageKey(value)
        );
        if (opaqueKeys.length !== parsed.length) {
            localStorage.setItem(storageKey, JSON.stringify(opaqueKeys));
        }
        return new Set(opaqueKeys);
    } catch {
        try {
            localStorage.removeItem(deletedMessagesStorageKey(sessionKey));
        } catch {
            // Browser storage is unavailable; there is no persisted value to sanitize.
        }
        return new Set();
    }
}

export function addDeletedMessageKeys(
    previous: ReadonlySet<string>,
    keys: readonly string[]
): Set<string> {
    const next = new Set(previous);
    for (const key of keys) {
        if (key) {
            next.add(key);
        }
    }
    return next;
}

export function writeDeletedMessageKeys(
    sessionKey: string,
    keys: ReadonlySet<string>
): void {
    if (!sessionKey) {
        return;
    }
    try {
        const opaqueKeys = [...keys].filter((key) => isOpaqueDeletedMessageKey(key));
        localStorage.setItem(
            deletedMessagesStorageKey(sessionKey),
            JSON.stringify(opaqueKeys)
        );
    } catch {
        // Keep the in-memory deleted state if browser storage is unavailable.
    }
}

export function readStoredChatDiagnosticVisibility(): StoredChatDiagnosticVisibility {
    if (globalThis.window === undefined) {
        return DEFAULT_CHAT_DIAGNOSTIC_VISIBILITY;
    }
    try {
        const raw = localStorage.getItem(CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY);
        if (!raw) {
            return DEFAULT_CHAT_DIAGNOSTIC_VISIBILITY;
        }
        const parsed = JSON.parse(raw) as Partial<StoredChatDiagnosticVisibility>;
        return {
            keepThinkingAfterFinal: parsed.keepThinkingAfterFinal === true,
            thinking: parsed.thinking === true,
            toolDetailsExpanded: parsed.toolDetailsExpanded === true,
            tools: parsed.tools === true,
        };
    } catch {
        return DEFAULT_CHAT_DIAGNOSTIC_VISIBILITY;
    }
}

export function writeStoredChatDiagnosticVisibility(
    visibility: StoredChatDiagnosticVisibility
): void {
    try {
        localStorage.setItem(
            CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY,
            JSON.stringify(visibility)
        );
    } catch {
        // Keep the in-memory toggle state if browser storage is unavailable.
    }
}

export function sessionTimestampMs(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return typeof value === "string" ? timestampFromDateString(value) : undefined;
}

export function isSessionActive(session?: Session): boolean {
    if (!session || sessionTimestampMs(session.endedAt) !== undefined) {
        return false;
    }
    return Boolean(
        session.isRunning ||
        session.running ||
        session.status?.toLowerCase() === "running" ||
        session.hasActiveRun ||
        session.activeRunId ||
        session.currentRunId
    );
}

export function nextRefreshedChatMessages(
    previousMessages: ChatHistoryMessage[],
    nextMessages: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    return mergeWithRecentOptimisticMessages(previousMessages, nextMessages);
}

export function shouldStayAtHistoryBottom(
    wasAtBottom: boolean,
    isNewSession: boolean,
    shouldStickToBottom: boolean
): boolean {
    return isNewSession || shouldStickToBottom ? true : wasAtBottom;
}

export function nextHistoryLoadSendError(
    previousError: string | undefined,
    wasCancelled: boolean,
    historyLoadError: string
): string | undefined {
    return wasCancelled ? previousError : historyLoadError;
}

export function didScheduleBottomFollow(
    shouldStickToBottom: boolean,
    scheduleBottomFollow: () => void
): boolean {
    if (!shouldStickToBottom) {
        return false;
    }
    scheduleBottomFollow();
    return true;
}

export function chatFastModePatchValue(speed: string): boolean | "auto" | null {
    if (speed === "auto") return "auto";
    if (speed === "on") return true;
    if (speed === "off") return false;
    // Gateway uses null to clear an inherited override.
    return null;
}

export function supportedAudioRecordingMimeType(): string | undefined {
    if (typeof MediaRecorder === "undefined") {
        return undefined;
    }
    return [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
        "audio/ogg;codecs=opus",
    ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}
