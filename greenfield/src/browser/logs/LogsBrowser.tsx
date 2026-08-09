import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { LogMaintenancePolicyId } from "../../contracts/logs.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { PageState } from "../ui/PageState.tsx";
import { logClient } from "./logClient.ts";
import { logFailureMessage } from "./logPresentation.ts";
import {
    logMaintenanceQueryKey,
    logMaintenanceQueryOptions,
    logSnapshotQueryOptions,
    logSourcesQueryOptions,
    type LogSnapshotSelection,
} from "./logQueries.ts";
import { LogsView } from "./LogsView.tsx";

/** @returns Session-scoped source inventory, redacted snapshots, and maintenance actions. */
export function LogsBrowser() {
    const client = logClient(useDashboardTrpcClient());
    const queryClient = useQueryClient();
    const mutationBoundary = useAuthenticatedMutationBoundary();
    const sourcesQuery = useQuery(logSourcesQueryOptions(client));
    const maintenanceQuery = useQuery(logMaintenanceQueryOptions(client));
    const [selectedSourceId, setSelectedSourceId] = useState<string>();
    const [search, setSearch] =
        useState<Readonly<{ readonly query: string; readonly sourceId: string }>>();
    const sources = sourcesQuery.data?.sources ?? [];
    const selectedSource =
        sources.find(({ id }) => id === selectedSourceId) ??
        sources.find(({ availability }) => availability === "available") ??
        sources[0];
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
        logSnapshotQueryOptions(
            client,
            selection,
            selectedSource?.availability === "available"
        )
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

    async function requestMaintenance(policyId: LogMaintenancePolicyId) {
        const result = await mutationBoundary.run((signal) =>
            client.mutation(
                "logs.requestMaintenance",
                {
                    idempotencyKey: globalThis.crypto.randomUUID().replaceAll("-", ""),
                    policyId,
                },
                { signal }
            )
        );
        if (mutationBoundary.completionIsCurrent()) {
            await queryClient.invalidateQueries({
                exact: true,
                queryKey: logMaintenanceQueryKey,
            });
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
            onRefresh={() =>
                void Promise.allSettled([
                    sourcesQuery.refetch(),
                    snapshotQuery.refetch(),
                    maintenanceQuery.refetch(),
                ])
            }
            onRequestMaintenance={requestMaintenance}
            onSearch={(query) => {
                if (selectedSource !== undefined) {
                    setSearch({ query, sourceId: selectedSource.id });
                }
            }}
            onSelectSource={(sourceId) => {
                setSelectedSourceId(sourceId);
                setSearch(undefined);
            }}
            refreshing={
                sourcesQuery.isRefetching ||
                snapshotQuery.isRefetching ||
                maintenanceQuery.isRefetching
            }
            searchQuery={selection?.mode === "search" ? selection.query : undefined}
            selectedSourceId={selectedSource?.id}
            snapshot={snapshotQuery.data}
            snapshotError={
                snapshotQuery.error === null
                    ? undefined
                    : logFailureMessage(snapshotQuery.error)
            }
            snapshotLoading={snapshotQuery.isPending}
            sources={sources}
        />
    );
}
