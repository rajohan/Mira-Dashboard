import { useLiveQuery } from "@tanstack/react-db";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import type {
    AgentDefinition,
    AgentStatusProjection,
    AgentTaskRun,
} from "../../contracts/agentModel.ts";
import {
    liveHistoryRowIdentity,
    useAccumulatedLiveHistoryRows,
} from "../api/liveHistory.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useDashboardBrowserCollections } from "../data/dashboardCollectionsContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Heading } from "../ui/Heading.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
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
    const runs = useAccumulatedLiveHistoryRows(
        historyLiveHead.data?.runs ?? [],
        history.data?.pages.flatMap((page) => page.runs) ?? emptyRuns,
        liveHistoryRowIdentity,
        "agents"
    );
    const historyPageError = history.data === undefined ? null : history.error;
    const error =
        collectionQueries.configuration?.error ??
        collectionQueries.statuses?.error ??
        historyLiveHead.error ??
        (history.data === undefined ? history.error : null);
    const historyAvailable =
        history.data !== undefined || historyLiveHead.data !== undefined;
    const pending =
        configuration.isLoading ||
        statuses.isLoading ||
        (history.isPending && historyLiveHead.isPending);
    const hasCompleteData =
        configuration.isReady &&
        statuses.isReady &&
        collectionQueries.configuration?.data !== undefined &&
        collectionQueries.statuses?.data !== undefined &&
        historyAvailable;

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
            <Heading className="sr-only" level={1}>
                Agents
            </Heading>
            {pending && !hasCompleteData && <LoadingState label="Loading agents…" />}
            {error !== null && (
                <Alert
                    action={
                        <Button onClick={refresh} size="sm" variant="secondary">
                            Try again
                        </Button>
                    }
                    message={dashboardBrowserFailureMessage(error)}
                />
            )}
            {hasCompleteData && (
                <div className="space-y-10">
                    <AgentStatusGrid
                        agents={agents}
                        runs={runs}
                        statuses={agentStatuses}
                    />
                    <div>
                        <AgentHistoryTable
                            pagination={{
                                ...(historyPageError === null
                                    ? {}
                                    : {
                                          error: dashboardBrowserFailureMessage(
                                              historyPageError
                                          ),
                                      }),
                                hasMore: history.hasNextPage,
                                loading: history.isFetchingNextPage,
                                loadingLabel: "Loading older tasks…",
                                onLoadMore: () => void history.fetchNextPage(),
                            }}
                            runs={runs}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
