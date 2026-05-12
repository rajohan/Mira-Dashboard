import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { FileContent, FileNode } from "../types/file";
import { apiFetch, apiPut } from "./useApi";

// Types
interface FilesResponse {
    files: FileNode[];
}

// Query keys
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
async function fetchFiles(path?: string): Promise<FileNode[]> {
    const endpoint = path ? `/files?path=${encodeURIComponent(path)}` : "/files";
    const data = await apiFetch<FilesResponse>(endpoint);
    return data.files || [];
}

async function fetchFileContent(path: string): Promise<FileContent> {
    const isConfig = path.startsWith("config:");
    const endpoint = isConfig
        ? `/config-files/${encodeURIComponent(path.replace("config:", ""))}`
        : `/files/${encodeURIComponent(path)}`;
    return apiFetch<FileContent>(endpoint);
}

async function saveFileContent(path: string, content: string): Promise<void> {
    const isConfig = path.startsWith("config:");
    const endpoint = isConfig
        ? `/config-files/${encodeURIComponent(path.replace("config:", ""))}`
        : `/files/${encodeURIComponent(path)}`;
    await apiPut(endpoint, { content });
}

// Hooks
export function useFiles(path?: string) {
    return useQuery({
        queryKey: fileKeys.list(path),
        queryFn: () => fetchFiles(path),
        staleTime: 30_000,
    });
}

export function useFileContent(path: string | null) {
    return useQuery({
        queryKey: fileKeys.content(path || ""),
        queryFn: () => fetchFileContent(path!),
        enabled: !!path,
        staleTime: 0, // Always refetch when path changes
    });
}

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
