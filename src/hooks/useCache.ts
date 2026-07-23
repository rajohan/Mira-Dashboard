import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetchRequired, apiPostRequired } from "./useApi";
import { jobExecutionKeys } from "./useJobExecutions";

/** Represents cache envelope. */
export interface CacheEnvelope<T> {
    key: string;
    source: string;
    status: string;
    updatedAt: string | undefined;
    lastAttemptAt: string | undefined;
    expiresAt: string | undefined;
    errorCode: string | undefined;
    errorMessage: string | undefined;
    consecutiveFailures: number;
    data: T;
    meta: unknown;
}

/** Represents the cache heartbeat API response. */
export interface CacheHeartbeatResponse {
    cronJobs: {
        dataAvailable: boolean;
        error?: string | undefined;
        items: Array<Record<string, unknown>>;
    };
    dashboardJobs: Array<Record<string, unknown>>;
    generatedAt: string;
    count: number;
    entries: CacheEnvelope<unknown>[];
    schemaVersion: 3;
    tasks: Array<Record<string, unknown>>;
}

/** Represents the lightweight cache status API response. */
export interface CacheStatusResponse {
    generatedAt: string;
    count: number;
    entries: CacheEnvelope<null>[];
}

/** Defines cache keys. */
export const cacheKeys = {
    all: ["cache"] as const,
    heartbeat: () => [...cacheKeys.all, "heartbeat"] as const,
    status: () => [...cacheKeys.all, "status"] as const,
    entry: (key: string) => [...cacheKeys.all, key] as const,
};

/** Provides cache heartbeat. */
export function useCacheHeartbeat(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: cacheKeys.heartbeat(),
        queryFn: () => apiFetchRequired<CacheHeartbeatResponse>("/cache/heartbeat"),
        refetchInterval: refreshInterval,
        staleTime: 2000,
    });
}

/** Provides lightweight cache status. */
export function useCacheStatus(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: cacheKeys.status(),
        queryFn: () => apiFetchRequired<CacheStatusResponse>("/cache/status"),
        refetchInterval: refreshInterval,
        staleTime: 2000,
    });
}

/** Provides cache entry. */
export function useCacheEntry<T>(
    key: string,
    refreshInterval: number | false = false,
    options: { refreshOnMissing?: boolean } = {}
) {
    return useQuery({
        queryKey: cacheKeys.entry(key),
        queryFn: async () => {
            try {
                return await apiFetchRequired<CacheEnvelope<T>>(
                    `/cache/${encodeURIComponent(key)}`
                );
            } catch (error) {
                if (!options.refreshOnMissing) {
                    throw error;
                }

                const response = await apiPostRequired<{
                    isOk: boolean;
                    entry: CacheEnvelope<T>;
                }>(`/cache/${encodeURIComponent(key)}/refresh`);
                return response.entry;
            }
        },
        refetchInterval: refreshInterval,
        staleTime: 2000,
    });
}

/** Provides refresh cache entry. */
export function useRefreshCacheEntry() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (keysToken: string) => {
            const keys = keysToken
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean);

            const results: Array<{
                isOk: boolean;
                entry: CacheEnvelope<unknown>;
            }> = [];
            const errors: unknown[] = [];
            for (const key of keys) {
                try {
                    const response = await apiPostRequired<{
                        isOk: boolean;
                        entry: CacheEnvelope<unknown>;
                    }>(`/cache/${encodeURIComponent(key)}/refresh`);
                    results.push(response);
                    if (response.entry?.key) {
                        queryClient.setQueryData(
                            cacheKeys.entry(response.entry.key),
                            response.entry
                        );
                    }
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) {
                throw new AggregateError(
                    errors,
                    `${errors.length} cache refresh requests failed`
                );
            }

            return { keys, results };
        },
        onSettled: async (_result, _error, keysToken) => {
            const keys = keysToken
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
                queryClient.invalidateQueries({ queryKey: cacheKeys.status() }),
                queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all }),
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
