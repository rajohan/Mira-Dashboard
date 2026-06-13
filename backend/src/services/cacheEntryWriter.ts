import { db } from "../db.js";

type CacheTtlUnit = "hours" | "minutes";

export interface CacheWriteOptions {
    key: string;
    data: unknown;
    source: string;
    ttl: number;
    ttlUnit: CacheTtlUnit;
    metadata: Record<string, unknown>;
}

function nowIso(): string {
    return new Date().toISOString();
}

function ttlDate(ttl: number, unit: CacheTtlUnit): string {
    const multiplier = unit === "hours" ? 60 * 60 * 1000 : 60 * 1000;
    return new Date(Date.now() + ttl * multiplier).toISOString();
}

export function writeCacheSuccess(options: CacheWriteOptions): void {
    const timestamp = nowIso();
    db.prepare(
        `INSERT INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at,
            status, error_code, error_message, consecutive_failures, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, 'fresh', NULL, NULL, 0, ?)
         ON CONFLICT(key) DO UPDATE SET
            data_json = excluded.data_json,
            source = excluded.source,
            updated_at = excluded.updated_at,
            last_attempt_at = excluded.last_attempt_at,
            expires_at = excluded.expires_at,
            status = 'fresh',
            error_code = NULL,
            error_message = NULL,
            consecutive_failures = 0,
            metadata_json = excluded.metadata_json`
    ).run(
        options.key,
        JSON.stringify(options.data),
        options.source,
        timestamp,
        timestamp,
        ttlDate(options.ttl, options.ttlUnit),
        JSON.stringify(options.metadata)
    );
}
