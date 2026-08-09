import { useLiveQuery } from "@tanstack/react-db";

import type { AgentDefinition, AgentStatus } from "../../contracts/agentModel.ts";
import { useAgentCollectionQueryState } from "../agents/useAgentCollectionQueryState.ts";
import { useAgentRealtimeInvalidation } from "../agents/useAgentRealtimeInvalidation.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useDashboardBrowserCollections } from "../data/dashboardCollectionsContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { PageState } from "../ui/PageState.tsx";
import { OverviewAgentsCard } from "./OverviewAgentsCard.tsx";

const emptyAgents: readonly AgentDefinition[] = Object.freeze([]);
const emptyStatuses: readonly AgentStatus[] = Object.freeze([]);

/** @returns Realtime-refreshed complete configured-agent projection for the overview. */
export function OverviewAgentsSection() {
    useAgentRealtimeInvalidation();
    const collections = useDashboardBrowserCollections().agents;
    const configuration = useLiveQuery(collections.definitions);
    const statuses = useLiveQuery(collections.statuses);
    const queryStates = useAgentCollectionQueryState();
    const agents = configuration.data ?? emptyAgents;
    const agentStatuses = statuses.data ?? emptyStatuses;
    const error = queryStates.configuration?.error ?? queryStates.statuses?.error;
    const hasCompleteData =
        configuration.isReady &&
        statuses.isReady &&
        queryStates.configuration?.data !== undefined &&
        queryStates.statuses?.data !== undefined;
    const fetching =
        queryStates.configuration?.fetchStatus === "fetching" ||
        queryStates.statuses?.fetchStatus === "fetching";
    const retry = () => {
        void Promise.allSettled([
            collections.definitions.utils.refetch(),
            collections.statuses.utils.refetch(),
        ]);
    };

    if (!hasCompleteData && (configuration.isLoading || statuses.isLoading)) {
        return (
            <Card aria-label="Agent activity" className="h-full">
                <PageState label="Loading agent activity…" status="loading" />
            </Card>
        );
    }
    if (!hasCompleteData) {
        return (
            <div className="h-full">
                <PageState
                    headingLevel={2}
                    message={dashboardBrowserFailureMessage(error)}
                    onRetry={retry}
                    retryBusy={fetching}
                    status="error"
                    title="Agent activity unavailable"
                />
            </div>
        );
    }

    return (
        <div className="h-full">
            {error !== null && error !== undefined && (
                <Alert
                    className="mb-4"
                    focusOnError={false}
                    message={dashboardBrowserFailureMessage(error)}
                />
            )}
            <OverviewAgentsCard agents={agents} statuses={agentStatuses} />
        </div>
    );
}
