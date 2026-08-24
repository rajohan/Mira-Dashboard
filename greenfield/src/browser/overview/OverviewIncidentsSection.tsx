import { useQuery } from "@tanstack/react-query";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { incidentOverviewQueryOptions } from "../monitoring/monitoringQueries.ts";
import { useIncidentRealtimeInvalidation } from "../monitoring/useMonitoringRealtimeInvalidation.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { PageState } from "../ui/PageState.tsx";
import { OverviewIncidentsCard } from "./OverviewIncidentsCard.tsx";

/** @returns Realtime-refreshed persisted active-incidents overview. */
export function OverviewIncidentsSection() {
    useIncidentRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const query = useQuery(incidentOverviewQueryOptions(client));

    if (query.isPending && query.data === undefined) {
        return (
            <Card aria-label="Active incidents" className="h-full">
                <PageState label="Loading active incidents…" status="loading" />
            </Card>
        );
    }
    if (query.data === undefined) {
        return (
            <div className="h-full">
                <PageState
                    headingLevel={2}
                    message={dashboardBrowserFailureMessage(query.error)}
                    onRetry={() => void query.refetch()}
                    retryBusy={query.isFetching}
                    status="error"
                    title="Active incidents unavailable"
                />
            </div>
        );
    }

    return (
        <div className="h-full">
            {query.error !== null && (
                <Alert
                    className="mb-4"
                    focusOnError={false}
                    message={dashboardBrowserFailureMessage(query.error)}
                />
            )}
            <OverviewIncidentsCard
                hasMore={query.data.nextCursor !== undefined}
                incidents={query.data.incidents}
            />
        </div>
    );
}
