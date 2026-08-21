import { useQuery } from "@tanstack/react-query";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { taskOverviewQueryOptions } from "../tasks/taskQueries.ts";
import { useTaskRealtimeInvalidation } from "../tasks/useTaskRealtimeInvalidation.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { PageState } from "../ui/PageState.tsx";
import { OverviewTasksCard } from "./OverviewTasksCard.tsx";

/** @returns Realtime-refreshed newest unfinished-task window for the overview. */
export function OverviewTasksSection() {
    useTaskRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const query = useQuery(taskOverviewQueryOptions(client));

    if (query.isPending && query.data === undefined) {
        return (
            <Card aria-label="Unfinished tasks" className="h-full">
                <PageState label="Loading unfinished tasks…" status="loading" />
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
                    title="Unfinished tasks unavailable"
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
            <OverviewTasksCard
                hasMore={query.data.nextCursor !== undefined}
                tasks={query.data.tasks}
            />
        </div>
    );
}
