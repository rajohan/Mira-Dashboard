import { getCacheEntry, parseJsonField } from "../../lib/cacheStore.ts";

export const LOG_ROTATION_STATE_KEY = "log_rotation.state";

export interface LogRotationState {
    version: number;
    files: Record<
        string,
        { lastRotatedAt?: string; lastSizeBytes?: number; lastArchive?: string }
    >;
    lastRun?: Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

export function dateToISOString(date: Date): string {
    return date.toISOString();
}

export function emptyLogRotationState(): LogRotationState {
    return { version: 1, files: {} };
}

export function normalizeLogRotationState(value: unknown): LogRotationState {
    const parsed = asRecord(value);
    const files = asRecord(parsed.files) as LogRotationState["files"];
    const lastRun = asRecord(parsed.lastRun);
    return {
        version: 1,
        files,
        ...(Object.keys(lastRun).length > 0 && { lastRun }),
    };
}

export function readLogRotationState(): LogRotationState {
    const data = getCacheEntry(LOG_ROTATION_STATE_KEY)?.data;
    if (!data) {
        return emptyLogRotationState();
    }
    const parsed = parseJsonField<unknown>(data);
    return parsed === undefined
        ? emptyLogRotationState()
        : normalizeLogRotationState(parsed);
}
