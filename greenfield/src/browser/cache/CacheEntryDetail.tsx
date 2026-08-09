import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DatabaseZap, RefreshCw } from "lucide-react";
import { useEffect } from "react";

import type { CacheEntry } from "../../contracts/cache.ts";
import type { JobRunState } from "../../contracts/jobModel.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { buttonClassNames } from "../ui/buttonStyles.ts";
import { Card } from "../ui/Card.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import { useRefreshCacheEntryMutation } from "./cacheMutations.ts";
import {
    cacheAttemptVariant,
    cacheBrowserFailureMessage,
    cacheAttemptLabel,
    cacheFreshnessLabel,
    cacheFreshnessVariant,
    formatCacheDuration,
} from "./cachePresentation.ts";
import { cacheEntryQueryOptions } from "./cacheQueries.ts";
import { SystemHostCard } from "./SystemHostCard.tsx";

interface CacheTimestampProps {
    readonly label: string;
    readonly value?: number;
}

function CacheTimestamp({ label, value }: CacheTimestampProps) {
    return (
        <div>
            <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                {label}
            </dt>
            <dd className="text-primary-100 mt-1 text-sm">
                {value === undefined ? (
                    "—"
                ) : (
                    <time dateTime={new Date(value).toISOString()}>
                        {formatDashboardDateTime(value)}
                    </time>
                )}
            </dd>
        </div>
    );
}

function CacheProjection({ entry }: { readonly entry: CacheEntry }) {
    if (entry.payload === undefined) {
        return (
            <EmptyState
                description="The latest refresh has not produced saved data yet."
                headingLevel={3}
                icon={DatabaseZap}
                title="No saved data"
            />
        );
    }
    if (entry.key === "system.host") return <SystemHostCard entry={entry} />;
    return (
        <Card>
            <Heading level={3}>Saved data available</Heading>
            <Text className="mt-2" tone="muted">
                This data source does not have a Dashboard viewer yet. The saved data
                remains on the server and is not shown here.
            </Text>
        </Card>
    );
}

interface CacheEntryDetailProps {
    readonly cacheKey: string;
}

function cacheRefreshRunFeedback(state: JobRunState): {
    readonly message: string;
    readonly variant: "error" | "info" | "success";
} {
    switch (state) {
        case "queued": {
            return {
                message:
                    "Refresh requested. Saved data updates when the background job finishes.",
                variant: "info",
            };
        }
        case "running": {
            return {
                message:
                    "The refresh is running. This page will update when it finishes.",
                variant: "info",
            };
        }
        case "succeeded": {
            return {
                message: "The refresh finished. The latest saved data is loading now.",
                variant: "success",
            };
        }
        case "cancelled": {
            return {
                message:
                    "The refresh was cancelled. Open the background job for details.",
                variant: "error",
            };
        }
        case "failed": {
            return {
                message: "The refresh failed. Open the background job for details.",
                variant: "error",
            };
        }
        case "timed-out": {
            return {
                message:
                    "The refresh took too long. Open the background job for details.",
                variant: "error",
            };
        }
    }
}

