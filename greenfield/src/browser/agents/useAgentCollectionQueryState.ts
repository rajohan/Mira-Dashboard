import {
    hashKey,
    type QueryKey,
    type QueryState,
    useQueryClient,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { agentConfigurationQueryKey, agentStatusesQueryKey } from "./agentQueries.ts";

function useObservedQueryState(queryKey: QueryKey): QueryState | undefined {
    const queryClient = useQueryClient();
    const queryHash = hashKey(queryKey);
    const subscribe = (onStoreChange: () => void) =>
        queryClient.getQueryCache().subscribe((event) => {
            if (event.query.queryHash === queryHash) onStoreChange();
        });
    const getSnapshot = () => queryClient.getQueryState(queryKey);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** @returns Reactive Query state for the two query-backed agent collections. */
export function useAgentCollectionQueryState() {
    return {
        configuration: useObservedQueryState(agentConfigurationQueryKey),
        statuses: useObservedQueryState(agentStatusesQueryKey),
    };
}
