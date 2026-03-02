import { useState, useEffect, useCallback } from "react";
import { Card, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { useAuthStore } from "../stores/authStore";
import { Folder, File, ChevronRight, ChevronDown, Save, RefreshCw, AlertTriangle, X } from "lucide-react";

interface FileNode {
    name: string;
    path: string;
    type: "file" | "directory";
    size?: number;
    modified?: string;
    children?: FileNode[];
}

interface FileContent {
    content: string;
    path: string;
    size: number;
    modified: string;
    isBinary: boolean;
}

const MAX_PREVIEW_SIZE = 1024 * 1024; // 1MB

function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDate(dateStr: string): string {
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
        return dateStr;
    }
}

function getFileExtension(filename: string): string {
    const parts = filename.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

export function isTextFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    const textExtensions = [
        "txt", "md", "json", "js", "jsx", "ts", "tsx", "html", "css", "scss",
        "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "cs",
        "sh", "bash", "zsh", "fish", "ps1",
        "yml", "yaml", "toml", "ini", "cfg", "conf", "config",
        "xml", "svg", "sql", "graphql", "proto",
        "env", "gitignore", "dockerignore", "editorconfig",
        "lock", "sum", "mod",
    ];
    return textExtensions.includes(ext) || filename.startsWith(".") || !ext;
}

// Syntax highlighting class map
function getSyntaxClass(filename: string): string {
    const ext = getFileExtension(filename);
    const syntaxMap: Record<string, string> = {
        "js": "text-yellow-400",
        "jsx": "text-yellow-400",
        "ts": "text-blue-400",
        "tsx": "text-blue-400",
        "json": "text-green-400",
        "md": "text-slate-300",
        "html": "text-orange-400",
        "css": "text-pink-400",
        "py": "text-blue-300",
        "go": "text-cyan-400",
        "rs": "text-orange-300",
        "sh": "text-green-300",
        "yml": "text-purple-400",
        "yaml": "text-purple-400",
    };
    return syntaxMap[ext] || "text-slate-300";
}

function FileTreeItem({
    node,
    selectedPath,
    expandedPaths,
    onSelect,
    onToggle,
    depth = 0,
}: {
    node: FileNode;
    selectedPath: string | null;
    expandedPaths: Set<string>;
    onSelect: (path: string) => void;
    onToggle: (path: string) => void;
    depth?: number;
}) {
    const isSelected = selectedPath === node.path;
    const isExpanded = expandedPaths.has(node.path);
    const hasChildren = node.type === "directory" && node.children && node.children.length > 0;

    return (
        <div>
            <div
                className={"flex items-center gap-1 py-1 px-2 cursor-pointer hover:bg-primary-700/50 rounded " + (isSelected ? "bg-accent-500/20 text-accent-400" : "text-primary-200")}
                style={{ paddingLeft: depth * 12 + 8 }}
                onClick={() => {
                    if (node.type === "directory") {
                        onToggle(node.path);
                    } else {
                        onSelect(node.path);
                    }
                }}
            >
                {node.type === "directory" ? (
                    <>
                        {hasChildren ? (
                            isExpanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />
                        ) : (
                            <span className="w-3.5" />
                        )}
                        <Folder size={16} className="text-yellow-400 flex-shrink-0" />
                    </>
                ) : (
                    <>
                        <span className="w-3.5" />
                        <File size={16} className="text-slate-400 flex-shrink-0" />
                    </>
                )}
                <span className="truncate text-sm">{node.name}</span>
            </div>
            {node.type === "directory" && isExpanded && node.children && (
                <div>
                    {node.children
                        .sort((a, b) => {
                            // Directories first, then files, alphabetically
                            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        })
                        .map((child) => (
                            <FileTreeItem
                                key={child.path}
                                node={child}
                                selectedPath={selectedPath}
                                expandedPaths={expandedPaths}
                                onSelect={onSelect}
                                onToggle={onToggle}
                                depth={depth + 1}
                            />
                        ))}
                </div>
            )}
        </div>
    );
}

