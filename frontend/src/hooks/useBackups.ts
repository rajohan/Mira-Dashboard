import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    parseBackupClearResponse,
    parseBackupRunResponse,
    parseBackupStatusResponse,
} from "../../../contracts/backups";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchParsed, apiPostParsed } from "./useApi";
import { cacheKeys } from "./useCache";
import {
    jobExecutionKeys,
    refreshJobExecutionQueueWhilePending,
} from "./useJobExecutions";
import { scheduledJobKeys } from "./useScheduledJobs";

/** Defines backup keys. */
export const backupKeys = {
    all: ["backups"] as const,
    kopia: () => [...backupKeys.all, "kopia"] as const,
    walg: () => [...backupKeys.all, "walg"] as const,
};

/**
 * Provides kopia backup.
 * @returns The kopia backup.
 */
export function useKopiaBackup() {
    return useQuery({
        queryKey: backupKeys.kopia(),
        queryFn: () => apiFetchParsed("/backups/kopia", parseBackupStatusResponse),
        refetchInterval: (query) => {
            const status = query.state.data?.job?.status;
            return status === "running" ? 1000 : refreshPolicy.active;
        },
        staleTime: 1000,
    });
}

/**
 * Provides walg backup.
 * @returns The walg backup.
 */
export function useWalgBackup() {
    return useQuery({
        queryKey: backupKeys.walg(),
        queryFn: () => apiFetchParsed("/backups/walg", parseBackupStatusResponse),
        refetchInterval: (query) => {
            const status = query.state.data?.job?.status;
            return status === "running" ? 1000 : refreshPolicy.active;
        },
        staleTime: 1000,
    });
}

/**
 * Provides run kopia backup.
 * @returns The run kopia backup.
 */
export function useRunKopiaBackup() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            refreshJobExecutionQueueWhilePending(
                queryClient,
                apiPostParsed("/backups/kopia/run", parseBackupRunResponse)
            ),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKeys.kopia() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("backup.kopia.status"),
                }),
                queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
                queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all }),
                queryClient.invalidateQueries({ queryKey: scheduledJobKeys.list() }),
                queryClient.invalidateQueries({
                    queryKey: scheduledJobKeys.runs("backup.kopia"),
                }),
            ]);
        },
    });
}

/**
 * Provides clear kopia backup attention.
 * @returns The clear kopia backup attention.
 */
export function useClearKopiaBackupAttention() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            refreshJobExecutionQueueWhilePending(
                queryClient,
                apiPostParsed(
                    "/backups/kopia/clear-needs-attention",
                    parseBackupClearResponse
                )
            ),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKeys.kopia() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("backup.kopia.status"),
                }),
                queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all }),
            ]);
        },
    });
}

/**
 * Provides run walg backup.
 * @returns The run walg backup.
 */
export function useRunWalgBackup() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            refreshJobExecutionQueueWhilePending(
                queryClient,
                apiPostParsed("/backups/walg/run", parseBackupRunResponse)
            ),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKeys.walg() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("backup.walg.status"),
                }),
                queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
                queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all }),
                queryClient.invalidateQueries({ queryKey: scheduledJobKeys.list() }),
                queryClient.invalidateQueries({
                    queryKey: scheduledJobKeys.runs("backup.walg"),
                }),
            ]);
        },
    });
}

/**
 * Provides clear walg backup attention.
 * @returns The clear walg backup attention.
 */
export function useClearWalgBackupAttention() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            refreshJobExecutionQueueWhilePending(
                queryClient,
                apiPostParsed(
                    "/backups/walg/clear-needs-attention",
                    parseBackupClearResponse
                )
            ),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKeys.walg() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("backup.walg.status"),
                }),
                queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all }),
            ]);
        },
    });
}
