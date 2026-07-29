import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ExecJobResponse, ExecRequest } from "../../../contracts/exec";
import {
    parseExecJobResponse,
    parseExecStartResponse,
    parseExecStopResponse,
} from "../../../contracts/exec";
import type {
    TerminalCdRequest,
    TerminalCdResponse,
    TerminalCompletionRequest,
    TerminalCompletionResponse,
} from "../../../contracts/terminal";
import {
    parseTerminalCdResponse,
    parseTerminalCompletionResponse,
} from "../../../contracts/terminal";
import { apiFetchParsed, apiPostParsed } from "./useApi";

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

/**
 * Provides start terminal command.
 * @returns The start terminal command.
 */
export function useStartTerminalCommand() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (payload: TerminalCommand) =>
            apiPostParsed(
                "/exec/start",
                parseExecStartResponse,
                buildTerminalExecRequest(payload)
            ),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: terminalKeys.history });
        },
    });
}

/**
 * Provides terminal job.
 * @param jobId Job identifier.
 * @returns The terminal job.
 */
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
                    const missingJobResponse: ExecJobResponse = {
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
            const status = query.state.data?.status;
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

/**
 * Returns completions.
 * @param partial Partial value.
 * @param cwd Cwd value.
 * @returns completions.
 */
export async function getCompletions(
    partial: string,
    cwd: string
): Promise<TerminalCompletionResponse> {
    const request: TerminalCompletionRequest = { cwd, partial };
    return apiPostParsed("/terminal/complete", parseTerminalCompletionResponse, request);
}

/**
 * Performs change directory.
 * @param path File or resource path.
 * @param cwd Cwd value.
 * @returns Change directory result.
 */
export async function changeDirectory(
    path: string,
    cwd: string
): Promise<TerminalCdResponse> {
    const request: TerminalCdRequest = { cwd, path };
    return apiPostParsed("/terminal/cd", parseTerminalCdResponse, request);
}

/**
 * Performs stop terminal job.
 * @param jobId Job identifier.
 */
export async function stopTerminalJob(jobId: string): Promise<void> {
    await apiPostParsed(
        `/exec/${encodeURIComponent(jobId)}/stop`,
        parseExecStopResponse,
        {}
    );
}

/**
 * Provides terminal history.
 * @returns The terminal history.
 */
export function useTerminalHistory() {
    const [history, setHistory] = useState<CommandHistoryEntry[]>([]);

    /**
     * Performs add command.
     * @returns Add command result.
     */
    const addCommand = (entry: Omit<CommandHistoryEntry, "id">) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        setHistory((wasPrevious) => [...wasPrevious, { ...entry, id }]);
        return id;
    };

    /**
     * Performs update command.
     * @param id Resource identifier.
     * @param updates Updates value.
     */
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
