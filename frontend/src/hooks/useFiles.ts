import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    type FileContent,
    type FileEntry,
    type FileWriteRequest,
    parseFileContent,
    parseFileWriteResponse,
    parseFilesResponse,
} from "../../../contracts/files";
import { apiFetchParsed, apiPutParsed } from "./useApi";

// Query keys
/** Defines file keys. */
export const fileKeys = {
    all: ["files"] as const,
    list: (path?: string): ["files", "list", string | undefined] => [
        "files",
        "list",
        path,
    ],
    content: (path: string): ["files", "content", string] => ["files", "content", path],
};

// Fetchers
/**
 * Fetches files.
 * @param path File or resource path.
 * @returns Promise resolving to the fetch files result.
 */
async function fetchFiles(path?: string): Promise<FileEntry[]> {
    const endpoint = path ? `/files?path=${encodeURIComponent(path)}` : "/files";
    const response = await apiFetchParsed(endpoint, parseFilesResponse);
    return response.files;
}

/**
 * Fetches file content.
 * @param path File or resource path.
 * @returns Promise resolving to the fetch file content result.
 */
async function fetchFileContent(path: string): Promise<FileContent> {
    const isConfig = path.startsWith("config:");
    const endpoint = isConfig
        ? `/config-files/${encodeURIComponent(path.replace("config:", ""))}`
        : `/files/${encodeURIComponent(path)}`;
    return apiFetchParsed(endpoint, parseFileContent);
}

/**
 * Fetches an explicitly revealed config file after privileged step-up.
 * @param path File or resource path.
 * @returns Promise resolving to the reveal file content result.
 */
async function revealFileContent(path: string): Promise<FileContent> {
    if (!path.startsWith("config:")) {
        throw new Error("Only Dashboard config files support secret reveal");
    }
    const configPath = path.replace("config:", "");
    return apiFetchParsed(
        `/config-files/${encodeURIComponent(configPath)}?reveal=1`,
        parseFileContent
    );
}

/**
 * Performs save file content.
 * @param path File or resource path.
 * @param content Content value.
 */
async function saveFileContent(path: string, content: string): Promise<void> {
    const isConfig = path.startsWith("config:");
    const endpoint = isConfig
        ? `/config-files/${encodeURIComponent(path.replace("config:", ""))}`
        : `/files/${encodeURIComponent(path)}`;
    await apiPutParsed(endpoint, parseFileWriteResponse, {
        content,
    } satisfies FileWriteRequest);
}

// Hooks
/**
 * Provides files.
 * @param path File or resource path.
 * @returns The files.
 */
export function useFiles(path?: string) {
    return useQuery({
        queryKey: fileKeys.list(path),
        queryFn: () => fetchFiles(path),
        staleTime: 30_000,
    });
}

/**
 * Provides file content.
 * @param path File or resource path.
 * @returns The file content.
 */
export function useFileContent(path: string | undefined) {
    return useQuery({
        queryKey: fileKeys.content(path || ""),
        queryFn: () => {
            if (!path) {
                throw new Error("File path is required");
            }
            return fetchFileContent(path);
        },
        enabled: !!path,
        staleTime: 0, // Always refetch when path changes
    });
}

/**
 * Provides save file.
 * @returns The save file.
 */
export function useSaveFile() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ path, content }: { path: string; content: string }) =>
            saveFileContent(path, content),
        onSuccess: async (_, { path }) => {
            await queryClient.invalidateQueries({ queryKey: fileKeys.content(path) });
        },
    });
}

/**
 * Provides an uncached, explicit secret-reveal request for a config file.
 * @returns The an uncached, explicit secret-reveal request for a config file.
 */
export function useRevealFile() {
    return useMutation({
        mutationFn: revealFileContent,
    });
}
