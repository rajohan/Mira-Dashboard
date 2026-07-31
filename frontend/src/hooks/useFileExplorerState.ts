import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
    type FileContent,
    type FileEntry,
    parseFilesResponse,
} from "../../../contracts/files";
import { MAX_PREVIEW_SIZE } from "../components/features/files/fileConstants";
import { messageFromError } from "../lib/errorMessage";
import { getFileExtension, isJsonFile } from "../utils/fileUtilities";
import { validateJsonString } from "../utils/json";
import { apiFetchParsed } from "./useApi";
import {
    fileKeys,
    useFileContent,
    useFiles,
    useRevealFile,
    useSaveFile,
} from "./useFiles";

export interface FileNode extends FileEntry {
    children?: FileNode[];
    loaded?: boolean;
}

interface FileEditorState {
    codeEditMode: boolean;
    editedContent: string;
    error: string | undefined;
    hasChanges: boolean;
    jsonPreview: boolean;
    markdownPreview: boolean;
    source: FileContent | undefined;
}

function initialEditorState(source?: FileContent): FileEditorState {
    return {
        codeEditMode: false,
        editedContent: source?.content || "",
        error: undefined,
        hasChanges: false,
        jsonPreview: true,
        markdownPreview: true,
        source,
    };
}

/**
 * Provides file explorer state.
 * @returns The file explorer state.
 */
