import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost } from "./useApi";

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

export interface LogRotationRunResult {
    success: boolean;
    result: LogRotationSummary;
    stderr: string;
}

export interface LogRotationStatus {
    success: boolean;
    lastRun: LogRotationSummary | null;
}

export const logRotationKeys = {
    status: ["ops", "log-rotation", "status"] as const,
};

export function useLogRotationStatus(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: logRotationKeys.status,
        queryFn: () => apiFetch<LogRotationStatus>("/ops/log-rotation/status"),
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}

export function useRunLogRotationDryRun() {
    return useMutation({
        mutationFn: () => apiPost<LogRotationRunResult>("/ops/log-rotation/dry-run"),
    });
}

export function useRunLogRotationNow() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => apiPost<LogRotationRunResult>("/ops/log-rotation/run"),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: logRotationKeys.status });
        },
    });
}
