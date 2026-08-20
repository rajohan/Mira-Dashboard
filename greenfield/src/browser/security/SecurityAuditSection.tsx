import {
    useInfiniteQuery,
    infiniteQueryOptions,
    queryOptions,
    useQuery,
} from "@tanstack/react-query";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { RefreshCw, ScrollText } from "lucide-react";

import type {
    ListSecurityAuditEventsInput,
    ListSecurityAuditEventsResult,
    SecurityAuditEventSummary,
} from "../../contracts/securityAudit.ts";
import {
    liveHistoryArchiveQueryKey,
    liveHistoryHeadQueryKey,
    liveHistoryRowIdentity,
    useAccumulatedLiveHistoryRows,
} from "../api/liveHistory.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { formatDashboardDateTimeParts } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { dashboardTableFeatures } from "../ui/dashboardTableFeatures.ts";
import { DataTable } from "../ui/DataTable.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { InfiniteScrollTrigger } from "../ui/InfiniteScrollTrigger.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Virtualizer } from "../ui/Virtualizer.tsx";
import { securityAuditQueryKey } from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

type SecurityAuditCursor = NonNullable<ListSecurityAuditEventsInput["cursor"]>;

const emptyAuditEvents: readonly SecurityAuditEventSummary[] = Object.freeze([]);

const auditTableFeatures = dashboardTableFeatures;
const auditTableClassName = "min-w-240 table-fixed";
const auditColumnWidths = Object.freeze({
    action: "17%",
    actor: "20%",
    metadata: "30%",
    occurredAtMs: "13%",
    target: "20%",
});
const auditColumnHelper = createColumnHelper<
    typeof auditTableFeatures,
    SecurityAuditEventSummary
>();

function actorLabel(actor: SecurityAuditEventSummary["actor"]): string {
    return `${actor.kind}:${actor.id}`;
}

function targetLabel(target: SecurityAuditEventSummary["target"]): string {
    return `${target.type}:${target.id}`;
}

function metadataLabel(metadata: SecurityAuditEventSummary["metadata"]): string {
    const entries = Object.entries(metadata);
    if (entries.length === 0) return "No details";
    return entries
        .map(
            ([name, value]) =>
                `${name}=${Array.isArray(value) ? value.join(",") : String(value)}`
        )
        .join(" · ");
}

function outcomeBadgeVariant(
    outcome: SecurityAuditEventSummary["outcome"]
): "danger" | "default" | "success" | "warning" {
    switch (outcome) {
        case "accepted":
        case "succeeded": {
            return "success";
        }
        case "denied":
        case "failed": {
            return "danger";
        }
        case "attempted": {
            return "warning";
        }
        case "cancelled": {
            return "default";
        }
    }
}

const auditColumns = auditColumnHelper.columns([
    auditColumnHelper.accessor("action", {
        cell: ({ getValue, row }) => (
            <div>
                <p className="text-primary-100 font-medium">{getValue()}</p>
                <Badge
                    className="mt-1.5"
                    variant={outcomeBadgeVariant(row.original.outcome)}
                >
                    {row.original.outcome}
                </Badge>
            </div>
        ),
        header: "Event",
        enableSorting: false,
    }),
    auditColumnHelper.accessor((event) => actorLabel(event.actor), {
        cell: ({ getValue }) => (
            <span className="text-primary-300 break-all">{getValue()}</span>
        ),
        header: "Who",
        id: "actor",
        enableSorting: false,
    }),
    auditColumnHelper.accessor((event) => targetLabel(event.target), {
        cell: ({ getValue }) => (
            <span className="text-primary-300 break-all">{getValue()}</span>
        ),
        header: "Affected item",
        id: "target",
        enableSorting: false,
    }),
    auditColumnHelper.accessor("occurredAtMs", {
        cell: ({ getValue }) => {
            const timestampMs = getValue();
            const [date, time] = formatDashboardDateTimeParts(timestampMs);
            return (
                <time
                    className="text-primary-400 flex flex-col whitespace-nowrap @max-[66rem]:flex-row @max-[66rem]:gap-1"
                    dateTime={new Date(timestampMs).toISOString()}
                >
                    <span>{date}</span>
                    <span aria-hidden="true" className="hidden @max-[66rem]:inline">
                        ·
                    </span>
                    <span>{time}</span>
                </time>
            );
        },
        header: "Time",
        enableSorting: false,
    }),
    auditColumnHelper.accessor((event) => metadataLabel(event.metadata), {
        cell: ({ getValue }) => (
            <span className="text-primary-400 break-all">{getValue()}</span>
        ),
        header: "Details",
        id: "metadata",
        enableSorting: false,
    }),
]);

