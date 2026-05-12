import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost } from "./useApi";

/** Describes log rotation summary. */
export interface LogRotationSummary {
    ok: boolean;
    dryRun: boolean;
    startedAt: string;
    finishedAt: string | null;
    checkedGroups: number;
    checkedFiles: number;
    rotatedFiles: number;
    compressedFiles: number;
    deletedArchives: number;
    skippedFiles: number;
    warnings: unknown[];
    errors: unknown[];
    groups: Array<{
        name: string;
        checkedFiles: number;
        rotatedFiles: number;
        compressedFiles: number;
        deletedArchives: number;
        skippedFiles: number;
    }>;
}

/** Describes log rotation run result. */
export interface LogRotationRunResult {
    success: boolean;
    result: LogRotationSummary;
    stderr: string;
}

/** Describes log rotation status. */
export interface LogRotationStatus {
    success: boolean;
    lastRun: LogRotationSummary | null;
}

/** Stores log rotation keys. */
export const logRotationKeys = {
    status: ["ops", "log-rotation", "status"] as const,
};

/** Handles use log rotation status. */
export function useLogRotationStatus(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: logRotationKeys.status,
        queryFn: () => apiFetch<LogRotationStatus>("/ops/log-rotation/status"),
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}

/** Handles use run log rotation dry run. */
export function useRunLogRotationDryRun() {
    return useMutation({
        mutationFn: () => apiPost<LogRotationRunResult>("/ops/log-rotation/dry-run"),
    });
}

/** Handles use run log rotation now. */
export function useRunLogRotationNow() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => apiPost<LogRotationRunResult>("/ops/log-rotation/run"),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: logRotationKeys.status });
        },
    });
}
