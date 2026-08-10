import { queryOptions, type QueryClient } from "@tanstack/react-query";

import {
    logRowMaximum,
    logTailDefaultRows,
    type LogSnapshotOutput,
} from "../../contracts/logs.ts";
import { jobRunDetailQueryKey } from "../jobs/jobQueries.ts";
import type { LogClient } from "./logClient.ts";

export const logQueryRoot = ["logs"] as const;
export const logSourcesQueryKey = [...logQueryRoot, "sources"] as const;
export const logMaintenanceQueryKey = [...logQueryRoot, "maintenance"] as const;

/** Coalescing delay for durable job-run changes that affect maintenance status. */
export const logMaintenanceRealtimeRefreshDelayMs = 100;
/** Fallback refresh after the tracked realtime stream becomes unavailable. */
export const logMaintenanceRealtimeFallbackRefreshIntervalMs = 30_000;
/** Polling cadence for worker availability that changes independently of job events. */
export const logMaintenanceRefreshIntervalMs = 15_000;
/** Browser-selectable row budgets supported by the bounded log contract. */
export const logSnapshotRowOptions = Object.freeze([
    100,
    logTailDefaultRows,
    logRowMaximum,
] as const);

export type LogSnapshotSelection =
    | { readonly limit: number; readonly mode: "tail"; readonly sourceId: string }
    | {
          readonly limit: number;
          readonly mode: "search";
          readonly query: string;
          readonly sourceId: string;
      };

/** @returns Bounded named-source inventory query options. */
export function logSourcesQueryOptions(client: LogClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("logs.listSources", {}, { signal }),
        queryKey: logSourcesQueryKey,
        retry: false,
        staleTime: 10_000,
    });
}

/** @returns Availability for the fixed worker-owned maintenance policies. */
export function logMaintenanceQueryOptions(client: LogClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("logs.maintenanceStatus", {}, { signal }),
        queryKey: logMaintenanceQueryKey,
        refetchInterval: logMaintenanceRefreshIntervalMs,
        refetchIntervalInBackground: false,
        retry: false,
        staleTime: 10_000,
    });
}

/**
 * Invalidates the fixed maintenance projection and an optional requested run.
 * Both refreshes are attempted so one failed observer cannot strand the other.
 * @param queryClient Browser-owned TanStack Query cache.
 * @param runId Exact maintenance run currently followed inline, when present.
 */
export async function refreshLogMaintenanceQueries(
    queryClient: QueryClient,
    runId?: string
): Promise<void> {
    await Promise.allSettled([
        queryClient.invalidateQueries({
            exact: true,
            queryKey: logMaintenanceQueryKey,
        }),
        ...(runId === undefined
            ? []
            : [
                  queryClient.invalidateQueries({
                      exact: true,
                      queryKey: jobRunDetailQueryKey(runId),
                  }),
              ]),
    ]);
}

/** @returns One exact tail/search query with no path-bearing browser input. */
export function logSnapshotQueryOptions(
    client: LogClient,
    selection: LogSnapshotSelection | undefined,
    sourceAvailable: boolean
) {
    return queryOptions<LogSnapshotOutput>({
        enabled: selection !== undefined && sourceAvailable,
        queryFn: ({ signal }) => {
            if (selection === undefined) {
                return Promise.reject(new TypeError("Log source is not selected"));
            }
            return selection.mode === "tail"
                ? client.query(
                      "logs.tail",
                      { limit: selection.limit, sourceId: selection.sourceId },
                      { signal }
                  )
                : client.query(
                      "logs.search",
                      {
                          limit: selection.limit,
                          query: selection.query,
                          sourceId: selection.sourceId,
                      },
                      { signal }
                  );
        },
        queryKey: [
            ...logQueryRoot,
            "snapshot",
            selection?.sourceId ?? null,
            selection?.mode ?? null,
            selection?.mode === "search" ? selection.query : null,
            selection?.limit ?? null,
        ],
        refetchInterval: selection?.mode === "tail" ? 5000 : false,
        refetchIntervalInBackground: false,
        retry: false,
        staleTime: selection?.mode === "tail" ? 2000 : 30_000,
    });
}
