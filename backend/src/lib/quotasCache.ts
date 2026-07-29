import type { QuotaError, QuotasResponse } from "../../../contracts/quotas.ts";
import { getCacheEntry, parseJsonField } from "./cacheStore.ts";

/**
 * Returns whether quota status is present.
 * @param value Value to process.
 * @returns Whether quota status is present.
 */
export function hasQuotaStatus(value: unknown): value is QuotaError {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}

/**
 * Fetches cached quotas.
 * @returns Fetch cached quotas result.
 */
export function fetchCachedQuotas(): QuotasResponse {
    const row = getCacheEntry("quotas.summary");
    if (!row || row.status !== "fresh") {
        throw new Error("Quota cache entry not found or not fresh");
    }

    const data = parseJsonField<QuotasResponse>(row.data);
    if (!data) {
        throw new Error("Quota cache payload is invalid");
    }

    return {
        ...data,
        cacheAgeMs: Math.max(Date.now() - data.checkedAt, 0),
    };
}
