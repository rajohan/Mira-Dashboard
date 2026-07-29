import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import {
    Light as HighlightJsSyntaxHighlighter,
    PrismLight as PrismSyntaxHighlighter,
} from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/hljs/bash";
import c from "react-syntax-highlighter/dist/esm/languages/hljs/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/hljs/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/hljs/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/hljs/css";
import diff from "react-syntax-highlighter/dist/esm/languages/hljs/diff";
import dockerfile from "react-syntax-highlighter/dist/esm/languages/hljs/dockerfile";
import go from "react-syntax-highlighter/dist/esm/languages/hljs/go";
import java from "react-syntax-highlighter/dist/esm/languages/hljs/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/hljs/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/hljs/json";
import kotlin from "react-syntax-highlighter/dist/esm/languages/hljs/kotlin";
import lua from "react-syntax-highlighter/dist/esm/languages/hljs/lua";
import markdown from "react-syntax-highlighter/dist/esm/languages/hljs/markdown";
import php from "react-syntax-highlighter/dist/esm/languages/hljs/php";
import protobuf from "react-syntax-highlighter/dist/esm/languages/hljs/protobuf";
import python from "react-syntax-highlighter/dist/esm/languages/hljs/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/hljs/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/hljs/rust";
import scala from "react-syntax-highlighter/dist/esm/languages/hljs/scala";
import scss from "react-syntax-highlighter/dist/esm/languages/hljs/scss";
import sql from "react-syntax-highlighter/dist/esm/languages/hljs/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/hljs/swift";
import typescript from "react-syntax-highlighter/dist/esm/languages/hljs/typescript";
import xml from "react-syntax-highlighter/dist/esm/languages/hljs/xml";
import yaml from "react-syntax-highlighter/dist/esm/languages/hljs/yaml";
import { monokaiSublime } from "react-syntax-highlighter/dist/esm/styles/hljs";
import graphql from "refractor/graphql";

type HighlightLanguage = (...arguments_: unknown[]) => unknown;

/**
 * Validates one untyped react-syntax-highlighter language module.
 * @param value Imported language module.
 * @returns Validated Highlight.js language definition.
 */
function highlightLanguage(value: unknown): HighlightLanguage {
    if (typeof value !== "function") {
        throw new TypeError("Invalid Highlight.js language module");
    }
    return value as HighlightLanguage;
}

const languages = {
    bash: highlightLanguage(bash),
    c: highlightLanguage(c),
    cpp: highlightLanguage(cpp),
    csharp: highlightLanguage(csharp),
    css: highlightLanguage(css),
    diff: highlightLanguage(diff),
    dockerfile: highlightLanguage(dockerfile),
    go: highlightLanguage(go),
    html: highlightLanguage(xml),
    java: highlightLanguage(java),
    javascript: highlightLanguage(javascript),
    json: highlightLanguage(json),
    kotlin: highlightLanguage(kotlin),
    lua: highlightLanguage(lua),
    markdown: highlightLanguage(markdown),
    php: highlightLanguage(php),
    protobuf: highlightLanguage(protobuf),
    python: highlightLanguage(python),
    ruby: highlightLanguage(ruby),
    rust: highlightLanguage(rust),
    scala: highlightLanguage(scala),
    scss: highlightLanguage(scss),
    sql: highlightLanguage(sql),
    swift: highlightLanguage(swift),
    typescript: highlightLanguage(typescript),
    xml: highlightLanguage(xml),
    yaml: highlightLanguage(yaml),
} satisfies Record<string, HighlightLanguage>;
const prismLanguages = { graphql };

function monokaiStyle(name: string) {
    return monokaiSublime[name] ?? {};
}

const prismMonokaiSublime: NonNullable<SyntaxHighlighterProps["style"]> = {
    'code[class*="language-"]': monokaiStyle("hljs"),
    'pre[class*="language-"]': monokaiStyle("hljs"),
    "attr-name": monokaiStyle("hljs-attribute"),
    "attr-value": monokaiStyle("hljs-string"),
    boolean: monokaiStyle("hljs-number"),
    builtin: monokaiStyle("hljs-built_in"),
    "class-name": monokaiStyle("hljs-title"),
    comment: monokaiStyle("hljs-comment"),
    constant: monokaiStyle("hljs-number"),
    function: monokaiStyle("hljs-title"),
    keyword: monokaiStyle("hljs-keyword"),
    number: monokaiStyle("hljs-number"),
    operator: monokaiStyle("hljs"),
    property: monokaiStyle("hljs-attr"),
    punctuation: monokaiStyle("hljs-tag"),
    string: monokaiStyle("hljs-string"),
    tag: monokaiStyle("hljs-name"),
    variable: monokaiStyle("hljs-variable"),
};

for (const [name, language] of Object.entries(languages)) {
    HighlightJsSyntaxHighlighter.registerLanguage(name, language);
}
for (const [name, language] of Object.entries(prismLanguages)) {
    PrismSyntaxHighlighter.registerLanguage(name, language);
}

/**
 * Uses the smaller Highlight.js registry generally and Prism's GraphQL grammar
 * only where Highlight.js has no equivalent language module.
 * @returns Code syntax highlighter result.
 */
export function CodeSyntaxHighlighter({
    language,
    style,
    ...properties
}: SyntaxHighlighterProps) {
    return language === "graphql" ? (
        <PrismSyntaxHighlighter
            {...properties}
            language={language}
            style={prismMonokaiSublime}
        />
    ) : (
        <HighlightJsSyntaxHighlighter {...properties} language={language} style={style} />
    );
}
