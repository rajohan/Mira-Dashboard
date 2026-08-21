import type { ChatDisplaySettings } from "./chatTypes.ts";

const diagnosticVisibilityStorageKey = "mira-dashboard-chat-diagnostic-visibility";
const displaySettingsMaximumStorageCodeUnits = 4096;

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