export function Files() {
    const { token } = useAuthStore();
    const [files, setFiles] = useState<FileNode[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [fileContent, setFileContent] = useState<FileContent | null>(null);
    const [editedContent, setEditedContent] = useState<string>("");
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasChanges, setHasChanges] = useState(false);
    const [largeFileWarning, setLargeFileWarning] = useState(false);

    const apiBase = "/api/files";

    const fetchFiles = useCallback(async (dirPath?: string) => {
        setIsLoading(true);
        setError(null);
        try {
            const url = dirPath ? apiBase + "?path=" + encodeURIComponent(dirPath) : apiBase;
            const res = await fetch(url, {
                headers: { Authorization: "Bearer " + token },
            });
            if (!res.ok) throw new Error("Failed to fetch files");
            const data = await res.json();
            setFiles(data.files || []);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load files");
        } finally {
            setIsLoading(false);
        }
    }, [token]);

    const fetchFileContent = useCallback(async (filePath: string) => {
        setIsLoading(true);
        setError(null);
        setFileContent(null);
        setEditedContent("");
        setHasChanges(false);
        setLargeFileWarning(false);

        try {
            const res = await fetch(apiBase + "/" + encodeURIComponent(filePath), {
                headers: { Authorization: "Bearer " + token },
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Failed to fetch file");
            }
            const data = await res.json();

            if (data.isBinary) {
                setFileContent({
                    content: "[Binary file - cannot display]",
                    path: filePath,
                    size: data.size,
                    modified: data.modified,
                    isBinary: true,
                });
                setEditedContent("");
            } else {
                setFileContent({
                    content: data.content,
                    path: filePath,
                    size: data.size,
                    modified: data.modified,
                    isBinary: false,
                });
                setEditedContent(data.content);

                if (data.size > MAX_PREVIEW_SIZE) {
                    setLargeFileWarning(true);
                }
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load file");
        } finally {
            setIsLoading(false);
        }
    }, [token]);

    const saveFile = async () => {
        if (!selectedPath || !fileContent || fileContent.isBinary) return;

        setIsSaving(true);
        setError(null);

        try {
            const res = await fetch(apiBase + "/" + encodeURIComponent(selectedPath), {
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
            // Refresh file info
            await fetchFileContent(selectedPath);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to save file");
        } finally {
            setIsSaving(false);
        }
    };

    const handleToggle = (path: string) => {
        setExpandedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
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
        fetchFiles();
    }, [fetchFiles]);

    const isEditable = fileContent && !fileContent.isBinary && !largeFileWarning;
    const syntaxClass = fileContent ? getSyntaxClass(fileContent.path.split("/").pop() || "") : "";

    return (
        <div className="p-6 h-full flex flex-col">
            <div className="flex items-center justify-between mb-4">
                <h1 className="text-2xl font-bold">Files</h1>
                <Button variant="secondary" size="sm" onClick={() => fetchFiles()} disabled={isLoading}>
                    <RefreshCw size={16} className={"mr-1 " + (isLoading ? "animate-spin" : "")} />
                    Refresh
                </Button>
            </div>

            {error && (
                <div className="bg-red-500/20 border border-red-500 text-red-400 p-3 rounded-lg mb-4 flex items-center gap-2">
                    <AlertTriangle size={16} />
                    {error}
                    <button className="ml-auto text-red-300 hover:text-red-100" onClick={() => setError(null)}>
                        <X size={16} />
                    </button>
                </div>
            )}

            <div className="flex-1 flex gap-4 min-h-0">
                {/* File Tree */}
                <Card variant="bordered" className="w-72 flex-shrink-0 overflow-hidden flex flex-col p-0">
                    <div className="p-3 border-b border-slate-700">
                        <CardTitle className="text-sm">Workspace</CardTitle>
                    </div>
                    <div className="flex-1 overflow-auto p-2">
                        {isLoading && files.length === 0 ? (
                            <div className="text-slate-400 text-sm p-2">Loading...</div>
                        ) : files.length === 0 ? (
                            <div className="text-slate-400 text-sm p-2">No files found</div>
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
                </Card>

                {/* File Content */}
                <Card variant="bordered" className="flex-1 flex flex-col overflow-hidden p-0">
                    {selectedPath ? (
                        <>
                            {/* Header */}
                            <div className="p-3 border-b border-slate-700 flex items-center justify-between gap-4">
                                <div className="flex items-center gap-2 min-w-0">
                                    <File size={16} className="text-slate-400 flex-shrink-0" />
                                    <span className="font-mono text-sm truncate" title={selectedPath}>
                                        {selectedPath}
                                    </span>
                                    {fileContent && (
                                        <span className="text-xs text-slate-400 flex-shrink-0">
                                            {formatSize(fileContent.size)}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
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
                                    <div className="flex items-center justify-center h-full text-slate-400">
                                        Loading...
                                    </div>
                                ) : fileContent ? (
                                    <div className="h-full flex flex-col">
                                        {largeFileWarning && (
                                            <div className="bg-yellow-500/20 border-b border-yellow-500/50 text-yellow-400 px-4 py-2 text-sm flex items-center gap-2">
                                                <AlertTriangle size={14} />
                                                Large file ({formatSize(fileContent.size)}) - preview only, editing disabled
                                            </div>
                                        )}
                                        {fileContent.isBinary ? (
                                            <div className="flex items-center justify-center h-full text-slate-400">
                                                <div className="text-center">
                                                    <File size={48} className="mx-auto mb-2 opacity-50" />
                                                    <p>Binary file</p>
                                                    <p className="text-xs mt-1">Cannot display binary content</p>
                                                </div>
                                            </div>
                                        ) : isEditable ? (
                                            <textarea
                                                className={"w-full h-full bg-transparent p-4 font-mono text-sm resize-none focus:outline-none " + syntaxClass}
                                                value={editedContent}
                                                onChange={(e) => handleContentChange(e.target.value)}
                                                spellCheck={false}
                                            />
                                        ) : (
                                            <pre className={"p-4 font-mono text-sm whitespace-pre-wrap " + syntaxClass}>
                                                {editedContent}
                                            </pre>
                                        )}
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center h-full text-slate-400">
                                        Failed to load file
                                    </div>
                                )}
                            </div>

                            {/* Footer */}
                            {fileContent && (
                                <div className="p-2 border-t border-slate-700 text-xs text-slate-400">
                                    Modified: {formatDate(fileContent.modified)}
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="flex items-center justify-center h-full text-slate-400">
                            <div className="text-center">
                                <Folder size={48} className="mx-auto mb-2 opacity-50" />
                                <p>Select a file to view</p>
                            </div>
                        </div>
                    )}
                </Card>
            </div>
        </div>
    );
}
