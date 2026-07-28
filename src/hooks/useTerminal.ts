import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ExecJobResponse, ExecRequest } from "../../contracts/exec";
import { parseExecJobResponse, parseExecStartResponse } from "../../contracts/exec";
import type {
    TerminalCdRequest,
    TerminalCdResponse,
    TerminalCompletionRequest,
    TerminalCompletionResponse,
} from "../../contracts/terminal";
import {
    parseTerminalCdResponse,
    parseTerminalCompletionResponse,
} from "../../contracts/terminal";
import { apiFetchParsed, apiPost, apiPostParsed } from "./useApi";

/** Represents the terminal view of a tracked exec job. */
export type TerminalJobResponse = ExecJobResponse;

/** Represents terminal command. */
export interface TerminalCommand {
    command: string;
    cwd?: string;
}

function buildTerminalExecRequest({ command, cwd }: TerminalCommand): ExecRequest {
    return {
        args: ["-lc", command],
        command: "bash",
        cwd,
    };
}

/** Defines terminal keys. */
export const terminalKeys = {
    job: (jobId: string | undefined) => ["terminal", "job", jobId] as const,
    history: ["terminal", "history"] as const,
};

/** Provides start terminal command. */
export function useStartTerminalCommand() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (payload: TerminalCommand) =>
            apiPostParsed(
                "/exec/start",
                parseExecStartResponse,
                buildTerminalExecRequest(payload)
            ),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: terminalKeys.history });
        },
    });
}

/** Provides terminal job. */
export function useTerminalJob(jobId: string | undefined) {
    return useQuery({
        queryKey: terminalKeys.job(jobId),
        queryFn: async () => {
            try {
                return await apiFetchParsed(
                    `/exec/${encodeURIComponent(jobId || "")}`,
                    parseExecJobResponse
                );
            } catch (error) {
                if (error instanceof Error && error.message === "Exec job not found") {
                    const now = Date.now();
                    const missingJobResponse: TerminalJobResponse = {
                        code: 1,
                        endedAt: now,
                        jobId: jobId || "",
                        startedAt: now,
                        status: "done",
                        stderr: "Terminal job is no longer available",
                        stdout: "",
                    };
                    return missingJobResponse;
                }
                throw error;
            }
        },
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
    jobId: string | undefined;
    status: "done" | "error" | "pending" | "running" | "signaled";
    code?: number;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt?: number;
}

/** Returns completions. */
export async function getCompletions(
    partial: string,
    cwd: string
): Promise<TerminalCompletionResponse> {
    const request: TerminalCompletionRequest = { cwd, partial };
    return apiPostParsed("/terminal/complete", parseTerminalCompletionResponse, request);
}

/** Performs change directory. */
export async function changeDirectory(
    path: string,
    cwd: string
): Promise<TerminalCdResponse> {
    const request: TerminalCdRequest = { cwd, path };
    return apiPostParsed("/terminal/cd", parseTerminalCdResponse, request);
}

/** Performs stop terminal job. */
export async function stopTerminalJob(jobId: string): Promise<void> {
    await apiPost(`/exec/${encodeURIComponent(jobId)}/stop`, {});
}

/** Provides terminal history. */
export function useTerminalHistory() {
    const [history, setHistory] = useState<CommandHistoryEntry[]>([]);

    /** Performs add command. */
    const addCommand = (entry: Omit<CommandHistoryEntry, "id">) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        setHistory((wasPrevious) => [...wasPrevious, { ...entry, id }]);
        return id;
    };

    /** Performs update command. */
    const updateCommand = (id: string, updates: Partial<CommandHistoryEntry>) => {
        setHistory((wasPrevious) =>
            wasPrevious.map((entry) =>
                entry.id === id ? { ...entry, ...updates } : entry
            )
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
