import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import type {
    LogMaintenancePolicyId,
    LogMaintenanceStatusOutput,
    RequestLogMaintenanceOutput,
} from "../../contracts/logs.ts";
import { logTailDefaultRows } from "../../contracts/logs.ts";
import { logMaintenanceAvailabilityMaximumAgeMs } from "../../shared/logMaintenanceAvailabilityProjection.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { jobRunDetailQueryOptions } from "../jobs/jobQueries.ts";
import { logClient } from "./logClient.ts";
import { logFailureMessage } from "./logPresentation.ts";
import {
    logMaintenanceQueryOptions,
    logMaintenanceQueryKey,
    logMaintenanceRealtimeFallbackRefreshIntervalMs,
    logMaintenanceRealtimeRefreshDelayMs,
    logSnapshotQueryOptions,
    logSourcesQueryOptions,
    refreshLogMaintenanceQueries,
    type LogSnapshotSelection,
} from "./logQueries.ts";
import { LogsView } from "./LogsView.tsx";

const disabledRunId = "00000000-0000-7000-8000-000000000000";
const unavailableMaintenanceAuthorityMessage =
    "Maintenance status is temporarily unavailable.";

interface RequestedRunTracking {
    readonly maintenanceDataUpdatedAt: number;
    readonly maintenanceObservedAtMs?: number;
    readonly request: RequestLogMaintenanceOutput;
}

