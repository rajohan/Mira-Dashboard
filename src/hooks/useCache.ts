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
        mutationFn: async (keysToken: string) => {
            const keys = keysToken
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean);

            const results = await Promise.all(
                keys.map((key) =>
                    apiPost<{ ok: boolean; entry: CacheEnvelope<unknown> }>(
                        `/cache/${encodeURIComponent(key)}/refresh`
                    )
                )
            );

            return { keys, results };
        },
        onSuccess: async (_result, keysToken) => {
            const keys = keysToken
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean);

            await Promise.all([
                queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
                ...keys.map((key) =>
                    queryClient.invalidateQueries({ queryKey: cacheKeys.entry(key) })
                ),
                ...(keys.some((key) => key.startsWith("moltbook."))
                    ? [
                          queryClient.invalidateQueries({ queryKey: ["moltbook"] }),
                          queryClient.invalidateQueries({
                              queryKey: cacheKeys.entry("moltbook.home"),
                          }),
                          queryClient.invalidateQueries({
                              queryKey: cacheKeys.entry("moltbook.feed.hot"),
                          }),
                          queryClient.invalidateQueries({
                              queryKey: cacheKeys.entry("moltbook.feed.new"),
                          }),
                          queryClient.invalidateQueries({
                              queryKey: cacheKeys.entry("moltbook.profile"),
                          }),
                          queryClient.invalidateQueries({
                              queryKey: cacheKeys.entry("moltbook.my-content"),
                          }),
                      ]
                    : []),
            ]);
        },
    });
}