interface SecurityAuditTableProps {
    readonly events: readonly SecurityAuditEventSummary[];
    readonly hasMore: boolean;
    readonly loadMoreError?: string;
    readonly loadingMore: boolean;
    readonly onLoadMore: () => void;
}

function SecurityAuditTable({
    events,
    hasMore,
    loadMoreError,
    loadingMore,
    onLoadMore,
}: SecurityAuditTableProps) {
    const table = useTable({
        columns: auditColumns,
        data: events,
        features: auditTableFeatures,
        getRowId: (event) => event.id,
    });
    const rows = table.getRowModel().rows;

    return (
        <Virtualizer<HTMLTableRowElement>
            count={rows.length}
            estimateSize={() => 86}
            getItemKey={(index) => rows[index]?.id ?? `missing-audit-row-${index}`}
        >
            {(virtualization) => (
                <DataTable
                    columnWidths={auditColumnWidths}
                    footer={
                        <InfiniteScrollTrigger
                            className="p-3"
                            error={loadMoreError}
                            hasMore={hasMore}
                            loading={loadingMore}
                            loadingLabel="Loading older events…"
                            onLoadMore={onLoadMore}
                            rootRef={virtualization.scrollContainerRef}
                        />
                    }
                    label="Security audit events"
                    rowWindow={virtualization}
                    scrollContainerRef={virtualization.scrollContainerRef}
                    table={table}
                    tableClassName={auditTableClassName}
                />
            )}
        </Virtualizer>
    );
}

/**
 * Renders the complete cursor-paginated, redacted security audit history.
 * @returns The immutable audit section.
 */
export function SecurityAuditSection() {
    const client = useDashboardTrpcClient();
    const events = useInfiniteQuery(
        infiniteQueryOptions({
            initialPageParam: undefined as SecurityAuditCursor | undefined,
            queryFn: ({ pageParam, signal }): Promise<ListSecurityAuditEventsResult> =>
                client.query(
                    "securityAudit.listEvents",
                    pageParam === undefined
                        ? { limit: 50 }
                        : { cursor: pageParam, limit: 50 },
                    { signal }
                ),
            getNextPageParam: (lastPage) => lastPage.nextCursor,
            queryKey: liveHistoryArchiveQueryKey(securityAuditQueryKey),
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
        })
    );
    const liveHead = useQuery(
        queryOptions({
            queryFn: ({ signal }): Promise<ListSecurityAuditEventsResult> =>
                client.query("securityAudit.listEvents", { limit: 50 }, { signal }),
            queryKey: liveHistoryHeadQueryKey(securityAuditQueryKey),
            retry: false,
            staleTime: 0,
        })
    );
    const auditEvents = useAccumulatedLiveHistoryRows(
        liveHead.data?.events ?? emptyAuditEvents,
        events.data?.pages.flatMap((page) => page.events) ?? emptyAuditEvents,
        liveHistoryRowIdentity,
        "security-audit"
    );
    const initialError = liveHead.error ?? events.error;

    return (
        <SecuritySection
            description="A read-only history of security changes. Sensitive details are hidden."
            id="security-audit-heading"
            icon={ScrollText}
            title="Security audit"
        >
            {liveHead.isPending && events.isPending && (
                <LoadingState label="Loading security events…" size="sm" />
            )}
            {initialError !== null && auditEvents.length === 0 && (
                <Alert
                    action={
                        <Button
                            onClick={() =>
                                void Promise.allSettled([
                                    liveHead.refetch(),
                                    events.refetch(),
                                ])
                            }
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Try again
                        </Button>
                    }
                    message={dashboardBrowserFailureMessage(initialError)}
                />
            )}
            {liveHead.isSuccess && events.isSuccess && auditEvents.length === 0 && (
                <EmptyState
                    description="Security events will appear here after account or access settings change."
                    icon={ScrollText}
                    title="No security events"
                />
            )}
            {initialError !== null && auditEvents.length > 0 && (
                <Alert
                    action={
                        <Button
                            onClick={() =>
                                void Promise.allSettled([
                                    liveHead.refetch(),
                                    events.refetch(),
                                ])
                            }
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Try again
                        </Button>
                    }
                    message={dashboardBrowserFailureMessage(initialError)}
                />
            )}
            {auditEvents.length > 0 && (
                <SecurityAuditTable
                    events={auditEvents}
                    hasMore={events.hasNextPage}
                    loadMoreError={
                        events.isFetchNextPageError
                            ? dashboardBrowserFailureMessage(events.error)
                            : undefined
                    }
                    loadingMore={events.isFetchingNextPage}
                    onLoadMore={() => void events.fetchNextPage()}
                />
            )}
        </SecuritySection>
    );
}
