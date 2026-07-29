import { database } from "../database.ts";

/** Represents one cache entry row. */
export interface CacheEntryRow {
    key: string;
    data: string;
    source: string;
    updated_at: string | undefined;
    last_attempt_at: string;
    expires_at: string;
    status: string;
    error_code: string | undefined;
    error_message: string | undefined;
    consecutive_failures: string;
    meta: string;
}

interface SqliteCacheEntryRow {
    key: string;
    data_json: string | undefined;
    source: string;
    updated_at: string | null | undefined;
    last_attempt_at: string;
    expires_at: string;
    status: string;
    error_code: string | null | undefined;
    error_message: string | null | undefined;
    consecutive_failures: number;
    metadata_json: string;
}

/**
 * Parses JSON field.
 * @param value Value to process.
 * @returns Parsed JSON field.
 */
export function parseJsonField<T>(value: string): T | undefined {
    if (!value) {
        return undefined;
    }

    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

export function parseTable<T extends object>(output: string): T[] {
    const lines = output.trimEnd().split("\n");
    if (lines.length < 2 || !lines[0]) {
        return [];
    }

    const headers = lines[0].split("\t");
    return lines
        .slice(1)
        .filter((line) => line.trim() !== "")
        .map((line) => {
            const columns = line.split("\t");
            return Object.fromEntries(
                headers.map((header, index) => [header, columns[index] ?? ""])
            ) as T;
        });
}

function mapCacheEntry(row: SqliteCacheEntryRow | undefined): CacheEntryRow | undefined {
    if (!row) {
        return undefined;
    }
    const expiresAtMs = row.expires_at === "" ? Number.NaN : Date.parse(row.expires_at);
    const isExpired =
        row.status === "fresh" &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs <= Date.now();

    return {
        key: row.key,
        data: row.data_json ?? "",
        source: row.source,
        updated_at: row.updated_at ?? undefined,
        last_attempt_at: row.last_attempt_at,
        expires_at: row.expires_at,
        status: isExpired ? "stale" : row.status,
        error_code: row.error_code ?? undefined,
        error_message: row.error_message ?? undefined,
        consecutive_failures: String(row.consecutive_failures),
        meta: row.metadata_json,
    };
}

/**
 * Returns cache entry.
 * @param key Lookup key.
 * @returns cache entry.
 */
export function getCacheEntry(key: string): CacheEntryRow | undefined {
    const row = database
        .prepare(
            `SELECT
                key,
                data_json,
                source,
                updated_at,
                last_attempt_at,
                expires_at,
                status,
                error_code,
                error_message,
                consecutive_failures,
                metadata_json
             FROM cache_entries
             WHERE key = ?
             LIMIT 1`
        )
        .get(key) as SqliteCacheEntryRow | undefined;

    return mapCacheEntry(row);
}

/**
 * Marks a cache entry stale without discarding its last successful payload.
 * @param key Lookup key.
 * @param now Now value.
 */
export function invalidateCacheEntry(key: string, now = new Date()): void {
    database
        .prepare("UPDATE cache_entries SET expires_at = ? WHERE key = ?")
        .run(now.toISOString(), key);
}

/**
 * Returns all cache entries.
 * @returns all cache entries.
 */
export function getAllCacheEntries(): CacheEntryRow[] {
    const rows = database
        .prepare(
            `SELECT
                key,
                data_json,
                source,
                updated_at,
                last_attempt_at,
                expires_at,
                status,
                error_code,
                error_message,
                consecutive_failures,
                metadata_json
             FROM cache_entries
             ORDER BY key ASC`
        )
        .all() as unknown as SqliteCacheEntryRow[];

    return rows
        .map((row) => mapCacheEntry(row))
        .filter((row): row is CacheEntryRow => row !== undefined);
}

/**
 * Returns all cache entries without loading payload data.
 * @returns all cache entries without loading payload data.
 */
export function getCacheStatusEntries(): CacheEntryRow[] {
    const rows = database
        .prepare(
            `SELECT
                key,
                '' AS data_json,
                source,
                updated_at,
                last_attempt_at,
                expires_at,
                status,
                error_code,
                error_message,
                consecutive_failures,
                metadata_json
             FROM cache_entries
             ORDER BY key ASC`
        )
        .all() as unknown as SqliteCacheEntryRow[];

    return rows
        .map((row) => mapCacheEntry(row))
        .filter((row): row is CacheEntryRow => row !== undefined);
}
