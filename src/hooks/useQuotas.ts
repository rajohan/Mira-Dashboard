import type { QuotaError, QuotasResponse } from "../../contracts/quotas";
import { useCacheEntry } from "./useCache";

/** Provides quotas. */
export function useQuotas(refreshInterval: number | false = false) {
    const query = useCacheEntry<QuotasResponse>("quotas.summary", refreshInterval);

    return {
        ...query,
        data: query.data?.data,
    };
}

/** Returns whether quota status is present. */
export function hasQuotaStatus(value: unknown): value is QuotaError {
    if (!value || typeof value !== "object") {
        return false;
    }

    return (
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}
