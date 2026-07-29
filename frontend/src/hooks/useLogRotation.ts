import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    parseLogRotationRunResult,
    parseLogRotationStatus,
} from "../../../contracts/logRotation";
import { apiFetchParsed, apiPostParsed } from "./useApi";
import { cacheKeys } from "./useCache";

/** Defines log rotation keys. */
export const logRotationKeys = {
    status: ["ops", "log-rotation", "status"] as const,
};

/**
 * Provides log rotation status.
 * @param refreshInterval Refresh interval value.
 * @returns The log rotation status.
 */
export function useLogRotationStatus(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: logRotationKeys.status,
        queryFn: () => apiFetchParsed("/ops/log-rotation/status", parseLogRotationStatus),
        refetchInterval: refreshInterval,
        staleTime: 2000,
    });
}

/**
 * Provides run log rotation dry run.
 * @returns The run log rotation dry run.
 */
export function useRunLogRotationDryRun() {
    return useMutation({
        mutationFn: () =>
            apiPostParsed("/ops/log-rotation/dry-run", parseLogRotationRunResult),
    });
}

/**
 * Provides run log rotation now.
 * @returns The run log rotation now.
 */
export function useRunLogRotationNow() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPostParsed("/ops/log-rotation/run", parseLogRotationRunResult),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: logRotationKeys.status }),
                queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("log_rotation.state"),
                }),
            ]);
        },
    });
}
