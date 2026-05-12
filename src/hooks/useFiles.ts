import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { FileContent, FileNode } from "../types/file";
import { apiFetchRequired, apiPut } from "./useApi";

// Types
/** Represents the files API response. */
interface FilesResponse {
    files: FileNode[];
}

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
/** Fetches files. */
async function fetchFiles(path?: string): Promise<FileNode[]> {
    const endpoint = path ? `/files?path=${encodeURIComponent(path)}` : "/files";
    const data = await apiFetchRequired<FilesResponse>(endpoint);
    return data.files || [];
}

/** Fetches file content. */
async function fetchFileContent(path: string): Promise<FileContent> {
    const isConfig = path.startsWith("config:");
    const endpoint = isConfig
        ? `/config-files/${encodeURIComponent(path.replace("config:", ""))}`
        : `/files/${encodeURIComponent(path)}`;
    return apiFetchRequired<FileContent>(endpoint);
}

/** Performs save file content. */
async function saveFileContent(path: string, content: string): Promise<void> {
    const isConfig = path.startsWith("config:");
    const endpoint = isConfig
        ? `/config-files/${encodeURIComponent(path.replace("config:", ""))}`
        : `/files/${encodeURIComponent(path)}`;
    await apiPut(endpoint, { content });
}

// Hooks
/** Provides files. */
export function useFiles(path?: string) {
    return useQuery({
        queryKey: fileKeys.list(path),
        queryFn: () => fetchFiles(path),
        staleTime: 30_000,
    });
}

/** Provides file content. */
export function useFileContent(path: string | null) {
    return useQuery({
        queryKey: fileKeys.content(path || ""),
        queryFn: () => fetchFileContent(path!),
        enabled: !!path,
        staleTime: 0, // Always refetch when path changes
    });
}

/** Provides save file. */
export function useSaveFile() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ path, content }: { path: string; content: string }) =>
            saveFileContent(path, content),
        onSuccess: (_, { path }) => {
            queryClient.invalidateQueries({ queryKey: fileKeys.content(path) });
        },
    });
}
