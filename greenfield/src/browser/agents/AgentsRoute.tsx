import { useLiveQuery } from "@tanstack/react-db";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import type {
    AgentDefinition,
    AgentStatusProjection,
    AgentTaskRun,
} from "../../contracts/agentModel.ts";
import { mergeLiveHistoryRows } from "../api/liveHistory.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useDashboardBrowserCollections } from "../data/dashboardCollectionsContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { AgentHistoryTable } from "./AgentHistoryTable.tsx";
import {
    agentHistoryLiveHeadQueryOptions,
    agentHistoryQueryOptions,
} from "./agentQueries.ts";
import { AgentStatusGrid } from "./AgentStatusGrid.tsx";
import { useAgentCollectionQueryState } from "./useAgentCollectionQueryState.ts";
import { useAgentRealtimeInvalidation } from "./useAgentRealtimeInvalidation.ts";

const emptyAgents: readonly AgentDefinition[] = Object.freeze([]);
const emptyStatuses: readonly AgentStatusProjection[] = Object.freeze([]);
const emptyRuns: readonly AgentTaskRun[] = Object.freeze([]);

/** @returns Dashboard-owned agent state, current tasks, and durable task history. */
export function AgentsRoute() {
    useAgentRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const collections = useDashboardBrowserCollections().agents;
    const configuration = useLiveQuery(collections.definitions);
    const statuses = useLiveQuery(collections.statuses);
    const collectionQueries = useAgentCollectionQueryState();
    const history = useInfiniteQuery(agentHistoryQueryOptions(client));
    const historyLiveHead = useQuery(agentHistoryLiveHeadQueryOptions(client));
    const agents = configuration.data ?? emptyAgents;
    const agentStatuses = statuses.data ?? emptyStatuses;
    const runs = mergeLiveHistoryRows(
        historyLiveHead.data?.runs ?? [],
        history.data?.pages.flatMap((page) => page.runs) ?? emptyRuns,
        ({ id }) => id
    );
    const error =
        collectionQueries.configuration?.error ??
        collectionQueries.statuses?.error ??
        historyLiveHead.error ??
        history.error;
    const pending = configuration.isLoading || statuses.isLoading || history.isPending;
    const hasCompleteData =
        configuration.isReady &&
        statuses.isReady &&
        collectionQueries.configuration?.data !== undefined &&
        collectionQueries.statuses?.data !== undefined &&
        history.data !== undefined;

    const refresh = () => {
        void Promise.allSettled([
            collections.definitions.utils.refetch(),
            collections.statuses.utils.refetch(),
            historyLiveHead.refetch(),
            history.refetch(),
        ]);
    };

    return (
        <div>
            <PageHeader
                description="Reviewed roles, Dashboard-owned tasks, and separate Gateway session availability. Availability is not online status or health. Updates automatically from agent and Gateway events, with 10-second status repair polling."
                eyebrow="Operations"
                title="Agents"
            />
            {pending && !hasCompleteData && (
                <LoadingState className="mt-10" label="Loading agents…" />
            )}
            {error !== null && (
                <Alert
                    action={
                        <Button onClick={refresh} size="sm" variant="secondary">
                            Try again
                        </Button>
                    }
                    className="mt-6"
                    message={dashboardBrowserFailureMessage(error)}
                />
            )}
            {hasCompleteData && (
                <div className="mt-8 space-y-10">
                    <AgentStatusGrid agents={agents} statuses={agentStatuses} />
                    <div>
                        <AgentHistoryTable runs={runs} />
                        {history.hasNextPage && (
                            <Button
                                busy={history.isFetchingNextPage}
                                busyLabel="Loading…"
                                className="mt-4"
                                onClick={() => void history.fetchNextPage()}
                                variant="secondary"
                            >
                                Load older tasks
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
