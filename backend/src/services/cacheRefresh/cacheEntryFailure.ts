import { database } from "../../database.ts";
import type { CacheTtlUnit } from "../cacheEntryWriter.ts";
import { cacheExpiryIso } from "../cacheEntryWriter.ts";
import { errorMessage, nowIso } from "./cacheProducerSupport.ts";

export interface CacheFailureOptions {
    key: string;
    source: string;
    ttl: number;
    ttlUnit: CacheTtlUnit;
    error: unknown;
    metadata: Record<string, unknown>;
}

export function writeCacheFailure(options: CacheFailureOptions): void {
    const timestamp = nowIso();
    database
        .prepare(
            `INSERT INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at,
            status, error_code, error_message, consecutive_failures, metadata_json
         ) VALUES (?, NULL, ?, NULL, ?, ?, 'error', 'check_failed', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at,
            expires_at = excluded.expires_at,
            status = 'error',
            error_code = excluded.error_code,
            error_message = excluded.error_message,
            consecutive_failures = COALESCE(cache_entries.consecutive_failures, 0) + 1,
            metadata_json = excluded.metadata_json`
        )
        .run(
            options.key,
            options.source,
            timestamp,
            cacheExpiryIso(options.ttl, options.ttlUnit),
            errorMessage(options.error),
            1,
            JSON.stringify({ ...options.metadata, lastFailureAt: timestamp })
        );
}
