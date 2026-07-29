import { AlertTriangle, File } from "lucide-react";
import { lazy, type ReactNode, Suspense } from "react";

import type { FileContent } from "../../../../../contracts/files";
import {
    formatSize,
    getLanguage,
    isCodeFile,
    isJsonFile,
    isMarkdownFile,
} from "../../../utils/fileUtilities";
import { Textarea } from "../../ui/Textarea";

const MarkdownPreview = lazy(async () => {
    const module = await import("./viewers/MarkdownPreview");
    return {
        default: module.MarkdownPreview,
    };
});
const JsonPreview = lazy(async () => {
    const module = await import("./viewers/JsonPreview");
    return { default: module.JsonPreview };
});
const CodePreview = lazy(async () => {
    const module = await import("./viewers/CodePreview");
    return { default: module.CodePreview };
});

/** Provides props for file content viewer. */
interface FileContentViewerProperties {
    fileContent: FileContent;
    editedContent: string;
    onContentChange: (value: string) => void;
    largeFileWarning: boolean;
    isEditable: boolean;
    markdownPreview: boolean;
    jsonPreview: boolean;
    codeEditMode: boolean;
    syntaxClass: string;
}

/**
 * Renders the file content viewer UI.
 * @returns Rendered the file content viewer UI.
 */
export function FileContentViewer({
    fileContent,
    editedContent,
    onContentChange,
    largeFileWarning,
    isEditable,
    markdownPreview,
    jsonPreview,
    codeEditMode,
    syntaxClass,
}: FileContentViewerProperties) {
    let content: ReactNode;
    if (fileContent.isBinary && !fileContent.isImage) {
        content = (
            <div className="flex h-full items-center justify-center text-primary-400">
                <div className="text-center">
                    <File size={48} className="mx-auto mb-2 opacity-50" />
                    <p>Binary file</p>
                    <p className="mt-1 text-xs">Cannot display binary content</p>
                </div>
            </div>
        );
    } else if (fileContent.isImage) {
        content = (
            <div className="flex h-full items-center justify-center p-3 sm:p-4">
                <img
                    src={`data:${fileContent.mimeType};base64,${fileContent.content}`}
                    alt={fileContent.path.split("/").pop() || "Image"}
                    className="max-h-full max-w-full rounded object-contain"
                />
            </div>
        );
    } else if (markdownPreview && isMarkdownFile(fileContent.path)) {
        content = (
            <Suspense
                fallback={<div className="p-4 text-primary-400">Loading preview...</div>}
            >
                <MarkdownPreview content={editedContent} />
            </Suspense>
        );
    } else if (jsonPreview && isJsonFile(fileContent.path)) {
        content = (
            <Suspense
                fallback={<div className="p-4 text-primary-400">Loading preview...</div>}
            >
                <JsonPreview content={editedContent} />
            </Suspense>
        );
    } else if (isCodeFile(fileContent.path) && !codeEditMode) {
        content = (
            <Suspense
                fallback={<div className="p-4 text-primary-400">Loading preview...</div>}
            >
                <CodePreview
                    language={getLanguage(fileContent.path)}
                    content={editedContent}
                />
            </Suspense>
        );
    } else if (isCodeFile(fileContent.path) || isEditable) {
        content = (
            <Textarea
                variant="code"
                className={syntaxClass}
                value={editedContent}
                onChange={(event_) => onContentChange(event_.target.value)}
                spellCheck={false}
            />
        );
    } else {
        content = (
            <pre
                className={
                    "overflow-auto p-3 font-mono text-xs wrap-break-word whitespace-pre-wrap sm:p-4 sm:text-sm " +
                    syntaxClass
                }
            >
                {editedContent}
            </pre>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            {largeFileWarning && (
                <div className="flex items-start gap-2 border-b border-yellow-500/50 bg-yellow-500/20 px-3 py-2 text-sm text-yellow-400 sm:items-center sm:px-4">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 sm:mt-0" />
                    Large file ({formatSize(fileContent.size)}) - preview only, editing
                    disabled
                </div>
            )}

            {content}
        </div>
    );
}
