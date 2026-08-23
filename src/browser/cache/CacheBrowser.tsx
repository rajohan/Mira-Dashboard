import { useQuery } from "@tanstack/react-query";
import { DatabaseZap } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { cn } from "../lib/classNames.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageState } from "../ui/PageState.tsx";
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
    const effectiveSelectedKey = query.data?.entries.some(
        ({ key }) => key === selectedKey
    )
        ? selectedKey
        : query.data?.entries[0]?.key;
    const selectedStatus = query.data?.entries.find(
        ({ key }) => key === effectiveSelectedKey
    );
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
                <div className="mb-4 flex items-center gap-2">
                    <Icon icon={DatabaseZap} size="md" tone="accent" />
                    <Heading level={3}>Cache</Heading>
                </div>
                <CacheStatusTable
                    entries={query.data.entries}
                    onSelect={setSelectedKey}
                    selectedKey={effectiveSelectedKey}
                />
            </Card>
        );
    }

    return (
        <section aria-label="Saved data browser">
            {query.error !== null && query.data !== undefined && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={cacheBrowserFailureMessage(query.error)}
                />
            )}
            <div
                className={cn(
                    "grid grid-cols-1 gap-4",
                    hasSelectableEntries &&
                        "xl:grid-cols-[minmax(17rem,0.65fr)_minmax(0,1.35fr)]"
                )}
            >
                {inventory}
                {hasSelectableEntries &&
                    (effectiveSelectedKey === undefined ||
                    selectedStatus === undefined ? (
                        <PageState
                            description="Choose a data source to view its saved result and latest refresh details."
                            headingLevel={3}
                            icon={DatabaseZap}
                            status="empty"
                            title="Select a data source"
                        />
                    ) : (
                        <CacheEntryDetail
                            cacheKey={effectiveSelectedKey}
                            fallbackStatus={selectedStatus}
                            key={effectiveSelectedKey}
                        />
                    ))}
            </div>
        </section>
    );
}
