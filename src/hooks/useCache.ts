import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./useApi";

export interface CacheEnvelope<T> {
    key: string;
    source: string;
    status: string;
    updatedAt: string | null;
    lastAttemptAt: string | null;
    expiresAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    consecutiveFailures: number;
    data: T;
    meta: unknown;
}

export function useCacheEntry<T>(key: string, refreshInterval: number | false = false) {
    return useQuery({
        queryKey: ["cache", key],
        queryFn: () => apiFetch<CacheEnvelope<T>>(`/cache/${encodeURIComponent(key)}`),
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}
