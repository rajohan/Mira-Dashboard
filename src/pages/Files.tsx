import { X } from "lucide-react";

import { FileEditorPanel, FilesSidebar } from "../components/features/files";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { RefreshButton } from "../components/ui/RefreshButton";
import { useFileExplorerState } from "../hooks/useFileExplorerState";
import { getSyntaxClass } from "../utils/fileUtils";

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
                    <RefreshButton
                        onClick={handleRefresh}
                        isLoading={isLoading}
                        disabled={isLoading}
                    />
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
                <FilesSidebar
                    files={files}
                    rootLoading={rootLoading}
                    selectedPath={selectedPath}
                    expandedPaths={expandedPaths}
                    onSelect={handleSelect}
                    onToggle={handleToggle}
                />

                <FileEditorPanel
                    selectedPath={selectedPath}
                    fileContent={fileContent}
                    contentLoading={contentLoading}
                    isEditable={isEditable}
                    hasChanges={hasChanges}
                    savePending={saveMutation.isPending}
                    editedContent={editedContent}
                    largeFileWarning={largeFileWarning}
                    markdownPreview={markdownPreview}
                    jsonPreview={jsonPreview}
                    codeEditMode={codeEditMode}
                    syntaxClass={syntaxClass}
                    onSave={() => {
                        void handleSave();
                    }}
                    onContentChange={handleContentChange}
                    onMarkdownPreviewChange={setMarkdownPreview}
                    onJsonPreviewChange={setJsonPreview}
                    onCodePreviewChange={(preview) => setCodeEditMode(!preview)}
                />
            </div>
        </div>
    );
}
