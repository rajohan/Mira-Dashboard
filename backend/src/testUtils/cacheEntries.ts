import { db } from "../db.js";

interface SeedCacheEntryOptions {
    key: string;
    data: unknown;
    source: string;
    updatedAt?: string;
    lastAttemptAt?: string;
    expiresAt?: string;
    status?: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    consecutiveFailures?: number;
    metadata?: Record<string, unknown>;
}

export function seedCacheEntry(options: SeedCacheEntryOptions): void {
    const updatedAt = options.updatedAt ?? "2026-05-11T00:00:00.000Z";
    db.prepare(
        `INSERT OR REPLACE INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at,
            status, error_code, error_message, consecutive_failures, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        options.key,
        typeof options.data === "string" ? options.data : JSON.stringify(options.data),
        options.source,
        updatedAt,
        options.lastAttemptAt ?? updatedAt,
        options.expiresAt ?? "2099-05-11T01:00:00.000Z",
        options.status ?? "fresh",
        options.errorCode ?? null,
        options.errorMessage ?? null,
        options.consecutiveFailures ?? 0,
        JSON.stringify(options.metadata ?? {})
    );
}

export function clearCacheEntries(): void {
    db.exec("DELETE FROM cache_entries;");
}
