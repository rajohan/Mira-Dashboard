import type { ChatDisplaySettings } from "./chatTypes.ts";

const diagnosticVisibilityStorageKey = "mira-dashboard-chat-diagnostic-visibility";
const deletedMessageStoragePrefix = "openclaw:deleted:";
const displaySettingsMaximumStorageCodeUnits = 4096;
const hiddenMessageIdsMaximumStorageCodeUnits = 64 * 1024;
const hiddenMessageIdsMaximumCount = 512;
const opaqueMessageIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export const defaultChatDisplaySettings: ChatDisplaySettings = Object.freeze({
    keepThinkingAfterFinal: false,
    showThinking: false,
    showTools: false,
    toolsExpanded: false,
});

interface StoredDiagnosticVisibility {
    readonly keepThinkingAfterFinal: boolean;
    readonly thinking: boolean;
    readonly toolDetailsExpanded: boolean;
    readonly tools: boolean;
}

function storage(): Storage | undefined {
    try {
        return globalThis.window?.localStorage;
    } catch {
        return undefined;
    }
}

function removeStoredValue(key: string): void {
    try {
        storage()?.removeItem(key);
    } catch {
        // Browser storage is optional; safe in-memory defaults remain authoritative.
    }
}

function isStoredDiagnosticVisibility(
    value: unknown
): value is StoredDiagnosticVisibility {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Readonly<Record<string, unknown>>;
    return (
        Object.keys(record).length === 4 &&
        typeof record.keepThinkingAfterFinal === "boolean" &&
        typeof record.thinking === "boolean" &&
        typeof record.toolDetailsExpanded === "boolean" &&
        typeof record.tools === "boolean"
    );
}

/**
 * Reads the legacy-compatible, global diagnostic-visibility preference safely.
 * @returns Sanitized private-by-default chat display settings.
 */
export function readChatDisplaySettings(): ChatDisplaySettings {
    const browserStorage = storage();
    if (browserStorage === undefined) return defaultChatDisplaySettings;
    try {
        const raw = browserStorage.getItem(diagnosticVisibilityStorageKey);
        if (raw === null) return defaultChatDisplaySettings;
        if (raw.length > displaySettingsMaximumStorageCodeUnits) {
            removeStoredValue(diagnosticVisibilityStorageKey);
            return defaultChatDisplaySettings;
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isStoredDiagnosticVisibility(parsed)) {
            removeStoredValue(diagnosticVisibilityStorageKey);
            return defaultChatDisplaySettings;
        }
        return Object.freeze({
            keepThinkingAfterFinal: parsed.keepThinkingAfterFinal,
            showThinking: parsed.thinking,
            showTools: parsed.tools,
            toolsExpanded: parsed.toolDetailsExpanded,
        });
    } catch {
        removeStoredValue(diagnosticVisibilityStorageKey);
        return defaultChatDisplaySettings;
    }
}

/** Persists only the four global visibility booleans; no chat content is stored. */
export function writeChatDisplaySettings(settings: ChatDisplaySettings): void {
    const stored: StoredDiagnosticVisibility = {
        keepThinkingAfterFinal: settings.keepThinkingAfterFinal,
        thinking: settings.showThinking,
        toolDetailsExpanded: settings.toolsExpanded,
        tools: settings.showTools,
    };
    try {
        storage()?.setItem(diagnosticVisibilityStorageKey, JSON.stringify(stored));
    } catch {
        // Keep the current in-memory preference when browser storage is unavailable.
    }
}

function deletedMessageStorageKey(sessionKey: string): string {
    return `${deletedMessageStoragePrefix}${sessionKey}`;
}

function canonicalHiddenMessageIds(values: readonly unknown[]): readonly string[] {
    const unique = new Set(
        values.filter(
            (value): value is string =>
                typeof value === "string" && opaqueMessageIdPattern.test(value)
        )
    );
    return [...unique].slice(-hiddenMessageIdsMaximumCount);
}

/**
 * Reads one bounded per-session set of opaque locally hidden message identities.
 * @param sessionKey The exact provider session key.
 * @returns The sanitized locally hidden message identities.
 */
export function readHiddenMessageIds(sessionKey: string): ReadonlySet<string> {
    if (sessionKey === "") return new Set();
    const key = deletedMessageStorageKey(sessionKey);
    const browserStorage = storage();
    if (browserStorage === undefined) return new Set();
    try {
        const raw = browserStorage.getItem(key);
        if (raw === null) return new Set();
        if (raw.length > hiddenMessageIdsMaximumStorageCodeUnits) {
            removeStoredValue(key);
            return new Set();
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            removeStoredValue(key);
            return new Set();
        }
        const canonical = canonicalHiddenMessageIds(parsed);
        const serialized = JSON.stringify(canonical);
        if (serialized !== raw) browserStorage.setItem(key, serialized);
        return new Set(canonical);
    } catch {
        removeStoredValue(key);
        return new Set();
    }
}

/**
 * Hides one identity in memory and persists only opaque values for the session.
 * @param sessionKey The exact provider session key.
 * @param current The current in-memory hidden identity set.
 * @param messageId The opaque identity to hide locally.
 * @returns The updated bounded in-memory identity set.
 */
export function addHiddenMessageId(
    sessionKey: string,
    current: ReadonlySet<string>,
    messageId: string
): ReadonlySet<string> {
    if (sessionKey === "") return current;
    const inMemory = [...new Set([...current, messageId])].slice(
        -hiddenMessageIdsMaximumCount
    );
    const persisted = canonicalHiddenMessageIds(inMemory);
    try {
        storage()?.setItem(
            deletedMessageStorageKey(sessionKey),
            JSON.stringify(persisted)
        );
    } catch {
        // The bounded in-memory set remains useful when persistence is unavailable.
    }
    return new Set(inMemory);
}
