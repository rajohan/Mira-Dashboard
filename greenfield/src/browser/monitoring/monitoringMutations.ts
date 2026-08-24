import { type InfiniteData, type QueryClient, useMutation } from "@tanstack/react-query";

import type { ListReportsResult } from "../../contracts/reports.ts";
import { liveHistoryArchiveQueryRoot } from "../api/liveHistory.ts";
import type {
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import {
    refreshReportQueries,
    reportDetailQueryKey,
    reportListQueryRoot,
} from "./monitoringQueries.ts";

/**
 * Removes one successfully deleted report from every cached catalog before refetch.
 * @param queryClient Browser cache holding filtered report pages.
 * @param id Deleted immutable report identity.
 */
export function removeReportFromCachedLists(queryClient: QueryClient, id: string): void {
    queryClient.setQueriesData<InfiniteData<ListReportsResult>>(
        {
            predicate: ({ queryKey }) =>
                queryKey[0] === liveHistoryArchiveQueryRoot[0] &&
                reportListQueryRoot.every((part, index) => queryKey[index + 1] === part),
        },
        (data) =>
            data === undefined
                ? undefined
                : {
                      ...data,
                      pages: data.pages.map((page) => ({
                          ...page,
                          reports: page.reports.filter((report) => report.id !== id),
                      })),
                  }
    );
    queryClient.setQueriesData<ListReportsResult>(
        {
            predicate: ({ queryKey }) =>
                reportListQueryRoot.every((part, index) => queryKey[index] === part) &&
                queryKey.at(-1) === "live-head",
        },
        (data) =>
            data === undefined
                ? undefined
                : {
                      ...data,
                      reports: data.reports.filter((report) => report.id !== id),
                  }
    );
}

/**
 * Deletes one report, removes its exact cache entry, and refreshes linked catalogs.
 * @param onDeleted Clears the route selection before the missing detail can refetch.
 * @returns Contract-typed report deletion mutation.
 */
export function useDeleteReportMutation(onDeleted: (id: string) => void) {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<
        DashboardProcedureOutput<"reports.delete">,
        Error,
        DashboardProcedureInput<"reports.delete">
    >({
        mutationFn: (input) =>
            boundary.run((signal) =>
                client.mutation("reports.delete", input, { signal })
            ),
        onSuccess: async (result) => {
            if (!boundary.completionIsCurrent()) return;
            onDeleted(result.id);
            removeReportFromCachedLists(boundary.queryClient, result.id);
            boundary.queryClient.removeQueries({
                exact: true,
                queryKey: reportDetailQueryKey(result.id),
            });
            await refreshReportQueries(boundary.queryClient);
        },
    });
}
