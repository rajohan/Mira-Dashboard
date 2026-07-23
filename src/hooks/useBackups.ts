import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetchRequired, apiPostRequired } from "./useApi";
import { cacheKeys } from "./useCache";

/** Represents backup job. */
export interface BackupJob {
    id: string;
    type: "kopia" | "walg";
    status: "running" | "done" | "needs_attention" | "failed" | "cancelled";
    code: number | undefined;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | undefined;
}

/** Represents the kopia backup API response. */
interface KopiaBackupResponse {
    job: BackupJob | undefined;
}

/** Defines backup keys. */
export const backupKeys = {
    all: ["backups"] as const,
    kopia: () => [...backupKeys.all, "kopia"] as const,
    walg: () => [...backupKeys.all, "walg"] as const,
};

/** Provides kopia backup. */
export function useKopiaBackup() {
    return useQuery({
        queryKey: backupKeys.kopia(),
        queryFn: () => apiFetchRequired<KopiaBackupResponse>("/backups/kopia"),
        refetchInterval: (query) => {
            const status = query.state.data?.job?.status;
            return status === "running" ? 1000 : 5000;
        },
        staleTime: 1000,
    });
}

/** Provides walg backup. */
export function useWalgBackup() {
    return useQuery({
        queryKey: backupKeys.walg(),
        queryFn: () => apiFetchRequired<KopiaBackupResponse>("/backups/walg"),
        refetchInterval: (query) => {
            const status = query.state.data?.job?.status;
            return status === "running" ? 1000 : 5000;
        },
        staleTime: 1000,
    });
}

/** Provides run kopia backup. */
export function useRunKopiaBackup() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPostRequired<{ isOk: boolean; job: BackupJob }>("/backups/kopia/run"),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKeys.kopia() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("backup.kopia.status"),
                }),
                queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
            ]);
        },
    });
}

/** Provides clear kopia backup attention. */
export function useClearKopiaBackupAttention() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPostRequired<{ isOk: boolean; cleared: BackupJob }>(
                "/backups/kopia/clear-needs-attention"
            ),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKeys.kopia() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("backup.kopia.status"),
                }),
            ]);
        },
    });
}

/** Provides run walg backup. */
export function useRunWalgBackup() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPostRequired<{ isOk: boolean; job: BackupJob }>("/backups/walg/run"),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKeys.walg() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("backup.walg.status"),
                }),
                queryClient.invalidateQueries({ queryKey: cacheKeys.heartbeat() }),
            ]);
        },
    });
}

/** Provides clear walg backup attention. */
export function useClearWalgBackupAttention() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPostRequired<{ isOk: boolean; cleared: BackupJob }>(
                "/backups/walg/clear-needs-attention"
            ),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKeys.walg() }),
                queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry("backup.walg.status"),
                }),
            ]);
        },
    });
}
