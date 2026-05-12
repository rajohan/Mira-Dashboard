import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost } from "./useApi";
import { cacheKeys } from "./useCache";

/** Represents backup job. */
export interface BackupJob {
    id: string;
    type: "kopia" | "walg";
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
}

/** Represents the kopia backup API response. */
interface KopiaBackupResponse {
    job: BackupJob | null;
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
        queryFn: () => apiFetch<KopiaBackupResponse>("/backups/kopia"),
        refetchInterval: (query) => {
            const status = query.state.data?.job?.status;
            return status === "running" ? 1_000 : 5_000;
        },
        staleTime: 1_000,
    });
}

/** Provides walg backup. */
export function useWalgBackup() {
    return useQuery({
        queryKey: backupKeys.walg(),
        queryFn: () => apiFetch<KopiaBackupResponse>("/backups/walg"),
        refetchInterval: (query) => {
            const status = query.state.data?.job?.status;
            return status === "running" ? 1_000 : 5_000;
        },
        staleTime: 1_000,
    });
}

/** Provides run kopia backup. */
export function useRunKopiaBackup() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => apiPost<{ ok: boolean; job: BackupJob }>("/backups/kopia/run"),
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

/** Provides run walg backup. */
export function useRunWalgBackup() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => apiPost<{ ok: boolean; job: BackupJob }>("/backups/walg/run"),
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
