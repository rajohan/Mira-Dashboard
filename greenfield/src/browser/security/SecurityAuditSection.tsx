import { useInfiniteQuery, infiniteQueryOptions } from "@tanstack/react-query";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { RefreshCw, ScrollText } from "lucide-react";

import type {
    ListSecurityAuditEventsInput,
    ListSecurityAuditEventsResult,
    SecurityAuditEventSummary,
} from "../../contracts/securityAudit.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
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
    if (entries.length === 0) return "No public metadata";
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
        header: "Actor",
        id: "actor",
    }),
    auditColumnHelper.accessor((event) => targetLabel(event.target), {
        cell: ({ getValue }) => (
            <span className="text-primary-300 break-all">{getValue()}</span>
        ),
        header: "Target",
        id: "target",
    }),
    auditColumnHelper.accessor("occurredAtMs", {
        cell: ({ getValue }) => (
            <time
                className="text-primary-400 whitespace-nowrap"
                dateTime={new Date(getValue()).toISOString()}
            >
                {formatDashboardDateTime(getValue())}
            </time>
        ),
        header: "Time",
    }),
    auditColumnHelper.accessor((event) => metadataLabel(event.metadata), {
        cell: ({ getValue }) => (
            <span className="text-primary-400 break-all">{getValue()}</span>
        ),
        header: "Public metadata",
        id: "metadata",
    }),
]);

const auditGridTemplateColumns =
    "minmax(11rem,1.1fr) minmax(11rem,1fr) minmax(13rem,1.2fr) minmax(12rem,1fr) minmax(18rem,1.8fr)";

interface SecurityAuditTableProps {
    readonly events: readonly SecurityAuditEventSummary[];
}

function SecurityAuditTable({ events }: SecurityAuditTableProps) {
    const table = useTable({
        columns: auditColumns,
        data: events,
        features: auditTableFeatures,
        getRowId: (event) => event.id,
    });
    const rows = table.getRowModel().rows;

    if (rows.length < minimumVirtualizedAuditRows) {
        return (
            <DataTable
                gridTemplateColumns={auditGridTemplateColumns}
                label="Security audit events"
                table={table}
                tableClassName="min-w-240"
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
                    gridTemplateColumns={auditGridTemplateColumns}
                    label="Security audit events"
                    rowWindow={virtualization}
                    scrollContainerRef={virtualization.scrollContainerRef}
                    table={table}
                    tableClassName="min-w-240"
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
            description="Newest-first immutable events with a fixed, redacted metadata allowlist."
            id="security-audit-heading"
            title="Security audit"
        >
            {events.isPending && (
                <LoadingState label="Loading security events…" size="sm" />
            )}
            {events.isError && (
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
                    description="Security events will appear here after protected actions occur."
                    icon={ScrollText}
                    title="No security events"
                />
            )}
            {auditEvents.length > 0 && <SecurityAuditTable events={auditEvents} />}
            {events.hasNextPage && (
                <Button
                    busy={events.isFetchingNextPage}
                    busyLabel="Loading…"
                    className="mt-4"
                    onClick={() => void events.fetchNextPage()}
                    variant="secondary"
                >
                    Load older events
                </Button>
            )}
        </SecuritySection>
    );
}
