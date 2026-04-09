import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost } from "./useApi";

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

export interface CacheHeartbeatResponse {
    generatedAt: string;
    count: number;
    entries: CacheEnvelope<unknown>[];
}

export const cacheKeys = {
    all: ["cache"] as const,
    heartbeat: () => [...cacheKeys.all, "heartbeat"] as const,
    entry: (key: string) => [...cacheKeys.all, key] as const,
};

export function useCacheHeartbeat(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: cacheKeys.heartbeat(),
        queryFn: () => apiFetch<CacheHeartbeatResponse>("/cache/heartbeat"),
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}

export function useCacheEntry<T>(key: string, refreshInterval: number | false = false) {
    return useQuery({
        queryKey: cacheKeys.entry(key),
        queryFn: () => apiFetch<CacheEnvelope<T>>(`/cache/${encodeURIComponent(key)}`),
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}

export function useRefreshCacheEntry() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (key: string) =>
            apiPost<{ ok: boolean; entry: CacheEnvelope<unknown> }>(
                `/cache/${encodeURIComponent(key)}/refresh`
            ),
        onSuccess: async (_result, key) => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
                queryClient.invalidateQueries({ queryKey: cacheKeys.entry(key) }),
                key.startsWith("system.")
                    ? queryClient.invalidateQueries({ queryKey: ["openclaw-version"] })
                    : Promise.resolve(),
            ]);
        },
    });
}
