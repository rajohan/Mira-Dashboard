import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiFetch, apiPost } from "./useApi";

/** Represents the terminal job API response. */
export interface TerminalJobResponse {
    jobId: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
}

/** Represents terminal command. */
export interface TerminalCommand {
    command: string;
    cwd?: string;
}

/** Defines terminal keys. */
export const terminalKeys = {
    job: (jobId: string | null) => ["terminal", "job", jobId] as const,
    history: ["terminal", "history"] as const,
};

/** Provides start terminal command. */
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

/** Provides terminal job. */
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

/** Represents command history entry. */
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

/** Represents completion item. */
interface CompletionItem {
    completion: string;
    type: "file" | "directory" | "executable";
    display: string;
}

/** Represents the completion API response. */
interface CompletionResponse {
    completions: CompletionItem[];
    commonPrefix: string;
}

/** Returns completions. */
export async function getCompletions(
    partial: string,
    cwd: string
): Promise<CompletionResponse> {
    return apiPost("/terminal/complete", { partial, cwd });
}

/** Represents the cd API response. */
export interface CdResponse {
    success: boolean;
    newCwd: string;
    error?: string;
}

/** Performs change directory. */
export async function changeDirectory(path: string, cwd: string): Promise<CdResponse> {
    return apiPost("/terminal/cd", { path, cwd });
}

/** Performs stop terminal job. */
export async function stopTerminalJob(jobId: string): Promise<void> {
    await apiPost(`/exec/${jobId}/stop`, {});
}

/** Provides terminal history. */
export function useTerminalHistory() {
    const [history, setHistory] = useState<CommandHistoryEntry[]>([]);

    /** Performs add command. */
    const addCommand = (entry: Omit<CommandHistoryEntry, "id">) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        setHistory((prev) => [...prev, { ...entry, id }]);
        return id;
    };

    /** Performs update command. */
    const updateCommand = (id: string, updates: Partial<CommandHistoryEntry>) => {
        setHistory((prev) =>
            prev.map((entry) => (entry.id === id ? { ...entry, ...updates } : entry))
        );
    };

    /** Performs clear history. */
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
