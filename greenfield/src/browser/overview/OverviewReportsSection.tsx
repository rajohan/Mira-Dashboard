import { useQuery } from "@tanstack/react-query";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { reportOverviewQueryOptions } from "../monitoring/monitoringQueries.ts";
import { useReportRealtimeInvalidation } from "../monitoring/useMonitoringRealtimeInvalidation.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { PageState } from "../ui/PageState.tsx";
import { OverviewReportsCard } from "./OverviewReportsCard.tsx";

/** @returns Realtime-refreshed first report page for the operational overview. */
export function OverviewReportsSection() {
    useReportRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const query = useQuery(reportOverviewQueryOptions(client));

    if (query.isPending && query.data === undefined) {
        return (
            <Card aria-label="Reports overview">
                <PageState label="Loading reports overview…" status="loading" />
            </Card>
        );
    }
    if (query.data === undefined) {
        return (
            <PageState
                headingLevel={2}
                message={dashboardBrowserFailureMessage(query.error)}
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Reports overview unavailable"
            />
        );
    }

    return (
        <div>
            {query.error !== null && (
                <Alert
                    className="mb-4"
                    focusOnError={false}
                    message={dashboardBrowserFailureMessage(query.error)}
                />
            )}
            <OverviewReportsCard
                hasMore={query.data.nextCursor !== undefined}
                reports={query.data.reports}
            />
        </div>
    );
}
