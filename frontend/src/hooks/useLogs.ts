import { useQuery } from "@tanstack/react-query";

import {
    type DashboardLogContentResponse,
    type LogFile,
    type OpenClawLogFilesResponse,
    parseDashboardLogContentResponse,
    parseOpenClawLogContentResponse,
    parseOpenClawLogFilesResponse,
} from "../../../contracts/logs";
import { apiFetchParsed } from "./useApi";

const logFilesState: { lastKnownLogFiles: LogFile[] } = { lastKnownLogFiles: [] };
const LOG_FILE_INDEX_REFRESH_INTERVAL_MS = 30_000;

// Query keys
/** Defines log keys. */
export const logKeys = {
    dashboard: (lines: number): ["logs", "dashboard", number] => [
        "logs",
        "dashboard",
        lines,
    ],
    openClawFiles: (): ["logs", "openclaw", "files"] => ["logs", "openclaw", "files"],
    openClawContent: (
        file: string,
        lines: number
    ): ["logs", "openclaw", "content", string, number] => [
        "logs",
        "openclaw",
        "content",
        file,
        lines,
    ],
};

/**
 * Fetches log files.
 * @returns Promise resolving to the fetch log files result.
 */
async function fetchLogFiles(): Promise<OpenClawLogFilesResponse> {
    const data = await apiFetchParsed(
        "/logs/openclaw/files",
        parseOpenClawLogFilesResponse
    );
    const files = data.logs;

    if (files.length > 0) {
        logFilesState.lastKnownLogFiles = files;
    }

    return {
        logs: files,
        ...(data.unavailableReason && {
            unavailableReason: data.unavailableReason,
        }),
    };
}

/**
 * Fetches log content.
 * @param file File to process.
 * @param lines Lines value.
 * @returns Promise resolving to the fetch log content result.
 */
async function fetchLogContent(file: string, lines: number) {
    return apiFetchParsed(
        `/logs/openclaw/content?file=${encodeURIComponent(file)}&lines=${lines}`,
        parseOpenClawLogContentResponse
    );
}

async function fetchDashboardLogContent(
    lines: number
): Promise<DashboardLogContentResponse> {
    return apiFetchParsed(
        `/logs/dashboard?lines=${lines}`,
        parseDashboardLogContentResponse
    );
}

// Hooks
/**
 * Provides log files.
 * @param isEnabled Whether is enabled.
 * @returns The log files.
 */
export function useLogFiles(isEnabled = true) {
    const query = useQuery({
        queryKey: logKeys.openClawFiles(),
        queryFn: fetchLogFiles,
        placeholderData: () =>
            logFilesState.lastKnownLogFiles.length > 0
                ? { logs: logFilesState.lastKnownLogFiles }
                : undefined,
        enabled: isEnabled,
        refetchInterval: isEnabled ? LOG_FILE_INDEX_REFRESH_INTERVAL_MS : false,
        refetchOnMount: "always",
        staleTime: 0,
    });
    return {
        ...query,
        data: query.data?.logs,
        unavailableReason: query.data?.unavailableReason,
    };
}

/**
 * Provides log content.
 * @param file File to process.
 * @param lines Lines value.
 * @param isEnabled Whether is enabled.
 * @returns The log content.
 */
export function useLogContent(file: string | undefined, lines: number, isEnabled = true) {
    return useQuery({
        queryKey: logKeys.openClawContent(file || "", lines),
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

/**
 * Provides a bounded snapshot of the Dashboard web and worker journals.
 * @param lines Lines value.
 * @param isEnabled Whether is enabled.
 * @returns The a bounded snapshot of the Dashboard web and worker journals.
 */
export function useDashboardLogContent(lines: number, isEnabled = true) {
    return useQuery({
        queryKey: logKeys.dashboard(lines),
        queryFn: () => fetchDashboardLogContent(lines),
        enabled: isEnabled,
        staleTime: 0,
    });
}
