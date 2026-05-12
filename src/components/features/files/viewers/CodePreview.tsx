import SyntaxHighlighter from "react-syntax-highlighter";
import { monokai } from "react-syntax-highlighter/dist/esm/styles/hljs";

/** Provides props for code preview. */
interface CodePreviewProps {
    language: string;
    content: string;
}

/** Renders the code preview UI. */
export function CodePreview({ language, content }: CodePreviewProps) {
    return (
        <div className="h-full min-w-0 overflow-auto">
            <SyntaxHighlighter
                language={language}
                style={monokai}
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
            </SyntaxHighlighter>
        </div>
    );
}
