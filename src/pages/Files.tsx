import ReactJsonView from "@microlink/react-json-view";
import { format } from "date-fns";
import { enUS } from "date-fns/locale";
import JSON5 from "json5";
import {
    AlertTriangle,
    Code,
    Eye,
    File,
    Folder,
    RefreshCw,
    Save,
    Settings,
    X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter";
import { monokai } from "react-syntax-highlighter/dist/esm/styles/hljs";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { FileTreeItem } from "../components/features/files/FileTreeItem";
import { ConfigSection } from "../components/features/files/ConfigSection";
import { MAX_PREVIEW_SIZE } from "../components/features/files/fileConstants";
import {
    formatSize,
    getFileExtension,
    isMarkdownFile,
    isJsonFile,
    isCodeFile,
    getLanguage,
} from "../utils/fileUtils";
import { useAuthStore } from "../stores/authStore";

import type { FileNode, FileContent } from "../types/file";

function formatDate(dateStr: string): string {
    try {
        return format(new Date(dateStr), "dd.MM.yyyy, HH:mm", { locale: enUS });
    } catch {
        return dateStr;
    }
}

function getSyntaxClass(filename: string): string {
    const ext = getFileExtension(filename);
    const syntaxMap: Record<string, string> = {
        js: "text-yellow-400",
        jsx: "text-yellow-400",
        ts: "text-blue-400",
        tsx: "text-blue-400",
        json: "text-green-400",
        json5: "text-green-400",
        md: "text-slate-300",
        html: "text-orange-400",
        css: "text-pink-400",
        py: "text-blue-300",
        go: "text-cyan-400",
        rs: "text-orange-300",
        sh: "text-green-300",
        yml: "text-purple-400",
        yaml: "text-purple-400",
    };
    return syntaxMap[ext] || "text-slate-300";
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
                const url = dirPath
                    ? apiBase + "?path=" + encodeURIComponent(dirPath)
                    : apiBase;
                const res = await fetch(url, {
                    headers: { Authorization: "Bearer " + token },
                });
                if (!res.ok) throw new Error("Failed to fetch files");
                const data = await res.json();
                return data.files || [];
            } catch (error_) {
                setError(
                    error_ instanceof Error ? error_.message : "Failed to load files"
                );
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
        async (filePath: string) => {
            setIsLoading(true);
            setError(null);
            setFileContent(null);
            setEditedContent("");
            setHasChanges(false);
            setLargeFileWarning(false);
            setMarkdownPreview(true);
            setJsonPreview(true);
            setCodeEditMode(false);

            try {
                const isConfigFile = filePath.startsWith("config:");
                const apiEndpoint = isConfigFile
                    ? "/api/config-files/" +
                      encodeURIComponent(filePath.replace("config:", ""))
                    : apiBase + "/" + encodeURIComponent(filePath);

                const res = await fetch(apiEndpoint, {
                    headers: { Authorization: "Bearer " + token },
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || "Failed to fetch file");
                }
                const data = await res.json();

                if (data.isImage) {
                    setFileContent({
                        content: data.content,
                        path: filePath,
                        size: data.size,
                        modified: data.modified,
                        isBinary: true,
                        isImage: true,
                        mimeType: data.mimeType,
                    });
                    setEditedContent("");
                } else if (data.isBinary) {
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
                    if (data.size > MAX_PREVIEW_SIZE) setLargeFileWarning(true);
                }
            } catch (error_) {
                setError(
                    error_ instanceof Error ? error_.message : "Failed to load file"
                );
            } finally {
                setIsLoading(false);
            }
        },
        [token]
    );

    const saveFile = async () => {
        if (!selectedPath || !fileContent || fileContent.isBinary) return;
        setIsSaving(true);
        setError(null);

        try {
            const isConfigFile = selectedPath.startsWith("config:");
            const apiEndpoint = isConfigFile
                ? "/api/config-files/" +
                  encodeURIComponent(selectedPath.replace("config:", ""))
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

    const isEditable = fileContent && !fileContent.isBinary && !largeFileWarning;
    const syntaxClass = fileContent
        ? getSyntaxClass(fileContent.path.split("/").pop() || "")
        : "";

    return (
        <div className="flex h-full flex-col p-6">
            <div className="mb-4 flex items-center justify-between">
                <h1 className="text-2xl font-bold">Files</h1>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => fetchRootFiles()}
                    disabled={isLoading}
                >
                    <RefreshCw
                        size={16}
                        className={"mr-1 " + (isLoading ? "animate-spin" : "")}
                    />
                    Refresh
                </Button>
            </div>

            {error && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500 bg-red-500/20 p-3 text-red-400">
                    <AlertTriangle size={16} />
                    {error}
                    <button
                        className="ml-auto text-red-300 hover:text-red-100"
                        onClick={() => setError(null)}
                    >
                        <X size={16} />
                    </button>
                </div>
            )}

            <div className="flex min-h-0 flex-1 gap-4">
                {/* Sidebar: Workspace + Config */}
                <div className="w-72 flex-shrink-0">
                    <Card
                        variant="bordered"
                        className="flex h-full flex-col overflow-hidden p-0"
                    >
                        {/* Workspace */}
                        <div className="border-b border-slate-700 p-3">
                            <CardTitle className="flex items-center gap-2 text-sm">
                                <Folder size={14} />
                                Workspace
                            </CardTitle>
                        </div>
                        <div className="overflow-auto border-b border-slate-700 p-2">
                            {isLoading && files.length === 0 ? (
                                <div className="p-2 text-sm text-slate-400">
                                    Loading...
                                </div>
                            ) : files.length === 0 ? (
                                <div className="p-2 text-sm text-slate-400">
                                    No files found
                                </div>
                            ) : (
                                files
                                    .sort((a, b) => {
                                        if (a.type !== b.type)
                                            return a.type === "directory" ? -1 : 1;
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
                                    onConfigDirToggle={() =>
                                        setConfigDirExpanded(!configDirExpanded)
                                    }
                                    cronDirExpanded={cronDirExpanded}
                                    onCronDirToggle={() =>
                                        setCronDirExpanded(!cronDirExpanded)
                                    }
                                    hooksDirExpanded={hooksDirExpanded}
                                    onHooksDirToggle={() =>
                                        setHooksDirExpanded(!hooksDirExpanded)
                                    }
                                />
                            </div>
                        </div>
                    </Card>
                </div>

                {/* File Content */}
                <Card
                    variant="bordered"
                    className="flex flex-1 flex-col overflow-hidden p-0"
                >
                    {selectedPath ? (
                        <>
                            {/* Header */}
                            <div className="flex items-center justify-between gap-4 border-b border-slate-700 p-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    <File
                                        size={16}
                                        className="flex-shrink-0 text-slate-400"
                                    />
                                    <span
                                        className="truncate font-mono text-sm"
                                        title={selectedPath}
                                    >
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
                                    {fileContent &&
                                        isMarkdownFile(fileContent.path) &&
                                        isEditable && (
                                            <div className="flex items-center gap-1 rounded bg-slate-700 p-0.5">
                                                <button
                                                    className={
                                                        "rounded px-2 py-1 text-xs " +
                                                        (markdownPreview
                                                            ? "bg-accent-500 text-white"
                                                            : "text-slate-300 hover:text-white")
                                                    }
                                                    onClick={() =>
                                                        setMarkdownPreview(true)
                                                    }
                                                >
                                                    <Eye
                                                        size={14}
                                                        className="mr-1 inline"
                                                    />
                                                    Preview
                                                </button>
                                                <button
                                                    className={
                                                        "rounded px-2 py-1 text-xs " +
                                                        (markdownPreview
                                                            ? "text-slate-300 hover:text-white"
                                                            : "bg-accent-500 text-white")
                                                    }
                                                    onClick={() =>
                                                        setMarkdownPreview(false)
                                                    }
                                                >
                                                    <Code
                                                        size={14}
                                                        className="mr-1 inline"
                                                    />
                                                    Raw
                                                </button>
                                            </div>
                                        )}
                                    {/* JSON preview toggle */}
                                    {fileContent &&
                                        isJsonFile(fileContent.path) &&
                                        isEditable && (
                                            <div className="flex items-center gap-1 rounded bg-slate-700 p-0.5">
                                                <button
                                                    className={
                                                        "rounded px-2 py-1 text-xs " +
                                                        (jsonPreview
                                                            ? "bg-accent-500 text-white"
                                                            : "text-slate-300 hover:text-white")
                                                    }
                                                    onClick={() => setJsonPreview(true)}
                                                >
                                                    <Eye
                                                        size={14}
                                                        className="mr-1 inline"
                                                    />
                                                    Preview
                                                </button>
                                                <button
                                                    className={
                                                        "rounded px-2 py-1 text-xs " +
                                                        (jsonPreview
                                                            ? "text-slate-300 hover:text-white"
                                                            : "bg-accent-500 text-white")
                                                    }
                                                    onClick={() => setJsonPreview(false)}
                                                >
                                                    <Code
                                                        size={14}
                                                        className="mr-1 inline"
                                                    />
                                                    Raw
                                                </button>
                                            </div>
                                        )}
                                    {/* Code edit toggle */}
                                    {fileContent &&
                                        isCodeFile(fileContent.path) &&
                                        isEditable && (
                                            <div className="flex items-center gap-1 rounded bg-slate-700 p-0.5">
                                                <button
                                                    className={
                                                        "rounded px-2 py-1 text-xs " +
                                                        (codeEditMode
                                                            ? "text-slate-300 hover:text-white"
                                                            : "bg-accent-500 text-white")
                                                    }
                                                    onClick={() => setCodeEditMode(false)}
                                                >
                                                    <Eye
                                                        size={14}
                                                        className="mr-1 inline"
                                                    />
                                                    Preview
                                                </button>
                                                <button
                                                    className={
                                                        "rounded px-2 py-1 text-xs " +
                                                        (codeEditMode
                                                            ? "bg-accent-500 text-white"
                                                            : "text-slate-300 hover:text-white")
                                                    }
                                                    onClick={() => setCodeEditMode(true)}
                                                >
                                                    <Code
                                                        size={14}
                                                        className="mr-1 inline"
                                                    />
                                                    Edit
                                                </button>
                                            </div>
                                        )}
                                    {hasChanges && (
                                        <span className="text-xs text-yellow-400">
                                            Unsaved changes
                                        </span>
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
                                    <div className="flex h-full flex-col">
                                        {largeFileWarning && (
                                            <div className="flex items-center gap-2 border-b border-yellow-500/50 bg-yellow-500/20 px-4 py-2 text-sm text-yellow-400">
                                                <AlertTriangle size={14} />
                                                Large file ({formatSize(fileContent.size)}
                                                ) - preview only, editing disabled
                                            </div>
                                        )}
                                        {fileContent.isBinary && !fileContent.isImage ? (
                                            <div className="flex h-full items-center justify-center text-slate-400">
                                                <div className="text-center">
                                                    <File
                                                        size={48}
                                                        className="mx-auto mb-2 opacity-50"
                                                    />
                                                    <p>Binary file</p>
                                                    <p className="mt-1 text-xs">
                                                        Cannot display binary content
                                                    </p>
                                                </div>
                                            </div>
                                        ) : fileContent.isImage ? (
                                            <div className="flex h-full items-center justify-center p-4">
                                                <img
                                                    src={
                                                        "data:" +
                                                        fileContent.mimeType +
                                                        ";base64," +
                                                        fileContent.content
                                                    }
                                                    alt={
                                                        fileContent.path
                                                            .split("/")
                                                            .pop() || "Image"
                                                    }
                                                    className="max-h-full max-w-full rounded object-contain"
                                                />
                                            </div>
                                        ) : isMarkdownFile(fileContent.path) &&
                                          markdownPreview ? (
                                            <div className="prose prose-invert max-w-none p-6 prose-headings:mb-4 prose-headings:mt-6 prose-p:my-4 prose-blockquote:my-4 prose-pre:my-4 prose-ol:my-4 prose-ul:my-4 prose-li:my-1 prose-table:my-4 prose-hr:my-6">
                                                <ReactMarkdown
                                                    remarkPlugins={[
                                                        remarkGfm,
                                                        remarkFrontmatter,
                                                    ]}
                                                >
                                                    {editedContent}
                                                </ReactMarkdown>
                                            </div>
                                        ) : isJsonFile(fileContent.path) &&
                                          jsonPreview ? (
                                            <div className="overflow-auto p-4">
                                                <ReactJsonView
                                                    src={(() => {
                                                        try {
                                                            return JSON5.parse(
                                                                editedContent
                                                            );
                                                        } catch {
                                                            try {
                                                                return JSON.parse(
                                                                    editedContent
                                                                );
                                                            } catch {
                                                                return {
                                                                    error: "Failed to parse JSON",
                                                                    raw: editedContent,
                                                                };
                                                            }
                                                        }
                                                    })()}
                                                    theme="monokai"
                                                    collapsed={false}
                                                    enableClipboard={false}
                                                    displayDataTypes={false}
                                                    displayObjectSize={false}
                                                    indentWidth={4}
                                                    style={{ fontSize: "13px" }}
                                                />
                                            </div>
                                        ) : isCodeFile(fileContent.path) ? (
                                            codeEditMode ? (
                                                <textarea
                                                    className={
                                                        "h-full w-full resize-none bg-transparent p-4 font-mono text-sm focus:outline-none " +
                                                        syntaxClass
                                                    }
                                                    value={editedContent}
                                                    onChange={(e) =>
                                                        handleContentChange(
                                                            e.target.value
                                                        )
                                                    }
                                                    spellCheck={false}
                                                />
                                            ) : (
                                                <div className="h-full overflow-auto">
                                                    <SyntaxHighlighter
                                                        language={getLanguage(
                                                            fileContent.path
                                                        )}
                                                        style={monokai}
                                                        customStyle={{
                                                            margin: 0,
                                                            padding: "1rem",
                                                            background: "transparent",
                                                            fontSize: "13px",
                                                            height: "100%",
                                                        }}
                                                        showLineNumbers={true}
                                                        lineNumberStyle={{
                                                            minWidth: "2.5em",
                                                            paddingRight: "1em",
                                                            color: "#6b7280",
                                                        }}
                                                    >
                                                        {editedContent}
                                                    </SyntaxHighlighter>
                                                </div>
                                            )
                                        ) : isEditable ? (
                                            <textarea
                                                className={
                                                    "h-full w-full resize-none bg-transparent p-4 font-mono text-sm focus:outline-none " +
                                                    syntaxClass
                                                }
                                                value={editedContent}
                                                onChange={(e) =>
                                                    handleContentChange(e.target.value)
                                                }
                                                spellCheck={false}
                                            />
                                        ) : (
                                            <pre
                                                className={
                                                    "whitespace-pre-wrap p-4 font-mono text-sm " +
                                                    syntaxClass
                                                }
                                            >
                                                {editedContent}
                                            </pre>
                                        )}
                                    </div>
                                ) : (
                                    <div className="flex h-full items-center justify-center text-slate-400">
                                        Failed to load file
                                    </div>
                                )}
                            </div>

                            {/* Footer */}
                            {fileContent && (
                                <div className="border-t border-slate-700 p-2 text-xs text-slate-400">
                                    Modified: {formatDate(fileContent.modified)}
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="flex h-full items-center justify-center text-slate-400">
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