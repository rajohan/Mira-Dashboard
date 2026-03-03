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
import { useCallback, useEffect, useState } from "react";

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
import { useAuthStore } from "../stores/authStore";

import type { FileNode, FileContent } from "../types/file";

function formatDate(dateStr: string): string {
    try {
        return format(new Date(dateStr), "dd.MM.yyyy, HH:mm", { locale: enUS });
    } catch {
        return dateStr;
    }
}

export function Files() {
    const { token } = useAuthStore();
    const [files, setFiles] = useState<FileNode[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [configDirExpanded, setConfigDirExpanded] = useState(false);
    const [cronDirExpanded, setCronDirExpanded] = useState(false);
    const [hooksDirExpanded, setHooksDirExpanded] = useState(false);
    const [fileContent, setFileContent] = useState<FileContent | null>(null);
    const [editedContent, setEditedContent] = useState<string>("");
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasChanges, setHasChanges] = useState(false);
    const [largeFileWarning, setLargeFileWarning] = useState(false);
    const [markdownPreview, setMarkdownPreview] = useState(true);
    const [jsonPreview, setJsonPreview] = useState(true);
    const [codeEditMode, setCodeEditMode] = useState(false);

    const apiBase = "/api/files";

    const fetchFiles = useCallback(
        async (dirPath?: string) => {
            setIsLoading(true);
            setError(null);
            try {
                const url = dirPath ? apiBase + "?path=" + encodeURIComponent(dirPath) : apiBase;
                const res = await fetch(url, {
                    headers: { Authorization: "Bearer " + token },
                });
                if (!res.ok) throw new Error("Failed to fetch files");
                const data = await res.json();
                return data.files || [];
            } catch (error_) {
                setError(error_ instanceof Error ? error_.message : "Failed to fetch files");
                return [];
            } finally {
                setIsLoading(false);
            }
        },
        [token]
    );

    const fetchRootFiles = useCallback(async () => {
        const rootFiles = await fetchFiles();
        setFiles(rootFiles);
    }, [fetchFiles]);

    const fetchFileContent = useCallback(
        async (path: string) => {
            setIsLoading(true);
            setError(null);
            setLargeFileWarning(false);
            try {
                const isConfig = path.startsWith("config:");
                const apiUrl = isConfig
                    ? "/api/config-files/" + encodeURIComponent(path.replace("config:", ""))
                    : apiBase + "/" + encodeURIComponent(path);

                const res = await fetch(apiUrl, {
                    headers: { Authorization: "Bearer " + token },
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || "Failed to fetch file");
                }

                const data = await res.json();
                setFileContent(data);
                setEditedContent(data.content || "");
                setHasChanges(false);

                if (data.size > MAX_PREVIEW_SIZE) {
                    setLargeFileWarning(true);
                }

                // Reset preview modes
                setMarkdownPreview(true);
                setJsonPreview(true);
                setCodeEditMode(false);
            } catch (error_) {
                setError(error_ instanceof Error ? error_.message : "Failed to fetch file");
                setFileContent(null);
            } finally {
                setIsLoading(false);
            }
        },
        [token]
    );

    const saveFile = async () => {
        if (!selectedPath || !fileContent) return;
        setIsSaving(true);
        try {
            const isConfig = selectedPath.startsWith("config:");
            const apiEndpoint = isConfig
                ? "/api/config-files/" + encodeURIComponent(selectedPath.replace("config:", ""))
                : apiBase + "/" + encodeURIComponent(selectedPath);

            const res = await fetch(apiEndpoint, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + token,
                },
                body: JSON.stringify({ content: editedContent }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Failed to save file");
            }
            setHasChanges(false);
            await fetchFileContent(selectedPath);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Failed to save file");
        } finally {
            setIsSaving(false);
        }
    };

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
                const children = await fetchFiles(path);
                const updateNode = (nodes: FileNode[]): FileNode[] => {
                    return nodes.map((n) => {
                        if (n.path === path) return { ...n, children, loaded: true };
                        if (n.children) return { ...n, children: updateNode(n.children) };
                        return n;
                    });
                };
                setFiles((prev) => updateNode(prev));
            }
        }
    };

    const handleSelect = (path: string) => {
        setSelectedPath(path);
        fetchFileContent(path);
    };

    const handleContentChange = (value: string) => {
        setEditedContent(value);
        setHasChanges(value !== fileContent?.content);
    };

    useEffect(() => {
        fetchRootFiles();
    }, [fetchRootFiles]);

    const isEditable = !!(fileContent && !fileContent.isBinary && !largeFileWarning);
    const syntaxClass = fileContent ? getSyntaxClass(fileContent.path.split("/").pop() || "") : "";

    return (
        <div className="flex h-full flex-col p-6">
            <div className="mb-4 flex items-center justify-between">
                <h1 className="text-2xl font-bold">Files</h1>
                <Button variant="secondary" size="sm" onClick={() => fetchRootFiles()} disabled={isLoading}>
                    <RefreshCw size={16} className={"mr-1 " + (isLoading ? "animate-spin" : "")} />
                    Refresh
                </Button>
            </div>

            {error && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500 bg-red-500/20 p-3 text-red-400">
                    <AlertTriangle size={16} />
                    {error}
                    <button className="ml-auto text-red-300 hover:text-red-100" onClick={() => setError(null)}>
                        <X size={16} />
                    </button>
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
                            {isLoading && files.length === 0 ? (
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
                                            onClick={saveFile}
                                            disabled={isSaving || !hasChanges}
                                        >
                                            <Save size={14} className="mr-1" />
                                            {isSaving ? "Saving..." : "Save"}
                                        </Button>
                                    )}
                                </div>
                            </div>

                            {/* Content */}
                            <div className="flex-1 overflow-auto">
                                {isLoading ? (
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