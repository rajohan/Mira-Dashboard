import { useQuery } from "@tanstack/react-query";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { jobBrowserFailureMessage } from "../jobs/jobBrowserFailure.ts";
import { jobQueueSummaryQueryOptions } from "../jobs/jobQueries.ts";
import { useJobRealtimeInvalidation } from "../jobs/useJobRealtimeInvalidation.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { PageState } from "../ui/PageState.tsx";
import { OverviewJobsCard } from "./OverviewJobsCard.tsx";

/** @returns Realtime-refreshed Dashboard-local queue summary for the overview. */
export function OverviewJobsSection() {
    useJobRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const query = useQuery(jobQueueSummaryQueryOptions(client));

    if (query.isPending && query.data === undefined) {
        return (
            <Card aria-label="Dashboard job queue">
                <PageState label="Loading Dashboard job queue…" status="loading" />
            </Card>
        );
    }
    if (query.data === undefined) {
        return (
            <PageState
                headingLevel={2}
                message={jobBrowserFailureMessage(query.error)}
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Dashboard job queue unavailable"
            />
        );
    }

    return (
        <div>
            {query.error !== null && (
                <Alert
                    className="mb-4"
                    focusOnError={false}
                    message={jobBrowserFailureMessage(query.error)}
                />
            )}
            <OverviewJobsCard summary={query.data} />
        </div>
    );
}
