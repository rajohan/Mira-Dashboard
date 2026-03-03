import { useQuery } from "@tanstack/react-query";

import type { LogFile } from "../types/log";
import { apiFetch } from "./useApi";

// Types
interface LogFilesResponse {
    logs: LogFile[];
}

interface LogContentResponse {
    content: string;
}

// Query keys
export const logKeys = {
    files: (): ["logs", "files"] => ["logs", "files"],
    content: (file: string, lines: number): ["logs", "content", string, number] => [
        "logs",
        "content",
        file,
        lines,
    ],
};

// Fetchers
async function fetchLogFiles(): Promise<LogFile[]> {
    const data = await apiFetch<LogFilesResponse>("/logs/info");
    return data.logs || [];
}

async function fetchLogContent(file: string, lines: number): Promise<string> {
    const data = await apiFetch<LogContentResponse>(
        `/logs/content?file=${encodeURIComponent(file)}&lines=${lines}`
    );
    return data.content || "";
}

// Hooks
export function useLogFiles() {
    return useQuery({
        queryKey: logKeys.files(),
        queryFn: fetchLogFiles,
        staleTime: 60_000, // 1 minute
    });
}

export function useLogContent(file: string | null, lines: number, enabled = true) {
    return useQuery({
        queryKey: logKeys.content(file || "", lines),
        queryFn: () => fetchLogContent(file!, lines),
        enabled: enabled && !!file,
        staleTime: 0, // Always refetch
    });
}