export function useFileExplorerState() {
    const {
        data: rootFiles = [],
        isLoading: rootLoading,
        refetch: refetchRoot,
    } = useFiles();
    const [fileTree, setFileTree] = useState<{
        files: FileNode[];
        source: FileEntry[];
    }>(() => ({
        files: rootFiles,
        source: rootFiles,
    }));
    const files: FileNode[] = fileTree.source === rootFiles ? fileTree.files : rootFiles;
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
    const [selectedPath, setSelectedPath] = useState<string | undefined>();
    const [revealedFileContent, setRevealedFileContent] = useState<{
        content: FileContent;
        sourcePath: string;
    }>();

    const queryClient = useQueryClient();
    const {
        data: maskedFileContent,
        isLoading: contentLoading,
        refetch: refetchContent,
    } = useFileContent(selectedPath);
    const saveMutation = useSaveFile();
    const revealMutation = useRevealFile();
    const fileContent =
        revealedFileContent !== undefined &&
        revealedFileContent.sourcePath === selectedPath
            ? revealedFileContent.content
            : maskedFileContent;
    const [savedEditorState, setSavedEditorState] = useState(() =>
        initialEditorState(fileContent)
    );
    const editorState =
        savedEditorState.source === fileContent
            ? savedEditorState
            : initialEditorState(fileContent);
    const {
        codeEditMode,
        editedContent,
        error,
        hasChanges,
        jsonPreview,
        markdownPreview,
    } = editorState;
    const isLargeFileWarning = (fileContent?.size ?? 0) > MAX_PREVIEW_SIZE;
    const updateEditorState = (update: (current: FileEditorState) => FileEditorState) => {
        setSavedEditorState((current) =>
            update(
                current.source === fileContent ? current : initialEditorState(fileContent)
            )
        );
    };
    const setError = (nextError: string | undefined) => {
        updateEditorState((current) => ({ ...current, error: nextError }));
    };
    const setMarkdownPreview = (isPreview: boolean) => {
        updateEditorState((current) => ({
            ...current,
            markdownPreview: isPreview,
        }));
    };
    const setJsonPreview = (isPreview: boolean) => {
        updateEditorState((current) => ({ ...current, jsonPreview: isPreview }));
    };
    const setCodeEditMode = (isEditing: boolean) => {
        updateEditorState((current) => ({ ...current, codeEditMode: isEditing }));
    };

    /**
     * Responds to toggle events.
     * @param path File or resource path.
     */
    const handleToggle = async (path: string) => {
        const isCurrentlyExpanded = expandedPaths.has(path);
        if (isCurrentlyExpanded) {
            setExpandedPaths((wasPrevious) => {
                const next = new Set(wasPrevious);
                next.delete(path);
                return next;
            });
            return;
        }

        setExpandedPaths((wasPrevious) => {
            return new Set([...wasPrevious, path]);
        });

        /**
         * Performs find node.
         * @param nodes Nodes value.
         * @returns Find node result.
         */
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
                        apiFetchParsed(
                            `/files?path=${encodeURIComponent(path)}`,
                            parseFilesResponse
                        ),
                    staleTime: 30_000,
                });
                const children = data.files || [];
                /**
                 * Performs update node.
                 * @param nodes Nodes value.
                 * @returns Update node result.
                 */
                const updateNode = (nodes: FileNode[]): FileNode[] => {
                    return nodes.map((n) => {
                        if (n.path === path) return { ...n, children, loaded: true };
                        if (n.children) return { ...n, children: updateNode(n.children) };
                        return n;
                    });
                };
                setFileTree((current) => ({
                    files: updateNode(
                        current.source === rootFiles ? current.files : rootFiles
                    ),
                    source: rootFiles,
                }));
            } catch (error_) {
                console.error("Failed to load directory:", error_);
            }
        }
    };

    /**
     * Responds to select events.
     * @param path File or resource path.
     */
    const handleSelect = (path: string) => {
        setSelectedPath(path);
        setRevealedFileContent(undefined);
        setSavedEditorState(initialEditorState());
    };

    /**
     * Responds to content change events.
     * @param value Value to process.
     */
    const handleContentChange = (value: string) => {
        updateEditorState((current) => ({
            ...current,
            editedContent: value,
            hasChanges: value !== fileContent?.content,
        }));
    };

    const activeContentPath = fileContent?.path ?? selectedPath;
    const isJsonEditing = !!(
        activeContentPath &&
        !jsonPreview &&
        isJsonFile(activeContentPath)
    );
    const jsonValidationMode =
        activeContentPath && getFileExtension(activeContentPath) === "json5"
            ? "json5"
            : "json";
    const jsonValidation = isJsonEditing
        ? validateJsonString(editedContent, jsonValidationMode)
        : { valid: true, error: undefined };

    /** Responds to save events. */
    const handleSave = async () => {
        if (!selectedPath || !fileContent) return;

        if (isJsonEditing && !jsonValidation.valid) {
            setError(`Invalid JSON: ${jsonValidation.error || "parse error"}`);
            return;
        }

        try {
            const savedPath = selectedPath;
            const savedContent = editedContent;
            await saveMutation.mutateAsync({
                path: savedPath,
                content: savedContent,
            });
            setRevealedFileContent((current) => {
                if (current?.sourcePath !== savedPath) {
                    return current;
                }
                return {
                    content: {
                        ...current.content,
                        content: savedContent,
                        size: new TextEncoder().encode(savedContent).byteLength,
                    },
                    sourcePath: savedPath,
                };
            });
            updateEditorState((current) => ({ ...current, hasChanges: false }));
            void refetchContent();
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    };

    /** Responds to refresh events. */
    const handleRefresh = () => {
        setRevealedFileContent(undefined);
        void refetchRoot();
        if (selectedPath) {
            void refetchContent();
        }
    };

    /** Reveals a config file only after the server accepts privileged step-up. */
    const handleReveal = async () => {
        if (!selectedPath) return;
        const sourcePath = selectedPath;
        setError(undefined);
        try {
            const revealed = await revealMutation.mutateAsync(sourcePath);
            setRevealedFileContent({ content: revealed, sourcePath });
        } catch (error_) {
            setError(messageFromError(error_, "Failed to reveal config"));
        }
    };

    return {
        files,
        expandedPaths,
        selectedPath,
        editedContent,
        hasChanges,
        largeFileWarning: isLargeFileWarning,
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
        revealPending: revealMutation.isPending,
        setError,
        setMarkdownPreview,
        setJsonPreview,
        setCodeEditMode,
        handleToggle,
        handleSelect,
        handleContentChange,
        handleSave,
        handleRefresh,
        handleReveal,
    };
}
