import type { Session } from "../../../types/session";
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

export function isResetSlashCommand(text: string): boolean {
    return /^\/(?:new|reset)(?:\s|$)/iu.test(text);
}

export function readDeletedMessageKeys(sessionKey: string): Set<string> {
    if (!sessionKey || typeof window === "undefined") {
        return new Set();
    }
    try {
        const raw = localStorage.getItem(deletedMessagesStorageKey(sessionKey));
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return new Set(
            Array.isArray(parsed)
                ? parsed.filter((value): value is string => typeof value === "string")
                : []
        );
    } catch {
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
        localStorage.setItem(
            deletedMessagesStorageKey(sessionKey),
            JSON.stringify([...keys])
        );
    } catch {
        // Keep the in-memory deleted state if browser storage is unavailable.
    }
}

export function readStoredChatDiagnosticVisibility(): StoredChatDiagnosticVisibility {
    if (typeof window === "undefined") {
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

export function isSessionActive(session: Session | undefined): boolean {
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
    // eslint-disable-next-line unicorn/no-null
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
