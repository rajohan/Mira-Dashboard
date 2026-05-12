import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { FileNode } from "../types/file";
import { getFileExtension, isJsonFile } from "../utils/fileUtils";
import { validateJsonString } from "../utils/json";
import { apiFetch } from "./useApi";
import { fileKeys, useFileContent, useFiles, useSaveFile } from "./useFiles";

export const MAX_PREVIEW_SIZE = 100_000;

export function useFileExplorerState() {
    const [files, setFiles] = useState<FileNode[]>([]);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [editedContent, setEditedContent] = useState<string>("");
    const [hasChanges, setHasChanges] = useState(false);
    const [largeFileWarning, setLargeFileWarning] = useState(false);
    const [markdownPreview, setMarkdownPreview] = useState(true);
    const [jsonPreview, setJsonPreview] = useState(true);
    const [codeEditMode, setCodeEditMode] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const queryClient = useQueryClient();
    const {
        data: rootFiles = [],
        isLoading: rootLoading,
        refetch: refetchRoot,
    } = useFiles();
    const {
        data: fileContent,
        isLoading: contentLoading,
        refetch: refetchContent,
    } = useFileContent(selectedPath);
    const saveMutation = useSaveFile();

    useEffect(() => {
        if (rootFiles.length > 0) {
            setFiles(rootFiles);
        }
    }, [rootFiles]);

    useEffect(() => {
        if (fileContent) {
            setEditedContent(fileContent.content || "");
            setHasChanges(false);
            setLargeFileWarning(fileContent.size > MAX_PREVIEW_SIZE);
            setMarkdownPreview(true);
            setJsonPreview(true);
            setCodeEditMode(false);
            setError(null);
        }
    }, [fileContent]);

    const handleToggle = async (path: string) => {
        const isCurrentlyExpanded = expandedPaths.has(path);
        if (isCurrentlyExpanded) {
            setExpandedPaths((prev) => {
                const next = new Set(prev);
                next.delete(path);
                return next;
            });
            return;
        }

        setExpandedPaths((prev) => new Set(prev).add(path));

        const findNode = (nodes: FileNode[]): FileNode | undefined => {
            for (const node of nodes) {
                if (node.path === path) return node;
                if (node.children) {
                    const found = findNode(node.children);
                    if (found) return found;
                }
            }
            return undefined;
        };

        const node = findNode(files);
        if (node && node.type === "directory" && !node.loaded) {
            try {
                const data = await queryClient.fetchQuery({
                    queryKey: fileKeys.list(path),
                    queryFn: () =>
                        apiFetch<{ files: FileNode[] }>(
                            `/files?path=${encodeURIComponent(path)}`
                        ),
                    staleTime: 30_000,
                });
                const children = data.files || [];
                const updateNode = (nodes: FileNode[]): FileNode[] => {
                    return nodes.map((n) => {
                        if (n.path === path) return { ...n, children, loaded: true };
                        if (n.children) return { ...n, children: updateNode(n.children) };
                        return n;
                    });
                };
                setFiles((prev) => updateNode(prev));
            } catch (error_) {
                console.error("Failed to load directory:", error_);
            }
        }
    };

    const handleSelect = (path: string) => {
        setSelectedPath(path);
        setHasChanges(false);
        setError(null);
    };

    const handleContentChange = (value: string) => {
        setEditedContent(value);
        setHasChanges(value !== fileContent?.content);
    };

    const isJsonEditing = !!(fileContent && isJsonFile(fileContent.path) && !jsonPreview);
    const jsonValidationMode =
        fileContent && getFileExtension(fileContent.path) === "json5" ? "json5" : "json";
    const jsonValidation = isJsonEditing
        ? validateJsonString(editedContent, jsonValidationMode)
        : { valid: true, error: null };

    const handleSave = async () => {
        if (!selectedPath || !fileContent) return;

        if (isJsonEditing && !jsonValidation.valid) {
            setError(`Invalid JSON: ${jsonValidation.error || "parse error"}`);
            return;
        }

        try {
            await saveMutation.mutateAsync({
                path: selectedPath,
                content: editedContent,
            });
            setHasChanges(false);
            void refetchContent();
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Failed to save");
        }
    };

    const handleRefresh = () => {
        void refetchRoot();
        if (selectedPath) {
            void refetchContent();
        }
    };

    return {
        files,
        expandedPaths,
        selectedPath,
        editedContent,
        hasChanges,
        largeFileWarning,
        markdownPreview,
        jsonPreview,
        codeEditMode,
        isJsonEditing,
        jsonValidation,
        error,
        fileContent,
        rootLoading,
        contentLoading,
        saveMutation,
        setError,
        setMarkdownPreview,
        setJsonPreview,
        setCodeEditMode,
        handleToggle,
        handleSelect,
        handleContentChange,
        handleSave,
        handleRefresh,
    };
}
