import type { ComponentPropsWithoutRef } from "react";
import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
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

for (const [language, definition] of Object.entries(sourceHighlightLanguages)) {
    SyntaxHighlighter.registerLanguage(language, definition);
}

interface SyntaxHighlightedSourceProps {
    readonly content: string;
    readonly language: SyntaxHighlightedSourceLanguage;
    readonly numbered: boolean;
}

const sourceLineProperties = Object.freeze({ className: "source-viewer-line" });

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
            className={`syntax-highlighted-source source-viewer-lines${
                numbered ? " source-viewer-lines-numbered" : ""
            }`}
            data-language={language}
            data-testid="syntax-highlighted-source"
            language={language}
            lineProps={sourceLineProperties}
            useInlineStyles={false}
            wrapLines={true}
        >
            {content}
        </SyntaxHighlighter>
    );
}
