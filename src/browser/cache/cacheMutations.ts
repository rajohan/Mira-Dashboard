import { type QueryClient, useMutation } from "@tanstack/react-query";

import type {
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { authenticatedBrowserCacheGeneration } from "../auth/authQueries.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { patchJobRunInCachedQueries } from "../jobs/jobMutations.ts";
import { refreshJobAndScheduleQueries } from "../jobs/jobQueries.ts";
import { cacheBrowserFailureMessage } from "./cachePresentation.ts";
import { refreshCacheQueriesForEntry } from "./cacheQueries.ts";

export const cacheRefreshMutationKey = ["cache", "mutation", "refresh-entry"] as const;

interface PendingCacheRefreshKeys {
    readonly cacheGeneration: number;
    readonly keys: Map<string, string>;
}

const pendingCacheRefreshKeys = new WeakMap<QueryClient, PendingCacheRefreshKeys>();

function cacheRefreshKeysForCurrentCache(queryClient: QueryClient): Map<string, string> {
    const cacheGeneration = authenticatedBrowserCacheGeneration(queryClient);
    const current = pendingCacheRefreshKeys.get(queryClient);
    if (current?.cacheGeneration === cacheGeneration) return current.keys;
    const keys = new Map<string, string>();
    pendingCacheRefreshKeys.set(queryClient, { cacheGeneration, keys });
    return keys;
}

function refreshBestEffort(refresh: () => Promise<void>): void {
    void refresh().catch(() => {
        // Validated mutation data remains usable until a later refresh succeeds.
    });
}

async function refreshCacheRunProjections(
    queryClient: QueryClient,
    key: string
): Promise<void> {
    await Promise.allSettled([
        refreshCacheQueriesForEntry(queryClient, key),
        refreshJobAndScheduleQueries(queryClient),
    ]);
}

/** Variables intentionally omit the authenticated cache-owned idempotency key. */
export interface RefreshCacheEntryMutationInput {
    readonly key: DashboardProcedureInput<"cache.refreshEntry">["key"];
}

/** @returns One caller-scoped, contract-valid lost-response idempotency key. */
export function createCacheRefreshIdempotencyKey(): string {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/**
 * Enqueues one authenticated cache refresh without claiming provider completion.
 * @param createIdempotencyKey Secure generator used once per confirmed-success cycle.
 * @returns Lost-response-safe mutation state and a fixed browser-safe failure message.
 */
export function useRefreshCacheEntryMutation(
    createIdempotencyKey: () => string = createCacheRefreshIdempotencyKey
) {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    const mutation = useMutation<
        DashboardProcedureOutput<"cache.refreshEntry">,
        Error,
        RefreshCacheEntryMutationInput
    >({
        mutationKey: cacheRefreshMutationKey,
        mutationFn: ({ key }) =>
            boundary.run((signal) => {
                const pendingKeys = cacheRefreshKeysForCurrentCache(boundary.queryClient);
                const idempotencyKey = pendingKeys.get(key) ?? createIdempotencyKey();
                pendingKeys.set(key, idempotencyKey);
                return client.mutation(
                    "cache.refreshEntry",
                    { idempotencyKey, key },
                    { signal }
                );
            }),
        onSettled: (_run, _error, input) => {
            if (!boundary.completionIsCurrent()) return;
            refreshBestEffort(() =>
                refreshCacheRunProjections(boundary.queryClient, input.key)
            );
        },
        onSuccess: (run, input) => {
            if (!boundary.completionIsCurrent()) return;
            cacheRefreshKeysForCurrentCache(boundary.queryClient).delete(input.key);
            patchJobRunInCachedQueries(boundary.queryClient, run, true);
        },
    });
    return {
        ...mutation,
        failureMessage:
            mutation.error === null
                ? undefined
                : cacheBrowserFailureMessage(mutation.error),
        hasPendingRequest: (key: string): boolean =>
            cacheRefreshKeysForCurrentCache(boundary.queryClient).has(key),
    };
}
