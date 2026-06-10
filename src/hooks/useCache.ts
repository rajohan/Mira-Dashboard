import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetchRequired, apiPostRequired } from "./useApi";

/** Represents cache envelope. */
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

/** Represents the cache heartbeat API response. */
export interface CacheHeartbeatResponse {
    generatedAt: string;
    count: number;
    entries: CacheEnvelope<unknown>[];
}

interface CacheRefreshResponse {
    ok: boolean;
    entry?: CacheEnvelope<unknown>;
    entries?: CacheEnvelope<unknown>[];
}

function refreshedEntryKeys(result: { results: CacheRefreshResponse[] }) {
    return [
        ...new Set(
            result.results.flatMap((response) => {
                if (Array.isArray(response.entries)) {
                    return response.entries
                        .map((entry) => entry.key)
                        .filter(
                            (key): key is string =>
                                typeof key === "string" && key.length > 0
                        );
                }
                return typeof response.entry?.key === "string" &&
                    response.entry.key.length > 0
                    ? [response.entry.key]
                    : [];
            })
        ),
    ];
}

function cacheRefreshErrorMessage(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
}

/** Defines cache keys. */
export const cacheKeys = {
    all: ["cache"] as const,
    heartbeat: () => [...cacheKeys.all, "heartbeat"] as const,
    entry: (key: string) => [...cacheKeys.all, key] as const,
};

/** Provides cache heartbeat. */
export function useCacheHeartbeat(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: cacheKeys.heartbeat(),
        queryFn: () => apiFetchRequired<CacheHeartbeatResponse>("/cache/heartbeat"),
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}

/** Provides cache entry. */
export function useCacheEntry<T>(key: string, refreshInterval: number | false = false) {
    return useQuery({
        queryKey: cacheKeys.entry(key),
        queryFn: () =>
            apiFetchRequired<CacheEnvelope<T>>(`/cache/${encodeURIComponent(key)}`),
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}

/** Provides refresh cache entry. */
export function useRefreshCacheEntry() {
    const queryClient = useQueryClient();

    async function invalidateRefreshed(result: {
        keys: string[];
        results: CacheRefreshResponse[];
    }) {
        const invalidationKeys = [
            ...new Set([...result.keys, ...refreshedEntryKeys(result)]),
        ];
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
            ...invalidationKeys.map((key) =>
                queryClient.invalidateQueries({ queryKey: cacheKeys.entry(key) })
            ),
            ...(invalidationKeys.some(
                (key) => key === "moltbook" || key.startsWith("moltbook.")
            )
                ? [queryClient.invalidateQueries({ queryKey: ["moltbook"] })]
                : []),
        ]);
    }

    return useMutation({
        mutationFn: async (keysToken: string) => {
            const keys = keysToken
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean);

            const settledResults = await Promise.allSettled(
                keys.map((key) =>
                    apiPostRequired<CacheRefreshResponse>(
                        `/cache/${encodeURIComponent(key)}/refresh`
                    )
                )
            );

            const successfulKeys = keys.filter(
                (_key, index) => settledResults[index]?.status === "fulfilled"
            );
            const results = settledResults.flatMap((result) =>
                result.status === "fulfilled" ? [result.value] : []
            );
            const failures = settledResults.filter(
                (result): result is PromiseRejectedResult => result.status === "rejected"
            );
            const result = { keys: successfulKeys, results };
            if (failures.length > 0) {
                if (successfulKeys.length > 0) {
                    await invalidateRefreshed(result);
                }
                throw new Error(
                    failures
                        .map((failure) => cacheRefreshErrorMessage(failure.reason))
                        .join("; ")
                );
            }
            return result;
        },
        onSuccess: invalidateRefreshed,
    });
}
