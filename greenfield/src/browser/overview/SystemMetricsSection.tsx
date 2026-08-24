import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
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
            <Card>
                <PageState label="Loading system usage…" status="loading" />
            </Card>
        );
    } else if (query.data === undefined) {
        content = (
            <PageState
                headingLevel={3}
                message={systemMetricsFailureMessage(query.error)}
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="System usage unavailable"
            />
        );
    } else {
        content = <SystemMetricsCards metrics={query.data} />;
    }

    return (
        <section aria-labelledby="system-metrics-heading">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <Heading id="system-metrics-heading" level={2}>
                        System usage
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        Current host gauges and independently available application
                        runtime observations.
                    </Text>
                </div>
                {query.data !== undefined && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge
                            variant={
                                query.data.freshness === "fresh" ? "success" : "warning"
                            }
                        >
                            {query.data.freshness === "fresh"
                                ? "Up to date"
                                : "Out of date"}
                        </Badge>
                        <Text size="sm" tone="muted">
                            Measured {formatDashboardDateTime(query.data.sampledAtMs)}
                        </Text>
                    </div>
                )}
            </div>
            {query.error !== null && query.data !== undefined && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={systemMetricsFailureMessage(query.error)}
                />
            )}
            {query.data?.freshness === "stale" && query.error === null && (
                <Alert
                    className="mt-4"
                    message="The latest check failed. Showing the most recent reading, which is no more than 30 seconds old."
                    variant="info"
                />
            )}
            <div className="mt-5">{content}</div>
        </section>
    );
}
