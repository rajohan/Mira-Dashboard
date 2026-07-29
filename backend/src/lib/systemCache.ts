import {
    parseSystemHostSummary,
    type SystemHostSummary,
} from "../../../contracts/system.ts";
import { getCacheEntry, parseJsonField } from "./cacheStore.ts";

/** Represents the cached system host API response. */
export interface CachedSystemHostResponse {
    source: string;
    status: string;
    updatedAt: string | undefined;
    expiresAt: string | undefined;
    errorCode: string | undefined;
    errorMessage: string | undefined;
    consecutiveFailures: number;
    data: SystemHostSummary;
    meta: Record<string, unknown>;
}

/**
 * Fetches cached system host.
 * @returns Fetch cached system host result.
 */
export function fetchCachedSystemHost(): CachedSystemHostResponse {
    const row = getCacheEntry("system.host");
    if (!row || row.status !== "fresh") {
        throw new Error("System host cache entry not found or not fresh");
    }

    const parsedData = parseJsonField<unknown>(row.data);
    if (!parsedData) {
        throw new Error("System host cache payload is invalid");
    }
    const data = parseSystemHostSummary(parsedData);

    return {
        source: row.source,
        status: row.status,
        updatedAt: row.updated_at || undefined,
        expiresAt: row.expires_at || undefined,
        errorCode: row.error_code || undefined,
        errorMessage: row.error_message || undefined,
        consecutiveFailures: Number(row.consecutive_failures),
        data,
        meta: parseJsonField<Record<string, unknown>>(row.meta) ?? {},
    };
}
