import ReactJsonView from "@microlink/react-json-view";
import JSON5 from "json5";
import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter";
import { monokai } from "react-syntax-highlighter/dist/esm/styles/hljs";
import remarkGfm from "remark-gfm";

import { cn } from "../../../utils/cn";

const JSON_LANGUAGES = new Set(["json", "json5", "jsonc"]);

function childrenToText(children: ReactNode): string {
    if (typeof children === "string" || typeof children === "number") {
        return String(children);
    }

    if (Array.isArray(children)) {
        return children.map(childrenToText).join("");
    }

    if (isValidElement<{ children?: ReactNode }>(children)) {
        return childrenToText(children.props.children);
    }

    return "";
}

function codeLanguageFromClassName(className?: string): string {
    const language = className?.match(/language-([^\s]+)/)?.[1]?.toLowerCase();
    return language || "text";
}

function normalizeSyntaxLanguage(language: string): string {
    const aliases: Record<string, string> = {
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        py: "python",
        sh: "bash",
        zsh: "bash",
        fish: "bash",
        rs: "rust",
        yml: "yaml",
        json5: "json",
        jsonc: "json",
    };

    return aliases[language] || language;
}

function looksLikeJson(code: string): boolean {
    const trimmed = code.trim();
    return (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
    );
}

function parseJsonBlock(code: string): object | null {
    try {
        const parsed = JSON5.parse(code) as unknown;
        return typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
    } catch {
        return null;
    }
}

function getPreCodeBlock(children: ReactNode): { code: string; language: string } | null {
    const child = Children.toArray(children)[0];

    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        return null;
    }

    return {
        code: childrenToText(child.props.children).replace(/\n$/, ""),
        language: codeLanguageFromClassName(child.props.className),
    };
}

function ChatCodeBlock({ code, language }: { code: string; language: string }) {
    const shouldTryJson = JSON_LANGUAGES.has(language) || looksLikeJson(code);
    const parsedJson = shouldTryJson ? parseJsonBlock(code) : null;

    if (parsedJson) {
        return (
            <div className="my-2 max-w-full overflow-hidden rounded-lg border border-white/10 bg-black/25">
                <div className="border-b border-white/10 px-3 py-1 text-[10px] uppercase tracking-wide text-primary-400">
                    {JSON_LANGUAGES.has(language) ? language : "json"}
                </div>
                <div className="max-w-full overflow-x-auto p-3">
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
        <div className="my-2 max-w-full overflow-hidden rounded-lg border border-white/10 bg-black/25">
            <div className="border-b border-white/10 px-3 py-1 text-[10px] uppercase tracking-wide text-primary-400">
                {language}
            </div>
            <SyntaxHighlighter
                language={normalizeSyntaxLanguage(language)}
                style={monokai}
                customStyle={{
                    margin: 0,
                    padding: "0.75rem",
                    background: "transparent",
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
            </SyntaxHighlighter>
        </div>
    );
}

const markdownComponents: Components = {
    a(props) {
        const { node, className, ...anchorProps } = props;
        void node;

        return (
            <a
                {...anchorProps}
                target="_blank"
                rel="noreferrer"
                className={cn(
                    "decoration-current/50 text-inherit underline underline-offset-2 hover:opacity-80",
                    className
                )}
            />
        );
    },
    blockquote(props) {
        const { node, className, ...blockquoteProps } = props;
        void node;

        return (
            <blockquote
                {...blockquoteProps}
                className={cn(
                    "border-current/30 border-l-2 pl-3 italic opacity-90",
                    className
                )}
            />
        );
    },
    code(props) {
        const { node, className, ...codeProps } = props;
        void node;

        return (
            <code
                {...codeProps}
                className={cn(
                    "rounded bg-black/25 px-1 py-0.5 font-mono text-[0.92em]",
                    className
                )}
            />
        );
    },
    img(props) {
        const { node, src, alt } = props;
        void node;

        if (!src) {
            return null;
        }

        return (
            <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className="decoration-current/50 text-inherit underline underline-offset-2 hover:opacity-80"
            >
                {alt || src}
            </a>
        );
    },
    pre(props) {
        const { node, className, children, ...preProps } = props;
        void node;

        const codeBlock = getPreCodeBlock(children);
        if (codeBlock) {
            return <ChatCodeBlock code={codeBlock.code} language={codeBlock.language} />;
        }

        return (
            <pre
                {...preProps}
                className={cn(
                    "my-2 max-w-full overflow-x-auto rounded-lg border border-white/10 bg-black/25 p-3 font-mono text-[12px] leading-relaxed",
                    className
                )}
            >
                {children}
            </pre>
        );
    },
    table(props) {
        const { node, className, ...tableProps } = props;
        void node;

        return (
            <div className="my-2 max-w-full overflow-x-auto">
                <table
                    {...tableProps}
                    className={cn(
                        "min-w-full border-collapse text-left text-xs",
                        className
                    )}
                />
            </div>
        );
    },
    td(props) {
        const { node, className, ...tdProps } = props;
        void node;

        return (
            <td
                {...tdProps}
                className={cn("border-current/20 border px-2 py-1", className)}
            />
        );
    },
    th(props) {
        const { node, className, ...thProps } = props;
        void node;

        return (
            <th
                {...thProps}
                className={cn(
                    "border-current/20 border bg-white/5 px-2 py-1 font-semibold",
                    className
                )}
            />
        );
    },
};

export function ChatMarkdown({ text }: { text: string }) {
    return (
        <div
            className={cn(
                "prose prose-invert max-w-none whitespace-pre-wrap break-words text-sm leading-relaxed text-inherit",
                "prose-headings:my-2 prose-headings:text-inherit prose-p:my-2 prose-p:text-inherit prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5",
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
