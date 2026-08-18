import { useInfiniteQuery, infiniteQueryOptions } from "@tanstack/react-query";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { RefreshCw, ScrollText } from "lucide-react";
import { useRef, type ReactNode, type UIEvent } from "react";

import type {
    ListSecurityAuditEventsInput,
    ListSecurityAuditEventsResult,
    SecurityAuditEventSummary,
} from "../../contracts/securityAudit.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { formatDashboardDateTimeParts } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { DataTable } from "../ui/DataTable.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Virtualizer } from "../ui/Virtualizer.tsx";
import { securityAuditQueryKey } from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

type SecurityAuditCursor = NonNullable<ListSecurityAuditEventsInput["cursor"]>;

const emptyAuditEvents: readonly SecurityAuditEventSummary[] = Object.freeze([]);
const minimumVirtualizedAuditRows = 50;

const auditTableFeatures = tableFeatures({});
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
    }),
    auditColumnHelper.accessor((event) => actorLabel(event.actor), {
        cell: ({ getValue }) => (
            <span className="text-primary-300 break-all">{getValue()}</span>
        ),
        header: "Who",
        id: "actor",
    }),
    auditColumnHelper.accessor((event) => targetLabel(event.target), {
        cell: ({ getValue }) => (
            <span className="text-primary-300 break-all">{getValue()}</span>
        ),
        header: "Affected item",
        id: "target",
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
    }),
    auditColumnHelper.accessor((event) => metadataLabel(event.metadata), {
        cell: ({ getValue }) => (
            <span className="text-primary-400 break-all">{getValue()}</span>
        ),
        header: "Details",
        id: "metadata",
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
    const loadRequestedRef = useRef(false);
    const table = useTable({
        columns: auditColumns,
        data: events,
        features: auditTableFeatures,
        getRowId: (event) => event.id,
    });
    const rows = table.getRowModel().rows;

    function loadMoreNearBottom(event: UIEvent<HTMLElement>): void {
        if (!loadingMore) loadRequestedRef.current = false;
        if (
            !hasMore ||
            loadMoreError !== undefined ||
            loadingMore ||
            loadRequestedRef.current
        ) {
            return;
        }
        const container = event.currentTarget;
        if (
            container.scrollHeight - container.scrollTop - container.clientHeight <=
            320
        ) {
            loadRequestedRef.current = true;
            onLoadMore();
        }
    }

    let footer: ReactNode;
    if (loadingMore) {
        footer = (
            <LoadingState className="min-h-16" label="Loading older events…" size="sm" />
        );
    } else if (loadMoreError !== undefined) {
        footer = (
            <div className="p-3">
                <Alert message={loadMoreError} />
                <Button
                    className="mt-3"
                    onClick={onLoadMore}
                    size="sm"
                    variant="secondary"
                >
                    <Icon icon={RefreshCw} size="sm" tone="inherit" />
                    Try again
                </Button>
            </div>
        );
    } else if (hasMore && rows.length < minimumVirtualizedAuditRows) {
        footer = (
            <div className="p-3">
                <Button onClick={onLoadMore} size="sm" variant="secondary">
                    Load older events
                </Button>
            </div>
        );
    }

    if (rows.length < minimumVirtualizedAuditRows) {
        return (
            <DataTable
                columnWidths={auditColumnWidths}
                footer={footer}
                label="Security audit events"
                table={table}
                tableClassName={auditTableClassName}
            />
        );
    }

    return (
        <Virtualizer<HTMLTableRowElement>
            count={rows.length}
            estimateSize={() => 86}
            getItemKey={(index) => rows[index]?.id ?? `missing-audit-row-${index}`}
        >
            {(virtualization) => (
                <DataTable
                    columnWidths={auditColumnWidths}
                    footer={footer}
                    label="Security audit events"
                    onScroll={loadMoreNearBottom}
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
            queryKey: securityAuditQueryKey,
            retry: false,
            staleTime: 0,
        })
    );
    const auditEvents =
        events.data?.pages.flatMap((page) => page.events) ?? emptyAuditEvents;

    return (
        <SecuritySection
            description="A read-only history of security changes. Sensitive details are hidden."
            id="security-audit-heading"
            icon={ScrollText}
            title="Security audit"
        >
            {events.isPending && (
                <LoadingState label="Loading security events…" size="sm" />
            )}
            {events.isError && auditEvents.length === 0 && (
                <div>
                    <Alert message={dashboardBrowserFailureMessage(events.error)} />
                    <Button
                        className="mt-3"
                        onClick={() => void events.refetch()}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" tone="inherit" />
                        Try again
                    </Button>
                </div>
            )}
            {events.isSuccess && auditEvents.length === 0 && (
                <EmptyState
                    description="Security events will appear here after account or access settings change."
                    icon={ScrollText}
                    title="No security events"
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
