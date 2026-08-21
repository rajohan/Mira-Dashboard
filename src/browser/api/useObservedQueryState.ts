import {
    hashKey,
    type QueryCacheNotifyEvent,
    type QueryKey,
    type QueryState,
    useQueryClient,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

function querySnapshotMayHaveChanged(eventType: QueryCacheNotifyEvent["type"]): boolean {
    // Observer lifecycle events can fire synchronously while another component
    // renders, but they cannot change the query state or data snapshots below.
    return eventType === "added" || eventType === "removed" || eventType === "updated";
}

/**
 * Observes one exact Query cache entry without starting a second query observer.
 * @param queryKey Stable key owned by a query-backed collection.
 * @returns The current reactive Query state for that exact key.
 */
export function useObservedQueryState<TData = unknown>(
    queryKey: QueryKey
): QueryState<TData> | undefined {
    const queryClient = useQueryClient();
    const queryHash = hashKey(queryKey);
    const subscribe = (onStoreChange: () => void) =>
        queryClient.getQueryCache().subscribe((event) => {
            if (
                event.query.queryHash === queryHash &&
                querySnapshotMayHaveChanged(event.type)
            ) {
                onStoreChange();
            }
        });
    const getSnapshot = () => queryClient.getQueryState<TData>(queryKey);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Observes only one exact query's data reference, ignoring fetch/status churn.
 * @param queryKey Stable exact query key.
 * @returns Current cached data without creating another query observer.
 */
export function useObservedQueryData<TData = unknown>(
    queryKey: QueryKey
): TData | undefined {
    const queryClient = useQueryClient();
    const queryHash = hashKey(queryKey);
    const subscribe = (onStoreChange: () => void) =>
        queryClient.getQueryCache().subscribe((event) => {
            if (
                event.query.queryHash === queryHash &&
                querySnapshotMayHaveChanged(event.type)
            ) {
                onStoreChange();
            }
        });
    const getSnapshot = () => queryClient.getQueryData<TData>(queryKey);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
