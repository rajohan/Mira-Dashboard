import { useQuery } from "@tanstack/react-query";
import { DatabaseZap } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import { CacheEntryDetail } from "./CacheEntryDetail.tsx";
import { cacheBrowserFailureMessage } from "./cachePresentation.ts";
import { cacheStatusQueryOptions } from "./cacheQueries.ts";
import { CacheStatusTable } from "./CacheStatusTable.tsx";
import { useCacheRealtimeInvalidation } from "./useCacheRealtimeInvalidation.ts";

/** @returns Bounded cache inventory, exact lazy detail, and realtime refresh behavior. */
export function CacheBrowser() {
    useCacheRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const query = useQuery(cacheStatusQueryOptions(client));
    const [selectedKey, setSelectedKey] = useState<string>();
    const hasSelectableEntries = (query.data?.entries.length ?? 0) > 0;
    let inventory: ReactNode;

    if (query.isPending && query.data === undefined) {
        inventory = (
            <Card className="min-w-0">
                <PageState label="Loading saved data…" status="loading" />
            </Card>
        );
    } else if (query.data === undefined) {
        inventory = (
            <PageState
                headingLevel={3}
                message={cacheBrowserFailureMessage(query.error)}
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Saved data unavailable"
            />
        );
    } else if (query.data.entries.length === 0 && query.data.totalCount === 0) {
        inventory = (
            <PageState
                description="Data appears after each source completes its first check."
                headingLevel={3}
                icon={DatabaseZap}
                status="empty"
                title="No saved data yet"
            />
        );
    } else if (query.data.entries.length === 0) {
        inventory = (
            <PageState
                headingLevel={3}
                message="The server reported more entries than it returned. Try again to load the list."
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Saved data list incomplete"
            />
        );
    } else {
        inventory = (
            <Card className="min-w-0">
                <CacheStatusTable
                    entries={query.data.entries}
                    onSelect={setSelectedKey}
                    selectedKey={selectedKey}
                />
            </Card>
        );
    }

    return (
        <section aria-labelledby="cache-browser-heading">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <Heading id="cache-browser-heading" level={2}>
                        Saved system data
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        Saved results from background checks and the latest refresh
                        status.
                    </Text>
                </div>
                {query.data !== undefined && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge>
                            {query.data.truncated
                                ? `Showing ${query.data.entries.length} of ${query.data.totalCount}`
                                : `${query.data.totalCount} ${query.data.totalCount === 1 ? "source" : "sources"}`}
                        </Badge>
                        <Text size="sm" tone="muted">
                            Checked {formatDashboardDateTime(query.data.generatedAtMs)}
                        </Text>
                    </div>
                )}
            </div>
            {query.error !== null && query.data !== undefined && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={cacheBrowserFailureMessage(query.error)}
                />
            )}
            <div
                className={cn(
                    "mt-5 grid grid-cols-1 gap-5",
                    hasSelectableEntries &&
                        "xl:grid-cols-[minmax(32rem,1.2fr)_minmax(24rem,1fr)]"
                )}
            >
                {inventory}
                {hasSelectableEntries &&
                    (selectedKey === undefined ? (
                        <PageState
                            description="Choose a data source to view its saved result and latest refresh details."
                            headingLevel={3}
                            icon={DatabaseZap}
                            status="empty"
                            title="Select a data source"
                        />
                    ) : (
                        <CacheEntryDetail cacheKey={selectedKey} key={selectedKey} />
                    ))}
            </div>
        </section>
    );
}
