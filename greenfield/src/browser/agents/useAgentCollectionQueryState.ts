import { useObservedQueryState } from "../api/useObservedQueryState.ts";
import { agentConfigurationQueryKey, agentStatusesQueryKey } from "./agentQueries.ts";

/** @returns Reactive Query state for the two query-backed agent collections. */
export function useAgentCollectionQueryState() {
    return {
        configuration: useObservedQueryState(agentConfigurationQueryKey),
        statuses: useObservedQueryState(agentStatusesQueryKey),
    };
}
