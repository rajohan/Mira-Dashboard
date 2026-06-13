import { db } from "../db.js";

interface CacheFixtureOptions {
    consecutiveFailures?: number;
    data: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    expiresAt?: string;
    key: string;
    lastAttemptAt?: string;
    meta?: unknown;
    source?: string;
    status?: string;
    updatedAt?: string | null;
}

export function clearCacheEntries(): void {
    db.prepare("DELETE FROM cache_entries").run();
}

export function insertCacheEntry(options: CacheFixtureOptions): void {
    db.prepare(
        `INSERT INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at, status,
            error_code, error_message, consecutive_failures, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            data_json = excluded.data_json,
            source = excluded.source,
            updated_at = excluded.updated_at,
            last_attempt_at = excluded.last_attempt_at,
            expires_at = excluded.expires_at,
            status = excluded.status,
            error_code = excluded.error_code,
            error_message = excluded.error_message,
            consecutive_failures = excluded.consecutive_failures,
            metadata_json = excluded.metadata_json`
    ).run(
        options.key,
        typeof options.data === "string" ? options.data : JSON.stringify(options.data),
        options.source ?? "backend",
        options.updatedAt === undefined ? "2026-05-11T00:00:00.000Z" : options.updatedAt,
        options.lastAttemptAt ?? "2026-05-11T00:00:00.000Z",
        options.expiresAt ?? "2099-05-11T01:00:00.000Z",
        options.status ?? "fresh",
        options.errorCode ?? null,
        options.errorMessage ?? null,
        options.consecutiveFailures ?? 0,
        typeof options.meta === "string"
            ? options.meta
            : JSON.stringify(options.meta ?? {})
    );
}