/** @returns One exact cache entry, reviewed payload projection, and refresh-run control. */
export function CacheEntryDetail({ cacheKey }: CacheEntryDetailProps) {
    const client = useDashboardTrpcClient();
    const detail = useQuery(cacheEntryQueryOptions(client, cacheKey));
    const refresh = useRefreshCacheEntryMutation();
    const detailKey = detail.data?.key;
    const detailRunId = detail.data?.lastAttemptRunId;
    const refreshKey = refresh.variables?.key;
    const refreshRunId = refresh.data?.id;
    const resetRefresh = refresh.reset;

    useEffect(() => {
        if (
            detailKey === refreshKey &&
            detailRunId !== undefined &&
            detailRunId === refreshRunId
        ) {
            resetRefresh();
        }
    }, [detailKey, detailRunId, refreshKey, refreshRunId, resetRefresh]);

    if (detail.isPending && detail.data === undefined) {
        return (
            <Card className="min-w-0">
                <PageState label="Loading saved data…" status="loading" />
            </Card>
        );
    }
    if (detail.data === undefined) {
        return (
            <PageState
                headingLevel={3}
                message={cacheBrowserFailureMessage(detail.error)}
                onRetry={() => void detail.refetch()}
                retryBusy={detail.isFetching}
                status="error"
                title="Saved data unavailable"
            />
        );
    }

    const entry = detail.data;
    const refreshRun =
        refresh.variables?.key === entry.key &&
        refresh.data?.id !== entry.lastAttemptRunId
            ? refresh.data
            : undefined;
    const refreshRunFeedback =
        refreshRun === undefined ? undefined : cacheRefreshRunFeedback(refreshRun.state);
    return (
        <section aria-labelledby="cache-entry-detail-heading" className="min-w-0">
            <Card>
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <Text size="sm" tone="muted">
                            Data source
                        </Text>
                        <Heading
                            className="mt-1 font-mono wrap-break-word"
                            id="cache-entry-detail-heading"
                            level={2}
                        >
                            {entry.key}
                        </Heading>
                        <Text className="mt-2 wrap-break-word" tone="muted">
                            {entry.source ?? "Source unavailable"} ·{" "}
                            {entry.schemaId ?? "Format unavailable"}
                        </Text>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={cacheFreshnessVariant(entry.freshness)}>
                            {cacheFreshnessLabel(entry.freshness)}
                        </Badge>
                        <Badge variant={cacheAttemptVariant(entry.lastAttemptStatus)}>
                            Last refresh {cacheAttemptLabel(entry.lastAttemptStatus)}
                        </Badge>
                    </div>
                </div>
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={
                        detail.error === null
                            ? undefined
                            : cacheBrowserFailureMessage(detail.error)
                    }
                />
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={entry.failureMessage}
                />
                <Alert className="mt-4" message={refresh.failureMessage} />
                {refreshRunFeedback !== undefined && (
                    <Alert
                        className="mt-4"
                        focusOnError={false}
                        message={refreshRunFeedback.message}
                        variant={refreshRunFeedback.variant}
                    />
                )}
                <dl className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    <CacheTimestamp label="Last attempt" value={entry.lastAttemptAtMs} />
                    <CacheTimestamp label="Last success" value={entry.lastSuccessAtMs} />
                    <CacheTimestamp label="Expires" value={entry.expiresAtMs} />
                    <div>
                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                            Latest attempt
                        </dt>
                        <dd className="text-primary-100 mt-1 text-sm">
                            #{entry.lastAttemptNumber} ·{" "}
                            {formatCacheDuration(entry.lastAttemptDurationMs)}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                            Consecutive failures
                        </dt>
                        <dd className="text-primary-100 mt-1 text-sm tabular-nums">
                            {entry.consecutiveFailures}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                            Background job
                        </dt>
                        <dd className="mt-1 text-sm">
                            <Link
                                className="text-accent-300 hover:text-accent-200 font-mono wrap-break-word"
                                search={{ runId: entry.lastAttemptRunId }}
                                to="/jobs"
                            >
                                {entry.lastAttemptRunId}
                            </Link>
                        </dd>
                    </div>
                </dl>
                <div className="border-primary-700 mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
                    {entry.manualRunAvailable ? (
                        <Button
                            busy={refresh.isPending}
                            busyLabel="Starting refresh…"
                            onClick={() => refresh.mutate({ key: entry.key })}
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            {refresh.hasPendingRequest(entry.key)
                                ? "Try refresh again"
                                : "Refresh now"}
                        </Button>
                    ) : (
                        <Text tone="muted">Manual refresh is unavailable.</Text>
                    )}
                    {refreshRun !== undefined && (
                        <Link
                            className={buttonClassNames({
                                size: "sm",
                                variant: "secondary",
                            })}
                            search={{ runId: refreshRun.id }}
                            to="/jobs"
                        >
                            View background job
                        </Link>
                    )}
                </div>
            </Card>
            <div className="mt-5">
                <CacheProjection entry={entry} />
            </div>
        </section>
    );
}
