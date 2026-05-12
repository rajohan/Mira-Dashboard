import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiFetch, apiPost } from "./useApi";

/** Describes terminal job response. */
export interface TerminalJobResponse {
    jobId: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
}

/** Describes terminal command. */
export interface TerminalCommand {
    command: string;
    cwd?: string;
}

/** Stores terminal keys. */
export const terminalKeys = {
    job: (jobId: string | null) => ["terminal", "job", jobId] as const,
    history: ["terminal", "history"] as const,
};

/** Handles use start terminal command. */
export function useStartTerminalCommand() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (payload: TerminalCommand) =>
            apiPost<{ jobId: string }>("/exec/start", payload),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: terminalKeys.history });
        },
    });
}

/** Handles use terminal job. */
export function useTerminalJob(jobId: string | null) {
    return useQuery({
        queryKey: terminalKeys.job(jobId),
        queryFn: () => apiFetch<TerminalJobResponse>(`/exec/${jobId}`),
        enabled: Boolean(jobId),
        refetchInterval: (query) => {
            const status = (query.state.data as TerminalJobResponse | undefined)?.status;
            return status === "done" ? false : 500;
        },
        staleTime: 0,
    });
}

/** Describes command history entry. */
export interface CommandHistoryEntry {
    id: string;
    command: string;
    cwd: string;
    jobId: string | null;
    status: "pending" | "running" | "done" | "error";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
}

/** Describes completion item. */
interface CompletionItem {
    completion: string;
    type: "file" | "directory" | "executable";
    display: string;
}

/** Describes completion response. */
interface CompletionResponse {
    completions: CompletionItem[];
    commonPrefix: string;
}

/** Handles get completions. */
export async function getCompletions(
    partial: string,
    cwd: string
): Promise<CompletionResponse> {
    return apiPost("/terminal/complete", { partial, cwd });
}

/** Describes cd response. */
export interface CdResponse {
    success: boolean;
    newCwd: string;
    error?: string;
}

/** Handles change directory. */
export async function changeDirectory(path: string, cwd: string): Promise<CdResponse> {
    return apiPost("/terminal/cd", { path, cwd });
}

/** Handles stop terminal job. */
export async function stopTerminalJob(jobId: string): Promise<void> {
    await apiPost(`/exec/${jobId}/stop`, {});
}

/** Handles use terminal history. */
export function useTerminalHistory() {
    const [history, setHistory] = useState<CommandHistoryEntry[]>([]);

    /** Handles add command. */
    const addCommand = (entry: Omit<CommandHistoryEntry, "id">) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        setHistory((prev) => [...prev, { ...entry, id }]);
        return id;
    };

    /** Handles update command. */
    const updateCommand = (id: string, updates: Partial<CommandHistoryEntry>) => {
        setHistory((prev) =>
            prev.map((entry) => (entry.id === id ? { ...entry, ...updates } : entry))
        );
    };

    /** Handles clear history. */
    const clearHistory = () => {
        setHistory([]);
    };

    return {
        history,
        addCommand,
        updateCommand,
        clearHistory,
    };
}
