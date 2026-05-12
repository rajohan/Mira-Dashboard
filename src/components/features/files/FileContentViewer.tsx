import { AlertTriangle, File } from "lucide-react";
import { lazy, Suspense } from "react";

import { type FileContent } from "../../../types/file";
import {
    formatSize,
    getLanguage,
    isCodeFile,
    isJsonFile,
    isMarkdownFile,
} from "../../../utils/fileUtils";
import { Textarea } from "../../ui/Textarea";

const MarkdownPreview = lazy(() =>
    import("./viewers/MarkdownPreview").then((module) => ({
        default: module.MarkdownPreview,
    }))
);
const JsonPreview = lazy(() =>
    import("./viewers/JsonPreview").then((module) => ({ default: module.JsonPreview }))
);
const CodePreview = lazy(() =>
    import("./viewers/CodePreview").then((module) => ({ default: module.CodePreview }))
);

/** Describes file content viewer props. */
interface FileContentViewerProps {
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

/** Renders the file content viewer UI. */
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
}: FileContentViewerProps) {
    return (
        <div className="flex h-full min-h-0 flex-col">
            {largeFileWarning && (
                <div className="flex items-start gap-2 border-b border-yellow-500/50 bg-yellow-500/20 px-3 py-2 text-sm text-yellow-400 sm:items-center sm:px-4">
                    <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 sm:mt-0" />
                    Large file ({formatSize(fileContent.size)}) - preview only, editing
                    disabled
                </div>
            )}

            {fileContent.isBinary && !fileContent.isImage ? (
                <div className="text-primary-400 flex h-full items-center justify-center">
                    <div className="text-center">
                        <File size={48} className="mx-auto mb-2 opacity-50" />
                        <p>Binary file</p>
                        <p className="mt-1 text-xs">Cannot display binary content</p>
                    </div>
                </div>
            ) : fileContent.isImage ? (
                <div className="flex h-full items-center justify-center p-3 sm:p-4">
                    <img
                        src={
                            "data:" +
                            fileContent.mimeType +
                            ";base64," +
                            fileContent.content
                        }
                        alt={fileContent.path.split("/").pop() || "Image"}
                        className="max-h-full max-w-full rounded object-contain"
                    />
                </div>
            ) : isMarkdownFile(fileContent.path) && markdownPreview ? (
                <Suspense
                    fallback={
                        <div className="text-primary-400 p-4">Loading preview...</div>
                    }
                >
                    <MarkdownPreview content={editedContent} />
                </Suspense>
            ) : isJsonFile(fileContent.path) && jsonPreview ? (
                <Suspense
                    fallback={
                        <div className="text-primary-400 p-4">Loading preview...</div>
                    }
                >
                    <JsonPreview content={editedContent} />
                </Suspense>
            ) : isCodeFile(fileContent.path) ? (
                codeEditMode ? (
                    <Textarea
                        variant="code"
                        className={syntaxClass}
                        value={editedContent}
                        onChange={(e) => onContentChange(e.target.value)}
                        spellCheck={false}
                    />
                ) : (
                    <Suspense
                        fallback={
                            <div className="text-primary-400 p-4">Loading preview...</div>
                        }
                    >
                        <CodePreview
                            language={getLanguage(fileContent.path)}
                            content={editedContent}
                        />
                    </Suspense>
                )
            ) : isEditable ? (
                <Textarea
                    variant="code"
                    className={syntaxClass}
                    value={editedContent}
                    onChange={(e) => onContentChange(e.target.value)}
                    spellCheck={false}
                />
            ) : (
                <pre
                    className={
                        "overflow-auto p-3 font-mono text-xs break-words whitespace-pre-wrap sm:p-4 sm:text-sm " +
                        syntaxClass
                    }
                >
                    {editedContent}
                </pre>
            )}
        </div>
    );
}