/** @returns Session-scoped source inventory, redacted snapshots, and maintenance actions. */
export function LogsBrowser() {
    const dashboardClient = useDashboardTrpcClient();
    const client = logClient(dashboardClient);
    const queryClient = useQueryClient();
    const mutationBoundary = useAuthenticatedMutationBoundary();
    const sourcesQuery = useQuery(logSourcesQueryOptions(client));
    const maintenanceQuery = useQuery(logMaintenanceQueryOptions(client));
    const [maintenanceAuthorityNowMs, setMaintenanceAuthorityNowMs] = useState(() =>
        Date.now()
    );
    const [requestedRunTracking, setRequestedRunTracking] =
        useState<RequestedRunTracking>();
    const requestedRunRequest = requestedRunTracking?.request;
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
    const [rowCount, setRowCount] = useState(logTailDefaultRows);
    const [search, setSearch] =
        useState<Readonly<{ readonly query: string; readonly sourceId: string }>>();
    const [debouncedSearch, setDebouncedSearch] = useState(search);
    useEffect(() => {
        const timeout = globalThis.setTimeout(() => setDebouncedSearch(search), 300);
        return () => globalThis.clearTimeout(timeout);
    }, [search]);
    const sources = sourcesQuery.data?.sources ?? [];
    const selectedSource =
        sources.find(({ id }) => id === selectedSourceId) ??
        sources.find(({ availability }) => availability === "available") ??
        sources[0];
    const sourceAvailable = selectedSource?.availability === "available";
    let selection: LogSnapshotSelection | undefined;
    if (selectedSource !== undefined) {
        selection =
            debouncedSearch?.sourceId === selectedSource.id
                ? {
                      limit: rowCount,
                      mode: "search",
                      query: debouncedSearch.query,
                      sourceId: selectedSource.id,
                  }
                : { limit: rowCount, mode: "tail", sourceId: selectedSource.id };
    }
    const snapshotQuery = useQuery(
        logSnapshotQueryOptions(client, selection, sourceAvailable)
    );

    useEffect(() => {
        if (maintenanceQuery.data === undefined || maintenanceQuery.dataUpdatedAt <= 0) {
            return;
        }
        const expiresInMs =
            maintenanceQuery.dataUpdatedAt +
            logMaintenanceAvailabilityMaximumAgeMs -
            Date.now() +
            1;
        if (expiresInMs <= 0) return;
        const timeout = globalThis.setTimeout(() => {
            setMaintenanceAuthorityNowMs(Date.now());
        }, expiresInMs);
        return () => globalThis.clearTimeout(timeout);
    }, [maintenanceQuery.data, maintenanceQuery.dataUpdatedAt]);

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
            const currentMaintenanceState =
                queryClient.getQueryState<LogMaintenanceStatusOutput>(
                    logMaintenanceQueryKey
                );
            setRequestedRunTracking({
                maintenanceDataUpdatedAt: currentMaintenanceState?.dataUpdatedAt ?? 0,
                maintenanceObservedAtMs: currentMaintenanceState?.data?.observedAtMs,
                request: result,
            });
            await refreshLogMaintenanceQueries(queryClient, result.jobRunId);
        }
        return result;
    }

    async function refreshMaintenance(): Promise<void> {
        await Promise.allSettled([
            maintenanceQuery.refetch(),
            ...(requestedRunRequest === undefined ? [] : [requestedRunQuery.refetch()]),
        ]);
    }

    async function refreshAll(): Promise<void> {
        const maintenanceRefresh = refreshMaintenance();
        const refreshedSources = await sourcesQuery.refetch();
        const refreshedSelection = refreshedSources.data?.sources.find(
            ({ id }) => id === selectedSource?.id
        );
        if (refreshedSelection?.availability === "available") {
            await snapshotQuery.refetch();
        }
        await maintenanceRefresh;
    }

    const globalMaintenanceActive =
        maintenanceQuery.data?.policies.some(
            ({ activeRun }) => activeRun !== undefined
        ) ?? false;
    const maintenanceAuthorityExpired =
        maintenanceQuery.data !== undefined &&
        (maintenanceQuery.dataUpdatedAt <= 0 ||
            maintenanceAuthorityNowMs - maintenanceQuery.dataUpdatedAt >
                logMaintenanceAvailabilityMaximumAgeMs);
    const maintenanceAuthorityUnavailable =
        maintenanceQuery.error !== null ||
        maintenanceQuery.isPaused ||
        maintenanceAuthorityExpired;
    const maintenanceUpdatedAfterRequest =
        requestedRunTracking !== undefined &&
        (maintenanceQuery.dataUpdatedAt > requestedRunTracking.maintenanceDataUpdatedAt ||
            (maintenanceQuery.data?.observedAtMs !== undefined &&
                maintenanceQuery.data.observedAtMs >
                    (requestedRunTracking.maintenanceObservedAtMs ?? 0)));
    const requestedRunInactiveConfirmed =
        maintenanceUpdatedAfterRequest &&
        !maintenanceAuthorityUnavailable &&
        !globalMaintenanceActive;
    let maintenanceError: string | undefined;
    if (maintenanceQuery.error !== null) {
        maintenanceError = logFailureMessage(maintenanceQuery.error);
    } else if (maintenanceQuery.isPaused || maintenanceAuthorityExpired) {
        maintenanceError = unavailableMaintenanceAuthorityMessage;
    }
    return (
        <LogsView
            maintenance={maintenanceQuery.data}
            maintenanceError={maintenanceError}
            maintenanceLoading={maintenanceQuery.isFetching}
            onClearSearch={() => setSearch(undefined)}
            onRefresh={() => void refreshAll()}
            onRequestMaintenance={requestMaintenance}
            onRetryMaintenance={() => void maintenanceQuery.refetch()}
            onSearch={(query) => {
                if (selectedSource !== undefined && sourceAvailable) {
                    setSearch({ query, sourceId: selectedSource.id });
                }
            }}
            onSelectSource={(sourceId) => {
                setSelectedSourceId(sourceId);
                setSearch(undefined);
            }}
            onRowCountChange={setRowCount}
            refreshing={
                sourcesQuery.isRefetching ||
                (sourceAvailable && snapshotQuery.isRefetching)
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
            requestedRunInactiveConfirmed={requestedRunInactiveConfirmed}
            requestedRunRequest={requestedRunRequest}
            rowCount={rowCount}
            searchQuery={
                sourceAvailable && selection?.mode === "search"
                    ? selection.query
                    : undefined
            }
            selectedSourceId={selectedSource?.id}
            snapshot={
                sourceAvailable && snapshotQuery.error === null
                    ? snapshotQuery.data
                    : undefined
            }
            snapshotError={
                !sourceAvailable || snapshotQuery.error === null
                    ? undefined
                    : logFailureMessage(snapshotQuery.error)
            }
            snapshotLoading={sourceAvailable && snapshotQuery.isPending}
            sourcesError={
                sourcesQuery.error === null
                    ? undefined
                    : logFailureMessage(sourcesQuery.error)
            }
            sourcesLoading={sourcesQuery.isPending && sourcesQuery.data === undefined}
            sources={sources}
        />
    );
}
