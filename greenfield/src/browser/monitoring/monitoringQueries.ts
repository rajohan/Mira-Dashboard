import {
    infiniteQueryOptions,
    queryOptions,
    type QueryClient,
} from "@tanstack/react-query";

import type {
    ListIncidentsInput,
    ListIncidentsResult,
} from "../../contracts/incidents.ts";
import type { ListReportsInput, ListReportsResult } from "../../contracts/reports.ts";
import {
    liveHistoryArchiveQueryKey,
    liveHistoryHeadQueryKey,
} from "../api/liveHistory.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

type IncidentCursor = NonNullable<ListIncidentsInput["cursor"]>;
type ReportCursor = NonNullable<ListReportsInput["cursor"]>;

export const monitoringQueryKey = ["monitoring"] as const;
export const incidentQueryKey = [...monitoringQueryKey, "incidents"] as const;
export const incidentListQueryRoot = [...incidentQueryKey, "list"] as const;
export const incidentOverviewQueryKey = [...incidentListQueryRoot, "overview"] as const;
export const reportQueryKey = [...monitoringQueryKey, "reports"] as const;
export const reportListQueryRoot = [...reportQueryKey, "list"] as const;
export const reportOverviewQueryKey = [...reportQueryKey, "overview"] as const;
/** Bounded newest-first report window shared by list and overview surfaces. */
export const reportListPageSize = 50;
/** Compact newest-active window rendered on the operational overview. */
export const incidentOverviewPageSize = 12;

const incidentOverviewFilters = Object.freeze({
    states: ["active"],
} as const satisfies NonNullable<ListIncidentsInput["filters"]>);

/**
 * Removes repeated identities while preserving the first, newest-page occurrence.
 * @param values Catalog rows from all currently loaded pages.
 * @returns Stable catalog rows after overlapping page or realtime refresh responses.
 */
export function uniqueMonitoringRows<TValue extends { readonly id: string }>(
    values: readonly TValue[]
): TValue[] {
    const identities = new Set<string>();
    return values.filter(({ id }) => {
        if (identities.has(id)) return false;
        identities.add(id);
        return true;
    });
}

/**
 * @param filters Server-owned incident filters.
 * @returns Stable key for one filtered incident catalog.
 */
export function incidentListQueryKey(filters: ListIncidentsInput["filters"]) {
    return [...incidentListQueryRoot, filters ?? null] as const;
}

/**
 * @param id Exact incident identity.
 * @returns Stable key for one exact incident record.
 */
export function incidentDetailQueryKey(id: string) {
    return [...incidentQueryKey, "detail", id] as const;
}

/**
 * @param filters Server-owned report filters.
 * @returns Stable key for one filtered report catalog.
 */
export function reportListQueryKey(filters: ListReportsInput["filters"]) {
    return [...reportListQueryRoot, filters ?? null] as const;
}

/**
 * @param id Exact report identity.
 * @returns Stable key for one exact report document.
 */
export function reportDetailQueryKey(id: string) {
    return [...reportQueryKey, "detail", id] as const;
}

/**
 * @param client Validated browser tRPC client.
 * @param filters Server-owned incident filters.
 * @returns Cursor-paginated incident query options.
 */
export function incidentListQueryOptions(
    client: DashboardTrpcClient,
    filters: ListIncidentsInput["filters"]
) {
    return infiniteQueryOptions({
        initialPageParam: undefined as IncidentCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListIncidentsResult> =>
            client.query(
                "incidents.list",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    ...(filters === undefined ? {} : { filters }),
                    limit: 50,
                },
                { signal }
            ),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: liveHistoryArchiveQueryKey(incidentListQueryKey(filters)),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** @returns Live first-page incident projection for one server-owned filter. */
export function incidentLiveHeadQueryOptions(
    client: DashboardTrpcClient,
    filters: ListIncidentsInput["filters"]
) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListIncidentsResult> =>
            client.query(
                "incidents.list",
                { ...(filters === undefined ? {} : { filters }), limit: 50 },
                { signal }
            ),
        queryKey: liveHistoryHeadQueryKey(incidentListQueryKey(filters)),
        staleTime: 10_000,
    });
}

/**
 * Loads one isolated newest-active incident window for the root overview.
 * @param client Validated browser tRPC client.
 * @returns Bounded persisted active-incident overview options.
 */
export function incidentOverviewQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListIncidentsResult> =>
            client.query(
                "incidents.list",
                {
                    filters: incidentOverviewFilters,
                    limit: incidentOverviewPageSize,
                },
                { signal }
            ),
        queryKey: incidentOverviewQueryKey,
        staleTime: 10_000,
    });
}

/**
 * @param client Validated browser tRPC client.
 * @param id Exact incident identity.
 * @returns Exact incident-detail query options.
 */
export function incidentDetailQueryOptions(client: DashboardTrpcClient, id: string) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("incidents.get", { id }, { signal }),
        queryKey: incidentDetailQueryKey(id),
        staleTime: 10_000,
    });
}

/**
 * @param client Validated browser tRPC client.
 * @returns One isolated newest-report page for the root overview.
 */
export function reportOverviewQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListReportsResult> =>
            client.query("reports.list", { limit: reportListPageSize }, { signal }),
        queryKey: reportOverviewQueryKey,
        staleTime: 10_000,
    });
}

/**
 * @param client Validated browser tRPC client.
 * @param filters Server-owned report filters.
 * @returns Cursor-paginated report query options.
 */
export function reportListQueryOptions(
    client: DashboardTrpcClient,
    filters: ListReportsInput["filters"]
) {
    return infiniteQueryOptions({
        initialPageParam: undefined as ReportCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListReportsResult> =>
            client.query(
                "reports.list",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    ...(filters === undefined ? {} : { filters }),
                    limit: reportListPageSize,
                },
                { signal }
            ),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: liveHistoryArchiveQueryKey(reportListQueryKey(filters)),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** @returns Live first-page report projection for one server-owned filter. */
export function reportLiveHeadQueryOptions(
    client: DashboardTrpcClient,
    filters: ListReportsInput["filters"]
) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListReportsResult> =>
            client.query(
                "reports.list",
                {
                    ...(filters === undefined ? {} : { filters }),
                    limit: reportListPageSize,
                },
                { signal }
            ),
        queryKey: liveHistoryHeadQueryKey(reportListQueryKey(filters)),
        staleTime: 10_000,
    });
}

/**
 * @param client Validated browser tRPC client.
 * @param id Exact report identity.
 * @returns Exact report-detail query options.
 */
export function reportDetailQueryOptions(client: DashboardTrpcClient, id: string) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("reports.get", { id }, { signal }),
        queryKey: reportDetailQueryKey(id),
        staleTime: 10_000,
    });
}

/** @param queryClient Browser cache to invalidate after one durable incident event. */
export async function refreshIncidentQueries(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: incidentQueryKey });
}

/** @param queryClient Browser cache to invalidate after one durable report event. */
export async function refreshReportQueries(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: reportQueryKey });
}
