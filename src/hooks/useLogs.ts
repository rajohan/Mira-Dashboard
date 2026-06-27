import { useQuery } from "@tanstack/react-query";

import type { LogFile } from "../types/log";
import { apiFetchRequired } from "./useApi";

// Types
/** Represents the log files API response. */
interface LogFilesResponse {
    logs: LogFile[];
}

/** Represents the log content API response. */
interface LogContentResponse {
    content: string;
    lineIds?: unknown[];
}

export interface LogContentResult {
    content: string;
    lineIds: Array<number | string | undefined>;
}

const logFilesState: { lastKnownLogFiles: LogFile[] } = { lastKnownLogFiles: [] };

// Query keys
/** Defines log keys. */
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
/** Returns whether log file. */
function isLogFile(file: unknown): file is LogFile {
    return (
        !!file &&
        typeof file === "object" &&
        typeof (file as LogFile).name === "string" &&
        (file as LogFile).name.trim().length > 0
    );
}

/** Fetches log files. */
async function fetchLogFiles(): Promise<LogFile[]> {
    const data = await apiFetchRequired<LogFilesResponse>("/logs/info");
    const files = Array.isArray(data.logs) ? data.logs.filter(isLogFile) : [];

    if (files.length > 0) {
        logFilesState.lastKnownLogFiles = files;
    }

    return files;
}

/** Fetches log content. */
async function fetchLogContent(file: string, lines: number): Promise<LogContentResult> {
    const data = await apiFetchRequired<LogContentResponse>(
        `/logs/content?file=${encodeURIComponent(file)}&lines=${lines}`
    );
    const lineIds = Array.isArray(data.lineIds)
        ? data.lineIds.map((lineId) =>
              typeof lineId === "string" || typeof lineId === "number"
                  ? lineId
                  : undefined
          )
        : [];

    return {
        content: typeof data.content === "string" ? data.content : "",
        lineIds,
    };
}

// Hooks
/** Provides log files. */
export function useLogFiles() {
    return useQuery({
        queryKey: logKeys.files(),
        queryFn: fetchLogFiles,
        placeholderData: () => logFilesState.lastKnownLogFiles,
        staleTime: 60_000, // 1 minute
    });
}

/** Provides log content. */
export function useLogContent(file: string | undefined, lines: number, isEnabled = true) {
    return useQuery({
        queryKey: logKeys.content(file || "", lines),
        queryFn: () => {
            if (file === undefined) {
                throw new Error("Log file is required");
            }
            return fetchLogContent(file, lines);
        },
        enabled: isEnabled && !!file,
        staleTime: 0, // Always refetch
    });
}
