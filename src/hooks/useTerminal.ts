import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { apiFetch, apiPost } from "./useApi";

export interface TerminalJobResponse {
    jobId: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
}

export interface TerminalCommand {
    command: string;
    cwd?: string;
}

export const terminalKeys = {
    job: (jobId: string | null) => ["terminal", "job", jobId] as const,
    history: ["terminal", "history"] as const,
};

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

interface CompletionItem {
    completion: string;
    type: "file" | "directory" | "executable";
    display: string;
}

interface CompletionResponse {
    completions: CompletionItem[];
    commonPrefix: string;
}

export async function getCompletions(
    partial: string,
    cwd: string
): Promise<CompletionResponse> {
    return apiPost("/terminal/complete", { partial, cwd });
}

export async function stopTerminalJob(jobId: string): Promise<void> {
    await apiPost(`/exec/${jobId}/stop`, {});
}

export function useTerminalHistory() {
    const [history, setHistory] = useState<CommandHistoryEntry[]>([]);

    const addCommand = useCallback((entry: Omit<CommandHistoryEntry, "id">) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        setHistory((prev) => [...prev, { ...entry, id }]);
        return id;
    }, []);

    const updateCommand = useCallback(
        (id: string, updates: Partial<CommandHistoryEntry>) => {
            setHistory((prev) =>
                prev.map((entry) => (entry.id === id ? { ...entry, ...updates } : entry))
            );
        },
        []
    );

    const clearHistory = useCallback(() => {
        setHistory([]);
    }, []);

    return {
        history,
        addCommand,
        updateCommand,
        clearHistory,
    };
}
