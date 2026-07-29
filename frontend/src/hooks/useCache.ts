import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    type CacheEnvelope,
    cacheEnvelopeParser,
    cacheRefreshResponseParser,
    parseCacheHeartbeatResponse,
    parseCacheStatusResponse,
} from "../../../contracts/cache";
import type { ContractParser } from "../../../contracts/runtime";
import { apiFetchParsed, apiPostParsed } from "./useApi";
import {
    jobExecutionKeys,
    refreshJobExecutionQueueWhilePending,
} from "./useJobExecutions";
import { scheduledJobKeys } from "./useScheduledJobs";

/** Defines cache keys. */
export const cacheKeys = {
    all: ["cache"] as const,
    heartbeat: () => [...cacheKeys.all, "heartbeat"] as const,
    status: () => [...cacheKeys.all, "status"] as const,
    entry: (key: string) => [...cacheKeys.all, key] as const,
};

/**
 * Provides cache heartbeat.
 * @param refreshInterval Refresh interval value.
 * @returns The cache heartbeat.
 */
export function useCacheHeartbeat(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: cacheKeys.heartbeat(),
        queryFn: () => apiFetchParsed("/cache/heartbeat", parseCacheHeartbeatResponse),
        refetchInterval: refreshInterval,
        staleTime: 2000,
    });
}

/**
 * Provides lightweight cache status.
 * @param refreshInterval Refresh interval value.
 * @returns The lightweight cache status.
 */
export function useCacheStatus(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: cacheKeys.status(),
        queryFn: () => apiFetchParsed("/cache/status", parseCacheStatusResponse),
        refetchInterval: refreshInterval,
        staleTime: 2000,
    });
}

/**
 * Provides cache entry.
 * @param key Lookup key.
 * @param parseData Parse data value.
 * @param refreshInterval Refresh interval value.
 * @param options Operation options.
 * @returns The cache entry.
 */
export function useCacheEntry<T>(
    key: string,
    parseData: ContractParser<T>,
    refreshInterval: number | false = false,
    options: { refreshOnMissing?: boolean } = {}
) {
    return useQuery({
        queryKey: cacheKeys.entry(key),
        queryFn: async () => {
            try {
                return await apiFetchParsed(
                    `/cache/${encodeURIComponent(key)}`,
                    cacheEnvelopeParser(parseData)
                );
            } catch (error) {
                if (!options.refreshOnMissing) {
                    throw error;
                }

                const response = await apiPostParsed(
                    `/cache/${encodeURIComponent(key)}/refresh`,
                    cacheRefreshResponseParser(parseData)
                );
                return response.entry;
            }
        },
        refetchInterval: refreshInterval,
        staleTime: 2000,
    });
}

/**
 * Provides refresh cache entry.
 * @returns The refresh cache entry.
 */
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
                    const response = await refreshJobExecutionQueueWhilePending(
                        queryClient,
                        apiPostParsed(
                            `/cache/${encodeURIComponent(key)}/refresh`,
                            cacheRefreshResponseParser((data) => data)
                        )
                    );
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
                queryClient.invalidateQueries({ queryKey: scheduledJobKeys.all }),
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
