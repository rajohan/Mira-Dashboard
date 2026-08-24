import { queryOptions } from "@tanstack/react-query";
import * as v from "valibot";

import type { GatewayConnectionSnapshot } from "../../contracts/gatewayConnection.ts";
import type { JobQueueSummary } from "../../contracts/jobs.ts";
import { readinessStatusSchema } from "../../contracts/system.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

const systemStatusRefreshIntervalMs = 15_000;

export const dashboardReadinessQueryKey = ["system-status", "readiness"] as const;
export const dashboardGatewayConnectionQueryKey = [
    "system-status",
    "gateway-connection",
] as const;

export type DashboardSystemComponentState = "offline" | "online" | "unavailable";

export interface DashboardSystemStatus {
    readonly backend: DashboardSystemComponentState;
    readonly gateway: DashboardSystemComponentState;
    readonly overall: DashboardSystemComponentState;
    readonly worker: DashboardSystemComponentState;
}

/**
 * @param fetcher Injectable same-origin fetch implementation.
 * @returns Bounded same-origin web-process readiness query options.
 */
export function dashboardReadinessQueryOptions(
    fetcher: typeof globalThis.fetch = globalThis.fetch
) {
    return queryOptions({
        queryFn: async ({ signal }) => {
            const response = await fetcher("/api/health/ready", {
                cache: "no-store",
                credentials: "same-origin",
                signal,
            });
            const candidate: unknown = await response.json();
            const parsed = v.safeParse(readinessStatusSchema, candidate);
            if (!parsed.success || (response.status !== 200 && response.status !== 503)) {
                throw new TypeError("Dashboard readiness response is invalid");
            }
            return parsed.output;
        },
        queryKey: dashboardReadinessQueryKey,
        refetchInterval: systemStatusRefreshIntervalMs,
        refetchIntervalInBackground: false,
        retry: false,
        staleTime: systemStatusRefreshIntervalMs,
    });
}

/**
 * @param client Validated Dashboard transport client.
 * @returns Sanitized native Gateway connection query options for the header.
 */
export function dashboardGatewayConnectionQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<GatewayConnectionSnapshot> =>
            client.query("gateway.connection.get", {}, { signal }),
        queryKey: dashboardGatewayConnectionQueryKey,
        refetchInterval: systemStatusRefreshIntervalMs,
        refetchIntervalInBackground: false,
        retry: false,
        staleTime: systemStatusRefreshIntervalMs,
    });
}

function overallSystemState(
    states: readonly DashboardSystemComponentState[]
): DashboardSystemComponentState {
    if (states.every((state) => state === "online")) return "online";
    if (states.some((state) => state === "offline")) return "offline";
    return "unavailable";
}

function observedBooleanState(
    observed: boolean | undefined
): DashboardSystemComponentState {
    if (observed === undefined) return "unavailable";
    return observed ? "online" : "offline";
}

function gatewayState(
    gateway: GatewayConnectionSnapshot | undefined
): DashboardSystemComponentState {
    if (gateway === undefined) return "unavailable";
    return gateway.phase === "connected" && gateway.freshness === "fresh"
        ? "online"
        : "offline";
}

function workerState(
    workerSummary: JobQueueSummary | undefined
): DashboardSystemComponentState {
    if (workerSummary === undefined) return "unavailable";
    return workerSummary.control.claimingPaused ||
        !workerSummary.workers.some(
            ({ state }) => state === "online" || state === "draining"
        )
        ? "offline"
        : "online";
}

/**
 * Projects only directly observed backend, worker, and Gateway availability.
 * @param input Current bounded observations.
 * @returns Honest aggregate without treating a missing observation as healthy.
 */
export function projectDashboardSystemStatus(input: {
    readonly backendReady?: boolean;
    readonly gateway?: GatewayConnectionSnapshot;
    readonly workerSummary?: JobQueueSummary;
}): DashboardSystemStatus {
    const backend = observedBooleanState(input.backendReady);
    const gateway = gatewayState(input.gateway);
    const worker = workerState(input.workerSummary);
    return {
        backend,
        gateway,
        overall: overallSystemState([backend, gateway, worker]),
        worker,
    };
}
