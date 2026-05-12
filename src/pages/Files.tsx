import { X } from "lucide-react";

import { FileEditorPanel, FilesSidebar } from "../components/features/files";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { RefreshButton } from "../components/ui/RefreshButton";
import { useFileExplorerState } from "../hooks/useFileExplorerState";
import { getSyntaxClass } from "../utils/fileUtils";

/** Renders the files UI. */
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
    } = useFileExplorerState();

    const isLoading = rootLoading || contentLoading;
    const isEditable = !!(fileContent && !fileContent.isBinary && !largeFileWarning);
    const syntaxClass = fileContent
        ? getSyntaxClass(fileContent.path.split("/").pop() || "")
        : "";

    return (
        <div className="flex h-full min-h-0 flex-col p-3 sm:p-4 lg:p-6">
            <div className="mb-3 flex items-center justify-end sm:mb-4 lg:mb-6">
                <RefreshButton
                    onClick={handleRefresh}
                    isLoading={isLoading}
                    disabled={isLoading}
                />
            </div>

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

            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-4">
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
                    isJsonEditing={isJsonEditing}
                    jsonValidation={jsonValidation}
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
