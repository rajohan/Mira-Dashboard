import { getCacheEntry, parseJsonField } from "../../lib/cacheStore.ts";

export const LOG_ROTATION_STATE_KEY = "log_rotation.state";

interface LogRotationFileState {
    lastRotatedAt?: string;
    lastSizeBytes?: number;
    lastArchive?: string;
}

export interface LogRotationState {
    version: number;
    files: Record<string, LogRotationFileState>;
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

function normalizeLogRotationFileState(value: unknown): LogRotationFileState | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
        record.lastRotatedAt !== undefined &&
        (typeof record.lastRotatedAt !== "string" ||
            !Number.isFinite(Date.parse(record.lastRotatedAt)))
    ) {
        return undefined;
    }
    if (
        record.lastSizeBytes !== undefined &&
        (typeof record.lastSizeBytes !== "number" ||
            !Number.isFinite(record.lastSizeBytes) ||
            record.lastSizeBytes < 0)
    ) {
        return undefined;
    }
    if (
        record.lastArchive !== undefined &&
        (typeof record.lastArchive !== "string" || record.lastArchive.trim().length === 0)
    ) {
        return undefined;
    }
    return {
        ...(typeof record.lastRotatedAt === "string" && {
            lastRotatedAt: record.lastRotatedAt,
        }),
        ...(typeof record.lastSizeBytes === "number" && {
            lastSizeBytes: record.lastSizeBytes,
        }),
        ...(typeof record.lastArchive === "string" && {
            lastArchive: record.lastArchive,
        }),
    };
}

function normalizeLogRotationFiles(value: unknown): LogRotationState["files"] {
    const files: LogRotationState["files"] = {};
    for (const [filePath, fileState] of Object.entries(asRecord(value))) {
        const normalized = normalizeLogRotationFileState(fileState);
        if (normalized) {
            files[filePath] = normalized;
        }
    }
    return files;
}

export function normalizeLogRotationState(value: unknown): LogRotationState {
    const parsed = asRecord(value);
    const lastRun = asRecord(parsed.lastRun);
    return {
        version: 1,
        files: normalizeLogRotationFiles(parsed.files),
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
