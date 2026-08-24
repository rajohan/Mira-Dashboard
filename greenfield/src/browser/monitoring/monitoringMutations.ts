import {
    type InfiniteData,
    type QueryClient,
    useMutation,
    useQueryClient,
} from "@tanstack/react-query";

import type { ListReportsResult } from "../../contracts/reports.ts";
import type {
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
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
        { queryKey: reportListQueryRoot },
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
}

/**
 * Deletes one report, removes its exact cache entry, and refreshes linked catalogs.
 * @param onDeleted Clears the route selection before the missing detail can refetch.
 * @returns Contract-typed report deletion mutation.
 */
export function useDeleteReportMutation(onDeleted: () => void) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    return useMutation<
        DashboardProcedureOutput<"reports.delete">,
        Error,
        DashboardProcedureInput<"reports.delete">
    >({
        mutationFn: (input) => client.mutation("reports.delete", input),
        onSuccess: async (result) => {
            onDeleted();
            removeReportFromCachedLists(queryClient, result.id);
            queryClient.removeQueries({
                exact: true,
                queryKey: reportDetailQueryKey(result.id),
            });
            await refreshReportQueries(queryClient);
        },
    });
}
