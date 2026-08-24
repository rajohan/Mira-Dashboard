import { queryOptions } from "@tanstack/react-query";

import type { SystemHealthDiagnostics } from "../../contracts/system.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

const systemStatusRefreshIntervalMs = 15_000;
const systemStatusMaximumObservationAgeMs = systemStatusRefreshIntervalMs * 3;

export const dashboardHealthDiagnosticsQueryKey = [
    "system-status",
    "health-diagnostics",
] as const;

export type DashboardSystemComponentState =
    | "offline"
    | "online"
    | "stale"
    | "unavailable";

export interface DashboardSystemStatus {
    readonly backend: DashboardSystemComponentState;
    readonly gateway: DashboardSystemComponentState;
    readonly overall: DashboardSystemComponentState;
    readonly worker: DashboardSystemComponentState;
}

/**
 * @param query Retained-data and fetch state from the health query observer.
 * @returns Whether a prior snapshot is no longer backed by a current observation.
 */
export function dashboardHealthSnapshotIsStale(query: {
    readonly dataUpdatedAtMs?: number;
    readonly fetchStatus: "fetching" | "idle" | "paused";
    readonly hasData: boolean;
    readonly isError: boolean;
    readonly nowMs?: number;
}): boolean {
    const observationExpired =
        query.dataUpdatedAtMs !== undefined &&
        query.fetchStatus === "idle" &&
        (query.nowMs ?? Date.now()) - query.dataUpdatedAtMs >
            systemStatusMaximumObservationAgeMs;
    return (
        query.hasData &&
        (query.isError || query.fetchStatus === "paused" || observationExpired)
    );
}

/**
 * @param client Validated Dashboard transport client.
 * @returns Session-only bounded health diagnostics query options for the header.
 */
export function dashboardHealthDiagnosticsQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<SystemHealthDiagnostics> =>
            client.query("system.healthDiagnostics", {}, { signal }),
        queryKey: dashboardHealthDiagnosticsQueryKey,
        refetchInterval: systemStatusRefreshIntervalMs,
        refetchIntervalInBackground: false,
        retry: false,
        staleTime: systemStatusRefreshIntervalMs,
    });
}

function overallSystemState(
    states: readonly DashboardSystemComponentState[]
): DashboardSystemComponentState {
    if (states.some((state) => state === "offline")) return "offline";
    if (states.every((state) => state === "online")) return "online";
    if (
        states.every((state) => state === "online" || state === "stale") &&
        states.some((state) => state === "stale")
    ) {
        return "stale";
    }
    return "unavailable";
}

function staleState(
    state: DashboardSystemComponentState,
    stale: boolean
): DashboardSystemComponentState {
    return stale && state === "online" ? "stale" : state;
}

function gatewayState(
    diagnostics: SystemHealthDiagnostics | undefined
): DashboardSystemComponentState {
    const gateway = diagnostics?.dependencies.gateway;
    if (gateway === undefined || gateway.status === "unavailable") {
        return "unavailable";
    }
    return gateway.phase === "connected" && gateway.freshness === "fresh"
        ? "online"
        : "offline";
}

function workerState(
    diagnostics: SystemHealthDiagnostics | undefined
): DashboardSystemComponentState {
    if (diagnostics === undefined) return "unavailable";
    if (
        diagnostics.checks.worker.status === "unavailable" ||
        diagnostics.queue.status === "unavailable"
    ) {
        return "unavailable";
    }
    return diagnostics.checks.worker.status === "ready" ? "online" : "offline";
}

function backendState(
    diagnostics: SystemHealthDiagnostics | undefined
): DashboardSystemComponentState {
    if (diagnostics === undefined) return "unavailable";
    const checks = diagnostics.checks;
    if (
        checks.database.status === "unavailable" ||
        checks.frontend.status === "unavailable" ||
        checks.release.status === "unavailable"
    ) {
        return "unavailable";
    }
    return checks.application.status === "ready" ? "online" : "offline";
}

/**
 * Projects only directly observed backend, worker, and Gateway availability.
 * @param diagnostics Current bounded diagnostic snapshot, when observed.
 * @param stale Whether the retained snapshot survived a failed background refresh.
 * @returns Honest aggregate without treating a missing observation as healthy.
 */
export function projectDashboardSystemStatus(
    diagnostics: SystemHealthDiagnostics | undefined,
    stale = false
): DashboardSystemStatus {
    const backend = staleState(backendState(diagnostics), stale);
    const gateway = staleState(gatewayState(diagnostics), stale);
    const worker = staleState(workerState(diagnostics), stale);
    return {
        backend,
        gateway,
        overall: overallSystemState([backend, gateway, worker]),
        worker,
    };
}
