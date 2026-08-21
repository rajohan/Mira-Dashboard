import { queryOptions } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import {
    dashboardUnavailableReadRetryDelay,
    retryDashboardUnavailableRead,
} from "../api/trpcError.ts";

export const openClawConfigurationQueryKey = [
    "openclaw-settings",
    "configuration",
] as const;
export const openClawSkillsQueryKey = ["openclaw-settings", "skills"] as const;

/** @returns Secret-free OpenClaw configuration query options. */
export function openClawConfigurationQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) =>
            client.query("openClawSettings.getConfiguration", {}, { signal }),
        queryKey: openClawConfigurationQueryKey,
        retry: retryDashboardUnavailableRead,
        retryDelay: dashboardUnavailableReadRetryDelay,
        staleTime: 0,
    });
}

/** @returns Independent path-free OpenClaw skill inventory query options. */
export function openClawSkillsQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) =>
            client.query("openClawSettings.listSkills", {}, { signal }),
        queryKey: openClawSkillsQueryKey,
        retry: retryDashboardUnavailableRead,
        retryDelay: dashboardUnavailableReadRetryDelay,
        staleTime: 0,
    });
}
