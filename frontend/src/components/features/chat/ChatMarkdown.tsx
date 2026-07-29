import ReactJsonView from "@microlink/react-json-view";
import ReactMarkdown, { type Components } from "react-markdown";
import { monokaiSublime } from "react-syntax-highlighter/dist/esm/styles/hljs";
import remarkGfm from "remark-gfm";

import { CodeSyntaxHighlighter } from "../../../lib/syntaxHighlighter";
import { cn } from "../../../utils/cn";
import {
    getPreCodeBlock,
    isJsonLike,
    JSON_LANGUAGES,
    normalizeSyntaxLanguage,
    parseJsonBlock,
} from "./chatMarkdownUtilities";

/**
 * Renders the chat code block UI.
 * @returns Rendered the chat code block UI.
 */
function ChatCodeBlock({ code, language }: { code: string; language: string }) {
    const shouldTryJson = JSON_LANGUAGES.has(language) || isJsonLike(code);
    const parsedJson = shouldTryJson ? parseJsonBlock(code) : undefined;

    if (parsedJson) {
        return (
            <div className="my-1.5 max-w-full overflow-hidden rounded-lg border border-white/10 bg-black/25">
                <div className="border-b border-white/10 px-2 py-0.5 text-[10px] tracking-wide text-primary-400 uppercase">
                    {JSON_LANGUAGES.has(language) ? language : "json"}
                </div>
                <div className="max-w-full overflow-x-auto p-2">
                    <ReactJsonView
                        src={parsedJson}
                        name={false}
                        theme="monokai"
                        collapsed={false}
                        enableClipboard={false}
                        displayDataTypes={false}
                        displayObjectSize={false}
                        indentWidth={4}
                        style={{
                            backgroundColor: "transparent",
                            fontSize: "13px",
                        }}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="my-1.5 max-w-full overflow-hidden rounded-lg border border-white/10 bg-black/25">
            <div className="border-b border-white/10 px-2 py-0.5 text-[10px] tracking-wide text-primary-400 uppercase">
                {language}
            </div>
            <CodeSyntaxHighlighter
                language={normalizeSyntaxLanguage(language)}
                style={monokaiSublime}
                customStyle={{
                    margin: 0,
                    padding: "0.5rem",
                    fontSize: "12px",
                }}
                showLineNumbers={true}
                lineNumberStyle={{
                    minWidth: "2.5em",
                    paddingRight: "1em",
                    color: "#6b7280",
                }}
            >
                {code}
            </CodeSyntaxHighlighter>
        </div>
    );
}

const markdownComponents: Components = {
    a(properties) {
        const { node, className, children, ...anchorProperties } = properties;
        void node;

        return (
            <a
                {...anchorProperties}
                target="_blank"
                rel="noreferrer"
                className={cn(
                    "text-inherit underline decoration-current/50 underline-offset-2 hover:opacity-80",
                    className
                )}
            >
                {children}
            </a>
        );
    },
    blockquote(properties) {
        const { node, className, ...blockquoteProperties } = properties;
        void node;

        return (
            <blockquote
                {...blockquoteProperties}
                className={cn(
                    "my-1 border-l-2 border-current/30 pl-2 italic opacity-90",
                    className
                )}
            />
        );
    },
    code(properties) {
        const { node, className, ...codeProperties } = properties;
        void node;

        return (
            <code
                {...codeProperties}
                className={cn(
                    "rounded bg-black/25 px-1 py-0.5 font-mono text-[0.92em]",
                    className
                )}
            />
        );
    },
    img(properties) {
        const { node, src, alt } = properties;
        void node;

        if (!src) {
            return;
        }

        return (
            <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className="text-inherit underline decoration-current/50 underline-offset-2 hover:opacity-80"
            >
                {alt || src}
            </a>
        );
    },
    pre(properties) {
        const { node, className, children, ...preProperties } = properties;
        void node;

        const codeBlock = getPreCodeBlock(children);
        if (codeBlock) {
            return <ChatCodeBlock code={codeBlock.code} language={codeBlock.language} />;
        }
        return (
            <pre
                {...preProperties}
                className={cn(
                    "my-1.5 max-w-full overflow-x-auto rounded-lg border border-white/10 bg-black/25 p-2 font-mono text-[12px] leading-normal",
                    className
                )}
            >
                {children}
            </pre>
        );
    },
    table(properties) {
        const { node, className, ...tableProperties } = properties;
        void node;

        return (
            <div className="my-1.5 max-w-full overflow-x-auto">
                <table
                    {...tableProperties}
                    className={cn(
                        "min-w-full border-collapse text-left text-xs",
                        className
                    )}
                />
            </div>
        );
    },
    td(properties) {
        const { node, className, ...tdProperties } = properties;
        void node;

        return (
            <td
                {...tdProperties}
                className={cn("border border-current/20 px-1.5 py-0.5", className)}
            />
        );
    },
    th(properties) {
        const { node, className, ...thProperties } = properties;
        void node;

        return (
            <th
                {...thProperties}
                className={cn(
                    "border border-current/20 bg-white/5 px-1.5 py-0.5 font-semibold",
                    className
                )}
            />
        );
    },
};

/**
 * Renders the chat markdown UI.
 * @returns Rendered the chat markdown UI.
 */
export function ChatMarkdown({ text }: { text: string }) {
    return (
        <div
            className={cn(
                "prose max-w-none text-sm leading-normal wrap-break-word whitespace-pre-wrap text-inherit prose-invert",
                "prose-headings:mt-1.5 prose-headings:mb-1 prose-headings:text-inherit prose-p:my-1 prose-ol:my-1 prose-ul:my-1 prose-li:m-0 prose-li:p-0",
                "[&_li+li]:mt-0 [&_li>p]:my-0 [&_ol]:space-y-0 [&_ol]:whitespace-normal [&_ul]:space-y-0 [&_ul]:whitespace-normal",
                "prose-strong:text-inherit prose-code:text-inherit prose-code:before:content-none prose-code:after:content-none prose-pre:bg-transparent prose-pre:p-0",
                "[&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit"
            )}
        >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {text}
            </ReactMarkdown>
        </div>
    );
}
