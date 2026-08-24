import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { PageState } from "../ui/PageState.tsx";
import { BackupOverviewSection } from "./BackupOverviewSection.tsx";
import { OverviewDomainSection } from "./OverviewDomainSection.tsx";
import {
    OverviewEnvironmentCards,
    WeatherOverviewCard,
} from "./OverviewEnvironmentSection.tsx";
import { OverviewIncidentsSection } from "./OverviewIncidentsSection.tsx";
import { OverviewJobsSection } from "./OverviewJobsSection.tsx";
import { OverviewReportsSection } from "./OverviewReportsSection.tsx";
import { OverviewTasksSection } from "./OverviewTasksSection.tsx";
import { SystemMetricsCards } from "./SystemMetricsCards.tsx";
import { systemMetricsFailureMessage } from "./systemMetricsPresentation.ts";
import { systemMetricsQueryOptions } from "./systemMetricsQueries.ts";

/** @returns Five-second read-only metrics overview retaining validated query data. */
export function SystemMetricsSection() {
    const client = useDashboardTrpcClient();
    const query = useQuery(systemMetricsQueryOptions(client));
    let content: ReactNode;

    if (query.isPending && query.data === undefined) {
        content = (
            <Card className="sm:col-span-2 lg:col-span-3">
                <PageState label="Loading system usage…" status="loading" />
            </Card>
        );
    } else if (query.data === undefined) {
        content = (
            <div className="sm:col-span-2 lg:col-span-3">
                <PageState
                    headingLevel={3}
                    message={systemMetricsFailureMessage(query.error)}
                    onRetry={() => void query.refetch()}
                    retryBusy={query.isFetching}
                    status="error"
                    title="System usage unavailable"
                />
            </div>
        );
    } else {
        content = null;
    }

    return (
        <section>
            <h2 className="sr-only" id="host-metrics-heading">
                Host metrics
            </h2>
            {query.error !== null && query.data !== undefined && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={`${systemMetricsFailureMessage(query.error)} Last sample: ${formatDashboardDateTime(query.data.sampledAtMs)}.`}
                />
            )}
            {query.data?.freshness === "stale" && query.error === null && (
                <Alert
                    className="mt-4"
                    message="The latest check failed. Showing the most recent reading, which is no more than 30 seconds old."
                    variant="info"
                />
            )}
            <SystemMetricsCards
                fallback={content}
                intermediateContent={
                    <section aria-labelledby="operational-summaries-heading">
                        <h2 className="sr-only" id="operational-summaries-heading">
                            Operational summaries
                        </h2>
                        <div className="grid gap-4 lg:grid-cols-2">
                            <OverviewEnvironmentCards />
                            <OverviewIncidentsSection />
                            <OverviewReportsSection />
                            <div className="lg:col-span-2">
                                <OverviewTasksSection />
                            </div>
                            <div className="lg:col-span-2">
                                <OverviewJobsSection />
                            </div>
                        </div>
                        <div className="mt-4">
                            <OverviewDomainSection />
                        </div>
                        <div className="mt-4">
                            <BackupOverviewSection />
                        </div>
                    </section>
                }
                leadingCard={
                    <WeatherOverviewCard className="sm:col-span-2 lg:col-span-3 xl:col-span-1 xl:row-span-2" />
                }
                metrics={query.data}
            />
        </section>
    );
}
