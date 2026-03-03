import ReactJsonView from "@microlink/react-json-view";
import JSON5 from "json5";
import { AlertTriangle, File } from "lucide-react";
import ReactMarkdown from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter";
import { monokai } from "react-syntax-highlighter/dist/esm/styles/hljs";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import { type FileContent } from "../../../types/file";
import { formatSize, isMarkdownFile, isJsonFile, isCodeFile, getLanguage } from "../../../utils/fileUtils";

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
        <div className="flex h-full flex-col">
            {largeFileWarning && (
                <div className="flex items-center gap-2 border-b border-yellow-500/50 bg-yellow-500/20 px-4 py-2 text-sm text-yellow-400">
                    <AlertTriangle size={14} />
                    Large file ({formatSize(fileContent.size)}) - preview only, editing disabled
                </div>
            )}

            {fileContent.isBinary && !fileContent.isImage ? (
                <div className="flex h-full items-center justify-center text-slate-400">
                    <div className="text-center">
                        <File size={48} className="mx-auto mb-2 opacity-50" />
                        <p>Binary file</p>
                        <p className="mt-1 text-xs">Cannot display binary content</p>
                    </div>
                </div>
            ) : fileContent.isImage ? (
                <div className="flex h-full items-center justify-center p-4">
                    <img
                        src={"data:" + fileContent.mimeType + ";base64," + fileContent.content}
                        alt={fileContent.path.split("/").pop() || "Image"}
                        className="max-h-full max-w-full rounded object-contain"
                    />
                </div>
            ) : isMarkdownFile(fileContent.path) && markdownPreview ? (
                <div className="prose prose-invert max-w-none p-6 prose-headings:mb-4 prose-headings:mt-6 prose-p:my-4 prose-blockquote:my-4 prose-pre:my-4 prose-ol:my-4 prose-ul:my-4 prose-li:my-1 prose-table:my-4 prose-hr:my-6">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkFrontmatter]}>
                        {editedContent}
                    </ReactMarkdown>
                </div>
            ) : isJsonFile(fileContent.path) && jsonPreview ? (
                <div className="overflow-auto p-4">
                    <ReactJsonView
                        src={(() => {
                            try {
                                return JSON5.parse(editedContent);
                            } catch {
                                try {
                                    return JSON.parse(editedContent);
                                } catch {
                                    return { error: "Failed to parse JSON", raw: editedContent };
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
                        onChange={(e) => onContentChange(e.target.value)}
                        spellCheck={false}
                    />
                ) : (
                    <div className="h-full overflow-auto">
                        <SyntaxHighlighter
                            language={getLanguage(fileContent.path)}
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
                    onChange={(e) => onContentChange(e.target.value)}
                    spellCheck={false}
                />
            ) : (
                <pre className={"whitespace-pre-wrap p-4 font-mono text-sm " + syntaxClass}>
                    {editedContent}
                </pre>
            )}
        </div>
    );
}