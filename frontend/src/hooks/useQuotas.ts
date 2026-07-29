import {
    parseQuotasResponse,
    type QuotaError,
    type QuotasResponse,
} from "../../../contracts/quotas";
import { useCacheEntry } from "./useCache";

/**
 * Provides quotas.
 * @param refreshInterval Refresh interval value.
 * @returns The quotas.
 */
export function useQuotas(refreshInterval: number | false = false) {
    const query = useCacheEntry<QuotasResponse>(
        "quotas.summary",
        parseQuotasResponse,
        refreshInterval
    );

    return {
        ...query,
        data: query.data?.data,
    };
}

/**
 * Returns whether quota status is present.
 * @param value Value to process.
 * @returns Whether quota status is present.
 */
export function hasQuotaStatus(value?: unknown): value is QuotaError {
    if (!value || typeof value !== "object") {
        return false;
    }

    return (
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}
