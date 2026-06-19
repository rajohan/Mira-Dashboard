import { db } from "../db.js";

/** Represents one cache entry row. */
export interface CacheEntryRow {
    key: string;
    data: string;
    source: string;
    updated_at: string | null;
    last_attempt_at: string;
    expires_at: string;
    status: string;
    error_code: string;
    error_message: string;
    consecutive_failures: string;
    meta: string;
}

interface SqliteCacheEntryRow {
    key: string;
    data_json: string | null;
    source: string;
    updated_at: string | null;
    last_attempt_at: string;
    expires_at: string;
    status: string;
    error_code: string | null;
    error_message: string | null;
    consecutive_failures: number;
    metadata_json: string;
}

/** Parses JSON field. */
export function parseJsonField<T>(value: string): T | null {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
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

function mapCacheEntry(row: SqliteCacheEntryRow | undefined): CacheEntryRow | null {
    if (!row) {
        return null;
    }
    const expiresAtMs = row.expires_at === "" ? NaN : Date.parse(row.expires_at);
    const expired =
        row.status === "fresh" &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs <= Date.now();

    return {
        key: row.key,
        data: row.data_json ?? "",
        source: row.source,
        updated_at: row.updated_at,
        last_attempt_at: row.last_attempt_at,
        expires_at: row.expires_at,
        status: expired ? "stale" : row.status,
        error_code: row.error_code ?? "",
        error_message: row.error_message ?? "",
        consecutive_failures: String(row.consecutive_failures),
        meta: row.metadata_json,
    };
}

/** Returns cache entry. */
export async function getCacheEntry(key: string): Promise<CacheEntryRow | null> {
    const row = db
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

/** Returns all cache entries. */
export async function getAllCacheEntries(): Promise<CacheEntryRow[]> {
    const rows = db
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
        .filter((row): row is CacheEntryRow => row !== null);
}
