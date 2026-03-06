import { File, Save } from "lucide-react";

import type { FileContent } from "../../../types/file";
import {
    formatSize,
    isCodeFile,
    isJsonFile,
    isMarkdownFile,
} from "../../../utils/fileUtils";
import { formatDate } from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { FileContentViewer } from "./FileContentViewer";
import { PreviewToggle } from "./PreviewToggle";

interface FileEditorPanelProps {
    selectedPath: string | null;
    fileContent?: FileContent;
    contentLoading: boolean;
    isEditable: boolean;
    hasChanges: boolean;
    savePending: boolean;
    editedContent: string;
    largeFileWarning: boolean;
    markdownPreview: boolean;
    jsonPreview: boolean;
    codeEditMode: boolean;
    syntaxClass: string;
    isJsonEditing: boolean;
    jsonValidation: { valid: boolean; error: string | null };
    onSave: () => void;
    onContentChange: (value: string) => void;
    onMarkdownPreviewChange: (value: boolean) => void;
    onJsonPreviewChange: (value: boolean) => void;
    onCodePreviewChange: (preview: boolean) => void;
}

export function FileEditorPanel({
    selectedPath,
    fileContent,
    contentLoading,
    isEditable,
    hasChanges,
    savePending,
    editedContent,
    largeFileWarning,
    markdownPreview,
    jsonPreview,
    codeEditMode,
    syntaxClass,
    isJsonEditing,
    jsonValidation,
    onSave,
    onContentChange,
    onMarkdownPreviewChange,
    onJsonPreviewChange,
    onCodePreviewChange,
}: FileEditorPanelProps) {
    return (
        <Card variant="bordered" className="flex flex-1 flex-col overflow-hidden p-0">
            {selectedPath ? (
                <>
                    <div className="flex items-center justify-between gap-4 border-b border-primary-700 p-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <File size={16} className="flex-shrink-0 text-primary-400" />
                            <span
                                className="truncate font-mono text-sm"
                                title={selectedPath}
                            >
                                {selectedPath}
                            </span>
                            {fileContent && (
                                <span className="flex-shrink-0 text-xs text-primary-400">
                                    {formatSize(fileContent.size)}
                                </span>
                            )}
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                            {fileContent &&
                                isMarkdownFile(fileContent.path) &&
                                isEditable && (
                                    <PreviewToggle
                                        preview={markdownPreview}
                                        onToggle={onMarkdownPreviewChange}
                                    />
                                )}
                            {fileContent &&
                                isJsonFile(fileContent.path) &&
                                isEditable && (
                                    <PreviewToggle
                                        preview={jsonPreview}
                                        onToggle={onJsonPreviewChange}
                                    />
                                )}
                            {fileContent &&
                                isCodeFile(fileContent.path) &&
                                isEditable && (
                                    <PreviewToggle
                                        preview={!codeEditMode}
                                        onToggle={onCodePreviewChange}
                                        previewLabel="Preview"
                                        editLabel="Edit"
                                    />
                                )}
                            {hasChanges && (
                                <span className="text-xs text-yellow-400">
                                    Unsaved changes
                                </span>
                            )}
                            {isJsonEditing && (
                                <span
                                    className={
                                        "text-xs " +
                                        (jsonValidation.valid
                                            ? "text-green-400"
                                            : "text-red-400")
                                    }
                                    title={
                                        jsonValidation.valid
                                            ? "Valid JSON"
                                            : `Invalid JSON: ${jsonValidation.error || "parse error"}`
                                    }
                                >
                                    {jsonValidation.valid ? "Valid JSON" : "Invalid JSON"}
                                </span>
                            )}
                            {isEditable && (
                                <Button
                                    variant="primary"
                                    size="sm"
                                    onClick={onSave}
                                    disabled={
                                        savePending ||
                                        !hasChanges ||
                                        (isJsonEditing && !jsonValidation.valid)
                                    }
                                >
                                    <Save size={14} className="mr-1" />
                                    {savePending ? "Saving..." : "Save"}
                                </Button>
                            )}
                        </div>
                    </div>

                    <div className="flex-1 overflow-hidden">
                        {contentLoading ? (
                            <div className="flex h-full items-center justify-center text-primary-400">
                                Loading...
                            </div>
                        ) : fileContent ? (
                            <FileContentViewer
                                fileContent={fileContent}
                                editedContent={editedContent}
                                onContentChange={onContentChange}
                                largeFileWarning={largeFileWarning}
                                isEditable={isEditable}
                                markdownPreview={markdownPreview}
                                jsonPreview={jsonPreview}
                                codeEditMode={codeEditMode}
                                syntaxClass={syntaxClass}
                            />
                        ) : (
                            <div className="flex h-full items-center justify-center text-primary-400">
                                Failed to load file
                            </div>
                        )}
                    </div>

                    {fileContent && (
                        <div className="flex items-center justify-between border-t border-primary-700 px-4 py-2 text-xs text-primary-400">
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
                <div className="flex h-full items-center justify-center text-primary-400">
                    Select a file to view
                </div>
            )}
        </Card>
    );
}
