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

let lastKnownLogFiles: LogFile[] = [];

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
function isLogFile(file: unknown): file is LogFile {
    return (
        !!file &&
        typeof file === "object" &&
        typeof (file as LogFile).name === "string" &&
        (file as LogFile).name.trim().length > 0
    );
}

async function fetchLogFiles(): Promise<LogFile[]> {
    const data = await apiFetch<LogFilesResponse>("/logs/info");
    const files = Array.isArray(data.logs) ? data.logs.filter(isLogFile) : [];

    if (files.length > 0) {
        lastKnownLogFiles = files;
    }

    return files;
}

async function fetchLogContent(file: string, lines: number): Promise<string> {
    const data = await apiFetch<LogContentResponse>(
        `/logs/content?file=${encodeURIComponent(file)}&lines=${lines}`
    );
    return typeof data.content === "string" ? data.content : "";
}

// Hooks
export function useLogFiles() {
    return useQuery({
        queryKey: logKeys.files(),
        queryFn: fetchLogFiles,
        placeholderData: () => lastKnownLogFiles,
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
