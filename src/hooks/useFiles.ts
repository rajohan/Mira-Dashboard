import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { FileContent, FileNode } from "../types/file";
import { apiFetch, apiPut } from "./useApi";

// Types
/** Describes files response. */
interface FilesResponse {
    files: FileNode[];
}

// Query keys
/** Stores file keys. */
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
/** Handles fetch files. */
async function fetchFiles(path?: string): Promise<FileNode[]> {
    const endpoint = path ? `/files?path=${encodeURIComponent(path)}` : "/files";
    const data = await apiFetch<FilesResponse>(endpoint);
    return data.files || [];
}

/** Handles fetch file content. */
async function fetchFileContent(path: string): Promise<FileContent> {
    const isConfig = path.startsWith("config:");
    const endpoint = isConfig
        ? `/config-files/${encodeURIComponent(path.replace("config:", ""))}`
        : `/files/${encodeURIComponent(path)}`;
    return apiFetch<FileContent>(endpoint);
}

/** Handles save file content. */
async function saveFileContent(path: string, content: string): Promise<void> {
    const isConfig = path.startsWith("config:");
    const endpoint = isConfig
        ? `/config-files/${encodeURIComponent(path.replace("config:", ""))}`
        : `/files/${encodeURIComponent(path)}`;
    await apiPut(endpoint, { content });
}

// Hooks
/** Handles use files. */
export function useFiles(path?: string) {
    return useQuery({
        queryKey: fileKeys.list(path),
        queryFn: () => fetchFiles(path),
        staleTime: 30_000,
    });
}

/** Handles use file content. */
export function useFileContent(path: string | null) {
    return useQuery({
        queryKey: fileKeys.content(path || ""),
        queryFn: () => fetchFileContent(path!),
        enabled: !!path,
        staleTime: 0, // Always refetch when path changes
    });
}

/** Handles use save file. */
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
