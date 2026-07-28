import { monokaiSublime } from "react-syntax-highlighter/dist/esm/styles/hljs";

import { CodeSyntaxHighlighter } from "../../../../lib/syntaxHighlighter";

/** Provides props for code preview. */
interface CodePreviewProperties {
    language: string;
    content: string;
}

/** Renders the code preview UI. */
export function CodePreview({ language, content }: CodePreviewProperties) {
    return (
        <div className="h-full min-w-0 overflow-auto">
            <CodeSyntaxHighlighter
                language={language}
                style={monokaiSublime}
                customStyle={{
                    margin: 0,
                    padding: "1rem",
                    background: "transparent",
                    fontSize: "12px",
                    height: "100%",
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
    );
}
