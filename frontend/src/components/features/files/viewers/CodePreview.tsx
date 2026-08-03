import { monokaiSublime } from "react-syntax-highlighter/dist/esm/styles/hljs";

import { CodeSyntaxHighlighter } from "../../../../lib/syntaxHighlighter";
import { CopyButton } from "../../../ui/CopyButton";

/** Provides props for code preview. */
interface CodePreviewProperties {
    language: string;
    content: string;
}

/**
 * Renders the code preview UI.
 * @returns Rendered the code preview UI.
 */
export function CodePreview({ language, content }: CodePreviewProperties) {
    return (
        <div className="flex h-full min-w-0 flex-col">
            <div className="flex shrink-0 justify-end border-b border-primary-700 px-2 py-1">
                <CopyButton content={content} label="Copy code" />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
                <CodeSyntaxHighlighter
                    language={language}
                    style={monokaiSublime}
                    customStyle={{
                        margin: 0,
                        padding: "1rem",
                        fontSize: "12px",
                        minHeight: "100%",
                    }}
                    showLineNumbers={true}
                    lineNumberStyle={{
                        minWidth: "2.5em",
                        paddingRight: "1em",
                        color: "#6b7280",
                    }}
                >
                    {content}
                </CodeSyntaxHighlighter>
            </div>
        </div>
    );
}
