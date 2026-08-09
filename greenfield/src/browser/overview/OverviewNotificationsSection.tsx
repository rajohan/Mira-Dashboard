import { useQuery } from "@tanstack/react-query";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { notificationLatestQueryOptions } from "../notifications/notificationQueries.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { PageState } from "../ui/PageState.tsx";
import { OverviewNotificationsCard } from "./OverviewNotificationsCard.tsx";

/** @returns Realtime-refreshed authoritative notification summary for the overview. */
export function OverviewNotificationsSection() {
    const client = useDashboardTrpcClient();
    const query = useQuery(notificationLatestQueryOptions(client));

    if (query.isPending && query.data === undefined) {
        return (
            <Card aria-label="Notifications" className="h-full">
                <PageState label="Loading notifications…" status="loading" />
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
                    title="Notifications unavailable"
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
            <OverviewNotificationsCard result={query.data} />
        </div>
    );
}
