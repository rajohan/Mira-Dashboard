import { File, Folder, RefreshCw, Save, Settings, X } from "lucide-react";

import {
    ConfigSection,
    FileContentViewer,
    FileTreeItem,
    PreviewToggle,
} from "../components/features/files";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { PageHeader } from "../components/ui/PageHeader";
import { useFileExplorerState } from "../hooks/useFileExplorerState";
import {
    formatSize,
    getSyntaxClass,
    isCodeFile,
    isJsonFile,
    isMarkdownFile,
} from "../utils/fileUtils";
import { formatDate } from "../utils/format";

export function Files() {
    const {
        files,
        expandedPaths,
        selectedPath,
        editedContent,
        hasChanges,
        largeFileWarning,
        markdownPreview,
        jsonPreview,
        codeEditMode,
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
    } = useFileExplorerState();

    const isLoading = rootLoading || contentLoading;
    const isEditable = !!(fileContent && !fileContent.isBinary && !largeFileWarning);
    const syntaxClass = fileContent
        ? getSyntaxClass(fileContent.path.split("/").pop() || "")
        : "";

    return (
        <div className="flex h-full flex-col p-6">
            <PageHeader
                title="Files"
                actions={
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleRefresh}
                        disabled={isLoading}
                    >
                        <RefreshCw
                            size={16}
                            className={"mr-1 " + (isLoading ? "animate-spin" : "")}
                        />
                        Refresh
                    </Button>
                }
            />

            {error && (
                <Alert variant="error">
                    {error}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => setError(null)}
                    >
                        <X size={16} />
                    </Button>
                </Alert>
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
                            {rootLoading && files.length === 0 ? (
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
                                            <PreviewToggle
                                                preview={markdownPreview}
                                                onToggle={setMarkdownPreview}
                                            />
                                        )}
                                    {/* JSON preview toggle */}
                                    {fileContent &&
                                        isJsonFile(fileContent.path) &&
                                        isEditable && (
                                            <PreviewToggle
                                                preview={jsonPreview}
                                                onToggle={setJsonPreview}
                                            />
                                        )}
                                    {/* Code edit toggle */}
                                    {fileContent &&
                                        isCodeFile(fileContent.path) &&
                                        isEditable && (
                                            <PreviewToggle
                                                preview={!codeEditMode}
                                                onToggle={(preview) =>
                                                    setCodeEditMode(!preview)
                                                }
                                                previewLabel="Preview"
                                                editLabel="Edit"
                                            />
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
                                            onClick={handleSave}
                                            disabled={
                                                saveMutation.isPending || !hasChanges
                                            }
                                        >
                                            <Save size={14} className="mr-1" />
                                            {saveMutation.isPending
                                                ? "Saving..."
                                                : "Save"}
                                        </Button>
                                    )}
                                </div>
                            </div>

                            {/* Content */}
                            <div className="flex-1 overflow-hidden">
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
                                        Modified:{" "}
                                        {fileContent.modified
                                            ? formatDate(fileContent.modified)
                                            : "Unknown"}
                                    </span>
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
