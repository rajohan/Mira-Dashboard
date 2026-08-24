import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/classNames.ts";
import { SyntaxHighlightedSource } from "./SyntaxHighlightedSource.tsx";
import {
    supportsSyntaxHighlightedSourceLanguage,
    type SyntaxHighlightedSourceLanguage,
} from "./syntaxHighlightedSourceLanguage.ts";

interface MarkdownProps extends Omit<ComponentProps<typeof ReactMarkdown>, "children"> {
    readonly className?: string;
    readonly source: string;
}

const markdownSyntaxHighlightMaximumLength = 256 * 1024;
const markdownSyntaxLanguageAliases: Readonly<
    Record<string, SyntaxHighlightedSourceLanguage>
> = Object.freeze({
    bash: "shell",
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    py: "python",
    sh: "shell",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
    zsh: "shell",
});

function markdownSyntaxLanguage(
    className: string | undefined
): SyntaxHighlightedSourceLanguage | undefined {
    const languageClass = className
        ?.split(/\s+/u)
        .find((value) => value.startsWith("language-"));
    const language = languageClass?.slice("language-".length).toLowerCase();
    if (language === undefined || language.length === 0) return undefined;

    const alias = markdownSyntaxLanguageAliases[language];
    if (alias !== undefined) return alias;
    return supportsSyntaxHighlightedSourceLanguage(language) ? language : undefined;
}

const sharedMarkdownComponents = {
    code({ children, className, node: _node, ...properties }) {
        const language = markdownSyntaxLanguage(className);
        if (
            language !== undefined &&
            typeof children === "string" &&
            children.length <= markdownSyntaxHighlightMaximumLength
        ) {
            return (
                <SyntaxHighlightedSource
                    content={children.replace(/\n$/u, "")}
                    language={language}
                    numbered={false}
                />
            );
        }
        return (
            <code
                {...properties}
                className={cn(
                    "rounded bg-black/25 box-decoration-clone px-1 py-0.5 font-mono text-[0.92em]",
                    className
                )}
            >
                {children}
            </code>
        );
    },
} satisfies Components;

/**
 * Renders Markdown without enabling raw HTML. Resource-bearing elements remain
 * caller-controlled through ReactMarkdown component overrides.
 * @returns Sanitizer-independent Markdown presentation using safe React nodes.
 */
export function Markdown({
    className,
    components,
    source,
    ...properties
}: MarkdownProps) {
    return (
        <div
            className={cn(
                "prose prose-invert prose-sm prose-a:text-accent-300 prose-code:text-primary-100 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-primary-950 max-w-none wrap-break-word [&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit",
                className
            )}
        >
            <ReactMarkdown
                {...properties}
                components={{ ...sharedMarkdownComponents, ...components }}
                remarkPlugins={[remarkGfm]}
            >
                {source}
            </ReactMarkdown>
        </div>
    );
}
