import type { ComponentPropsWithoutRef } from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/hljs/bash";
import css from "react-syntax-highlighter/dist/esm/languages/hljs/css";
import dockerfile from "react-syntax-highlighter/dist/esm/languages/hljs/dockerfile";
import javascript from "react-syntax-highlighter/dist/esm/languages/hljs/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/hljs/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/hljs/markdown";
import python from "react-syntax-highlighter/dist/esm/languages/hljs/python";
import sql from "react-syntax-highlighter/dist/esm/languages/hljs/sql";
import typescript from "react-syntax-highlighter/dist/esm/languages/hljs/typescript";
import xml from "react-syntax-highlighter/dist/esm/languages/hljs/xml";
import yaml from "react-syntax-highlighter/dist/esm/languages/hljs/yaml";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/light";

import {
    sourceViewerLineClassName,
    sourceViewerLinesClassName,
} from "./sourceViewerStyles.ts";
import type { SyntaxHighlightedSourceLanguage } from "./syntaxHighlightedSourceLanguage.ts";

type HighlightLanguage = (...arguments_: unknown[]) => unknown;

function highlightLanguage(value: unknown): HighlightLanguage {
    if (typeof value !== "function") {
        throw new TypeError("Invalid source-highlight language module");
    }
    return value as HighlightLanguage;
}

const sourceHighlightLanguages = Object.freeze({
    css: highlightLanguage(css),
    dockerfile: highlightLanguage(dockerfile),
    html: highlightLanguage(xml),
    javascript: highlightLanguage(javascript),
    json: highlightLanguage(json),
    markdown: highlightLanguage(markdown),
    python: highlightLanguage(python),
    shell: highlightLanguage(bash),
    sql: highlightLanguage(sql),
    typescript: highlightLanguage(typescript),
    xml: highlightLanguage(xml),
    yaml: highlightLanguage(yaml),
}) satisfies Record<SyntaxHighlightedSourceLanguage, HighlightLanguage>;

const sourceHighlightClassName = String.raw`syntax-highlighted-source text-[#f8f8f2]
    [&_:is(.hljs-tag,.hljs-subst,.hljs-params)]:text-[#f8f8f2]
    [&_.hljs-class_.hljs-title]:text-[#f8f8f2]
    [&_.hljs-strong]:font-bold [&_.hljs-strong]:text-[#a8a8a2]
    [&_.hljs-emphasis]:text-[#a8a8a2] [&_.hljs-emphasis]:italic
    [&_:is(.hljs-bullet,.hljs-quote,.hljs-literal,.hljs-number,.hljs-regexp,.hljs-link)]:text-[#ae81ff]
    [&_:is(.hljs-code,.hljs-section,.hljs-title,.hljs-selector-class)]:text-[#a6e22e]
    [&_:is(.hljs-keyword,.hljs-selector-tag,.hljs-name,.hljs-attr)]:text-[#ff367d]
    [&_:is(.hljs-symbol,.hljs-attribute)]:text-[#66d9ef]
    [&_:is(.hljs-string,.hljs-type,.hljs-built\_in,.hljs-builtin-name,.hljs-selector-id,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-addition,.hljs-variable,.hljs-template-variable)]:text-[#e6db74]
    [&_:is(.hljs-comment,.hljs-deletion,.hljs-meta)]:text-[#918d78]`;

for (const [language, definition] of Object.entries(sourceHighlightLanguages)) {
    SyntaxHighlighter.registerLanguage(language, definition);
}

interface SyntaxHighlightedSourceProps {
    readonly content: string;
    readonly language: SyntaxHighlightedSourceLanguage;
    readonly numbered: boolean;
}

const sourceLineProperties: Readonly<
    Record<"numbered" | "plain", NonNullable<SyntaxHighlighterProps["lineProps"]>>
> = Object.freeze({
    numbered: Object.freeze({ className: sourceViewerLineClassName(true) }),
    plain: Object.freeze({ className: sourceViewerLineClassName(false) }),
});

function HighlightCode({
    style: _style,
    ...properties
}: ComponentPropsWithoutRef<"code">) {
    return <code {...properties} />;
}

function HighlightTokens({
    style: _style,
    ...properties
}: ComponentPropsWithoutRef<"span">) {
    return <span {...properties} />;
}

/**
 * Parses bounded source into safe React spans through a fixed grammar registry.
 * @returns Highlighted source without raw HTML or automatic language detection.
 */
export function SyntaxHighlightedSource({
    content,
    language,
    numbered,
}: SyntaxHighlightedSourceProps) {
    return (
        <SyntaxHighlighter
            CodeTag={HighlightTokens}
            PreTag={HighlightCode}
            className={`${sourceHighlightClassName} ${sourceViewerLinesClassName}${
                numbered ? " source-viewer-lines-numbered" : ""
            }`}
            data-language={language}
            data-testid="syntax-highlighted-source"
            language={language}
            lineProps={sourceLineProperties[numbered ? "numbered" : "plain"]}
            useInlineStyles={false}
            wrapLines={true}
        >
            {content}
        </SyntaxHighlighter>
    );
}
