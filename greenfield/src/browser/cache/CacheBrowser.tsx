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
                <PageState label="Loading cache status…" status="loading" />
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
                title="Cache status unavailable"
            />
        );
    } else if (query.data.entries.length === 0 && query.data.totalCount === 0) {
        inventory = (
            <PageState
                description="The initially due provider schedule will seed this inventory after its first attempt."
                headingLevel={3}
                icon={DatabaseZap}
                status="empty"
                title="No cache attempts yet"
            />
        );
    } else if (query.data.entries.length === 0) {
        inventory = (
            <PageState
                headingLevel={3}
                message="The server reports cache entries outside this returned snapshot. Retry to reconcile the bounded inventory."
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Cache snapshot incomplete"
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
                        Cache
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        Last-known-good provider projections and their independent refresh
                        attempt state.
                    </Text>
                </div>
                {query.data !== undefined && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge>
                            {query.data.truncated
                                ? `Showing ${query.data.entries.length} of ${query.data.totalCount}`
                                : `${query.data.totalCount} ${query.data.totalCount === 1 ? "entry" : "entries"}`}
                        </Badge>
                        <Text size="sm" tone="muted">
                            Snapshot {formatDashboardDateTime(query.data.generatedAtMs)}
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
                            description="Choose an entry to load its bounded payload and attempt details."
                            headingLevel={3}
                            icon={DatabaseZap}
                            status="empty"
                            title="Select a cache entry"
                        />
                    ) : (
                        <CacheEntryDetail cacheKey={selectedKey} key={selectedKey} />
                    ))}
            </div>
        </section>
    );
}
