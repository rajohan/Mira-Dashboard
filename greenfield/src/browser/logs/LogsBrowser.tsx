import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import type {
    LogMaintenancePolicyId,
    RequestLogMaintenanceOutput,
} from "../../contracts/logs.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { jobRunDetailQueryOptions } from "../jobs/jobQueries.ts";
import { PageState } from "../ui/PageState.tsx";
import { logClient } from "./logClient.ts";
import { logFailureMessage } from "./logPresentation.ts";
import {
    logMaintenanceQueryOptions,
    logMaintenanceRealtimeFallbackRefreshIntervalMs,
    logMaintenanceRealtimeRefreshDelayMs,
    logSnapshotQueryOptions,
    logSourcesQueryOptions,
    refreshLogMaintenanceQueries,
    type LogSnapshotSelection,
} from "./logQueries.ts";
import { LogsView } from "./LogsView.tsx";

const disabledRunId = "00000000-0000-7000-8000-000000000000";

/** @returns Session-scoped source inventory, redacted snapshots, and maintenance actions. */
export function LogsBrowser() {
    const dashboardClient = useDashboardTrpcClient();
    const client = logClient(dashboardClient);
    const queryClient = useQueryClient();
    const mutationBoundary = useAuthenticatedMutationBoundary();
    const sourcesQuery = useQuery(logSourcesQueryOptions(client));
    const maintenanceQuery = useQuery(logMaintenanceQueryOptions(client));
    const [requestedRunRequest, setRequestedRunRequest] =
        useState<RequestLogMaintenanceOutput>();
    const requestedRunQuery = useQuery({
        ...jobRunDetailQueryOptions(
            dashboardClient,
            requestedRunRequest?.jobRunId ?? disabledRunId
        ),
        enabled: requestedRunRequest !== undefined,
    });
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: logMaintenanceRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: logMaintenanceRealtimeRefreshDelayMs,
        refreshQueries: (cache) =>
            refreshLogMaintenanceQueries(cache, requestedRunRequest?.jobRunId),
        topic: jobRealtimeTopics.runs,
    });
    const [selectedSourceId, setSelectedSourceId] = useState<string>();
    const [search, setSearch] =
        useState<Readonly<{ readonly query: string; readonly sourceId: string }>>();
    const sources = sourcesQuery.data?.sources ?? [];
    const selectedSource =
        sources.find(({ id }) => id === selectedSourceId) ??
        sources.find(({ availability }) => availability === "available") ??
        sources[0];
    const sourceAvailable = selectedSource?.availability === "available";
    let selection: LogSnapshotSelection | undefined;
    if (selectedSource !== undefined) {
        selection =
            search?.sourceId === selectedSource.id
                ? {
                      mode: "search",
                      query: search.query,
                      sourceId: selectedSource.id,
                  }
                : { mode: "tail", sourceId: selectedSource.id };
    }
    const snapshotQuery = useQuery(
        logSnapshotQueryOptions(client, selection, sourceAvailable)
    );

    if (sourcesQuery.isPending && sourcesQuery.data === undefined) {
        return <PageState label="Loading log sources…" status="loading" />;
    }
    if (sourcesQuery.data === undefined) {
        return (
            <PageState
                message={logFailureMessage(sourcesQuery.error)}
                onRetry={() => void sourcesQuery.refetch()}
                retryBusy={sourcesQuery.isFetching}
                status="error"
                title="Log sources unavailable"
            />
        );
    }

    async function requestMaintenance(policyId: LogMaintenancePolicyId, dryRun: boolean) {
        const result = await mutationBoundary.run((signal) =>
            client.mutation(
                "logs.requestMaintenance",
                {
                    dryRun,
                    idempotencyKey: globalThis.crypto.randomUUID().replaceAll("-", ""),
                    policyId,
                },
                { signal }
            )
        );
        if (mutationBoundary.completionIsCurrent()) {
            setRequestedRunRequest(result);
            await refreshLogMaintenanceQueries(queryClient, result.jobRunId);
        }
        return result;
    }

    return (
        <LogsView
            maintenance={maintenanceQuery.data}
            maintenanceError={
                maintenanceQuery.error === null
                    ? undefined
                    : logFailureMessage(maintenanceQuery.error)
            }
            maintenanceLoading={maintenanceQuery.isPending}
            onClearSearch={() => setSearch(undefined)}
            onRefresh={() => {
                void (async () => {
                    const maintenanceRefresh = maintenanceQuery.refetch();
                    const requestedRunRefresh =
                        requestedRunRequest === undefined
                            ? undefined
                            : requestedRunQuery.refetch();
                    const refreshedSources = await sourcesQuery.refetch();
                    const refreshedSelection = refreshedSources.data?.sources.find(
                        ({ id }) => id === selectedSource?.id
                    );
                    if (refreshedSelection?.availability === "available") {
                        await snapshotQuery.refetch();
                    }
                    await maintenanceRefresh;
                    await requestedRunRefresh;
                })();
            }}
            onRequestMaintenance={requestMaintenance}
            onSearch={(query) => {
                if (selectedSource !== undefined && sourceAvailable) {
                    setSearch({ query, sourceId: selectedSource.id });
                }
            }}
            onSelectSource={(sourceId) => {
                setSelectedSourceId(sourceId);
                setSearch(undefined);
            }}
            refreshing={
                sourcesQuery.isRefetching ||
                (sourceAvailable && snapshotQuery.isRefetching) ||
                maintenanceQuery.isRefetching ||
                requestedRunQuery.isRefetching
            }
            requestedRun={requestedRunQuery.data}
            requestedRunError={
                requestedRunQuery.error === null
                    ? undefined
                    : logFailureMessage(requestedRunQuery.error)
            }
            requestedRunLoading={
                requestedRunRequest !== undefined && requestedRunQuery.isPending
            }
            requestedRunRequest={requestedRunRequest}
            searchQuery={
                sourceAvailable && selection?.mode === "search"
                    ? selection.query
                    : undefined
            }
            selectedSourceId={selectedSource?.id}
            snapshot={sourceAvailable ? snapshotQuery.data : undefined}
            snapshotError={
                !sourceAvailable || snapshotQuery.error === null
                    ? undefined
                    : logFailureMessage(snapshotQuery.error)
            }
            snapshotLoading={sourceAvailable && snapshotQuery.isPending}
            sources={sources}
        />
    );
}
