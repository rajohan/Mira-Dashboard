import { format } from "date-fns";
import { enUS } from "date-fns/locale";
import {
    AlertTriangle,
    File,
    Folder,
    RefreshCw,
    Save,
    Settings,
    X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import {
    FileTreeItem,
    ConfigSection,
    PreviewToggle,
    FileContentViewer,
    MAX_PREVIEW_SIZE,
} from "../components/features/files";
import { formatSize, isMarkdownFile, isJsonFile, isCodeFile, getSyntaxClass } from "../utils/fileUtils";
import { useQueryClient } from "@tanstack/react-query";
import { useFiles, useFileContent, useSaveFile, fileKeys } from "../hooks";

import type { FileNode } from "../types/file";

function formatDate(dateStr: string): string {
    try {
        return format(new Date(dateStr), "dd.MM.yyyy, HH:mm", { locale: enUS });
    } catch {
        return dateStr;
    }
}

export function Files() {
    // File tree state
    const [files, setFiles] = useState<FileNode[]>([]);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [configDirExpanded, setConfigDirExpanded] = useState(false);
    const [cronDirExpanded, setCronDirExpanded] = useState(false);
    const [hooksDirExpanded, setHooksDirExpanded] = useState(false);
    
    // Editor state
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [editedContent, setEditedContent] = useState<string>("");
    const [hasChanges, setHasChanges] = useState(false);
    const [largeFileWarning, setLargeFileWarning] = useState(false);
    const [markdownPreview, setMarkdownPreview] = useState(true);
    const [jsonPreview, setJsonPreview] = useState(true);
    const [codeEditMode, setCodeEditMode] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Queries
    const queryClient = useQueryClient();
    const { data: rootFiles = [], isLoading: rootLoading, refetch: refetchRoot } = useFiles();
    const { data: fileContent, isLoading: contentLoading, refetch: refetchContent } = useFileContent(selectedPath);
    const saveMutation = useSaveFile();

    // Sync root files
    useEffect(() => {
        if (rootFiles.length > 0) {
            setFiles(rootFiles);
        }
    }, [rootFiles]);

    // Sync file content
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

    // Load directory on expand
    const handleToggle = async (path: string) => {
        const isCurrentlyExpanded = expandedPaths.has(path);
        if (isCurrentlyExpanded) {
            setExpandedPaths((prev) => {
                const next = new Set(prev);
                next.delete(path);
                return next;
            });
        } else {
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
                // Fetch children using React Query with caching
                try {
                    const data = await queryClient.fetchQuery({
                        queryKey: fileKeys.list(path),
                        queryFn: async () => {
                            const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
                            if (!res.ok) throw new Error("Failed to fetch directory");
                            return res.json();
                        },
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
                } catch (err) {
                    console.error("Failed to load directory:", err);
                }
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

    const handleSave = async () => {
        if (!selectedPath || !fileContent) return;
        try {
            await saveMutation.mutateAsync({ path: selectedPath, content: editedContent });
            setHasChanges(false);
            refetchContent();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save");
        }
    };

    const handleRefresh = () => {
        refetchRoot();
        if (selectedPath) refetchContent();
    };

    const isLoading = rootLoading || contentLoading;
    const isEditable = !!(fileContent && !fileContent.isBinary && !largeFileWarning);
    const syntaxClass = fileContent ? getSyntaxClass(fileContent.path.split("/").pop() || "") : "";

    return (
        <div className="flex h-full flex-col p-6">
            <div className="mb-4 flex items-center justify-between">
                <h1 className="text-2xl font-bold">Files</h1>
                <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={isLoading}>
                    <RefreshCw size={16} className={"mr-1 " + (isLoading ? "animate-spin" : "")} />
                    Refresh
                </Button>
            </div>

            {error && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500 bg-red-500/20 p-3 text-red-400">
                    <AlertTriangle size={16} />
                    {error}
                    <Button variant="ghost" size="sm" className="ml-auto text-red-300 hover:text-red-100" onClick={() => setError(null)}>
                        <X size={16} />
                    </Button>
                </div>
            )}

            <div className="flex min-h-0 flex-1 gap-4">
                {/* Sidebar: Workspace + Config */}
                <div className="w-72 flex-shrink-0">
                    <Card variant="bordered" className="flex h-full flex-col overflow-hidden p-0">
                        {/* Workspace */}
                        <div className="border-b border-slate-700 p-3">
                            <CardTitle className="flex items-center gap-2 text-sm">
                                <Folder size={14} />
                                Workspace
                            </CardTitle>
                        </div>
                        <div className="overflow-auto border-b border-slate-700 p-2">
                            {rootLoading && files.length === 0 ? (
                                <div className="p-2 text-sm text-slate-400">Loading...</div>
                            ) : files.length === 0 ? (
                                <div className="p-2 text-sm text-slate-400">No files found</div>
                            ) : (
                                files
                                    .sort((a, b) => {
                                        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
                                        return a.name.localeCompare(b.name);
                                    })
                                    .map((node) => (
                                        <FileTreeItem
                                            key={node.path}
                                            node={node}
                                            selectedPath={selectedPath}
                                            expandedPaths={expandedPaths}
                                            onSelect={handleSelect}
                                            onToggle={handleToggle}
                                        />
                                    ))
                            )}
                        </div>
                        {/* Config */}
                        <div className="border-t border-slate-700">
                            <div className="border-b border-slate-700 p-3">
                                <CardTitle className="flex items-center gap-2 text-sm">
                                    <Settings size={14} />
                                    Config
                                </CardTitle>
                            </div>
                            <div className="max-h-64 overflow-auto">
                                <ConfigSection
                                    selectedPath={selectedPath}
                                    onSelect={handleSelect}
                                    configDirExpanded={configDirExpanded}
                                    onConfigDirToggle={() => setConfigDirExpanded(!configDirExpanded)}
                                    cronDirExpanded={cronDirExpanded}
                                    onCronDirToggle={() => setCronDirExpanded(!cronDirExpanded)}
                                    hooksDirExpanded={hooksDirExpanded}
                                    onHooksDirToggle={() => setHooksDirExpanded(!hooksDirExpanded)}
                                />
                            </div>
                        </div>
                    </Card>
                </div>

                {/* File Content */}
                <Card variant="bordered" className="flex flex-1 flex-col overflow-hidden p-0">
                    {selectedPath ? (
                        <>
                            {/* Header */}
                            <div className="flex items-center justify-between gap-4 border-b border-slate-700 p-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    <File size={16} className="flex-shrink-0 text-slate-400" />
                                    <span className="truncate font-mono text-sm" title={selectedPath}>
                                        {selectedPath}
                                    </span>
                                    {fileContent && (
                                        <span className="flex-shrink-0 text-xs text-slate-400">
                                            {formatSize(fileContent.size)}
                                        </span>
                                    )}
                                </div>
                                <div className="flex flex-shrink-0 items-center gap-2">
                                    {/* Markdown preview toggle */}
                                    {fileContent && isMarkdownFile(fileContent.path) && isEditable && (
                                        <PreviewToggle
                                            preview={markdownPreview}
                                            onToggle={setMarkdownPreview}
                                        />
                                    )}
                                    {/* JSON preview toggle */}
                                    {fileContent && isJsonFile(fileContent.path) && isEditable && (
                                        <PreviewToggle preview={jsonPreview} onToggle={setJsonPreview} />
                                    )}
                                    {/* Code edit toggle */}
                                    {fileContent && isCodeFile(fileContent.path) && isEditable && (
                                        <PreviewToggle
                                            preview={!codeEditMode}
                                            onToggle={(preview) => setCodeEditMode(!preview)}
                                            previewLabel="Preview"
                                            editLabel="Edit"
                                        />
                                    )}
                                    {hasChanges && (
                                        <span className="text-xs text-yellow-400">Unsaved changes</span>
                                    )}
                                    {isEditable && (
                                        <Button
                                            variant="primary"
                                            size="sm"
                                            onClick={handleSave}
                                            disabled={saveMutation.isPending || !hasChanges}
                                        >
                                            <Save size={14} className="mr-1" />
                                            {saveMutation.isPending ? "Saving..." : "Save"}
                                        </Button>
                                    )}
                                </div>
                            </div>

                            {/* Content */}
                            <div className="flex-1 overflow-auto">
                                {contentLoading ? (
                                    <div className="flex h-full items-center justify-center text-slate-400">
                                        Loading...
                                    </div>
                                ) : fileContent ? (
                                    <FileContentViewer
                                        fileContent={fileContent}
                                        editedContent={editedContent}
                                        onContentChange={handleContentChange}
                                        largeFileWarning={largeFileWarning}
                                        isEditable={isEditable}
                                        markdownPreview={markdownPreview}
                                        jsonPreview={jsonPreview}
                                        codeEditMode={codeEditMode}
                                        syntaxClass={syntaxClass}
                                    />
                                ) : (
                                    <div className="flex h-full items-center justify-center text-slate-400">
                                        Failed to load file
                                    </div>
                                )}
                            </div>

                            {/* Footer */}
                            {fileContent && (
                                <div className="flex items-center justify-between border-t border-slate-700 px-4 py-2 text-xs text-slate-400">
                                    <span>
                                        Modified: {fileContent.modified ? formatDate(fileContent.modified) : "Unknown"}
                                    </span>
                                    {fileContent.modified && (
                                        <span>
                                            {format(new Date(fileContent.modified), "yyyy-MM-dd HH:mm:ss", { locale: enUS })}
                                        </span>
                                    )}
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="flex h-full items-center justify-center text-slate-400">
                            Select a file to view
                        </div>
                    )}
                </Card>
            </div>
        </div>
    );
}