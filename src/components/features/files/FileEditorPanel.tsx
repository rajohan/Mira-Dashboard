import { Eye, File, Save } from "lucide-react";

import type { FileContent } from "../../../types/file";
import {
    formatSize,
    isCodeFile,
    isJsonFile,
    isMarkdownFile,
} from "../../../utils/fileUtilities";
import { formatDate } from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { FileContentViewer } from "./FileContentViewer";
import { PreviewToggle } from "./PreviewToggle";

/** Provides props for file editor panel. */
interface FileEditorPanelProperties {
    selectedPath: string | undefined;
    fileContent?: FileContent;
    contentLoading: boolean;
    isEditable: boolean;
    hasChanges: boolean;
    savePending: boolean;
    revealPending?: boolean;
    editedContent: string;
    largeFileWarning: boolean;
    markdownPreview: boolean;
    jsonPreview: boolean;
    codeEditMode: boolean;
    syntaxClass: string;
    isJsonEditing: boolean;
    jsonValidation: { valid: boolean; error: string | undefined };
    onSave: () => void;
    onReveal?: () => void;
    onContentChange: (value: string) => void;
    onMarkdownPreviewChange: (isValue: boolean) => void;
    onJsonPreviewChange: (isValue: boolean) => void;
    onCodePreviewChange: (isPreview: boolean) => void;
}

/** Renders the file editor panel UI. */
export function FileEditorPanel({
    selectedPath,
    fileContent,
    contentLoading,
    isEditable,
    hasChanges,
    savePending,
    revealPending = false,
    editedContent,
    largeFileWarning,
    markdownPreview,
    jsonPreview,
    codeEditMode,
    syntaxClass,
    isJsonEditing,
    jsonValidation,
    onSave,
    onReveal = () => {},
    onContentChange,
    onMarkdownPreviewChange,
    onJsonPreviewChange,
    onCodePreviewChange,
}: FileEditorPanelProperties) {
    return (
        <Card
            variant="bordered"
            className="flex min-h-128 min-w-0 flex-1 flex-col overflow-hidden p-0 lg:min-h-0"
        >
            {selectedPath ? (
                <>
                    <div className="flex flex-col gap-3 border-b border-primary-700 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                        <div className="flex min-w-0 items-center gap-2">
                            <File size={16} className="shrink-0 text-primary-400" />
                            <span
                                className="min-w-0 font-mono text-xs break-all sm:truncate sm:text-sm"
                                title={selectedPath}
                            >
                                {selectedPath}
                            </span>
                            {fileContent && (
                                <span className="shrink-0 text-xs text-primary-400">
                                    {formatSize(fileContent.size)}
                                </span>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                            {fileContent &&
                                isMarkdownFile(fileContent.path) &&
                                isEditable && (
                                    <PreviewToggle
                                        isPreview={markdownPreview}
                                        onToggle={onMarkdownPreviewChange}
                                    />
                                )}
                            {fileContent &&
                                isJsonFile(fileContent.path) &&
                                isEditable && (
                                    <PreviewToggle
                                        isPreview={jsonPreview}
                                        onToggle={onJsonPreviewChange}
                                    />
                                )}
                            {fileContent &&
                                isCodeFile(fileContent.path) &&
                                isEditable && (
                                    <PreviewToggle
                                        isPreview={!codeEditMode}
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
                            {fileContent?.masked ? (
                                <>
                                    <span className="text-xs text-yellow-400">
                                        Secrets masked
                                    </span>
                                    <Button
                                        disabled={revealPending}
                                        onClick={onReveal}
                                        size="sm"
                                        variant="secondary"
                                    >
                                        <Eye size={14} />
                                        {revealPending
                                            ? "Revealing..."
                                            : "Reveal secrets"}
                                    </Button>
                                </>
                            ) : undefined}
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
                                    <Save size={14} />
                                    {savePending ? "Saving..." : "Save"}
                                </Button>
                            )}
                        </div>
                    </div>

                    {fileContent?.maskingError ? (
                        <div className="border-b border-yellow-800/70 bg-yellow-950/40 px-4 py-3 text-sm text-yellow-200">
                            {fileContent.maskingError === "truncated_json"
                                ? "The masked preview is unavailable because this config exceeds the safe preview limit. Reveal is read-only for oversized files."
                                : "The masked preview is unavailable because this config is not valid JSON. Verify with MFA and reveal it to repair the raw file."}
                        </div>
                    ) : undefined}

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
                            <span className="wrap-break-word">
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
