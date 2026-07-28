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
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import { monokaiSublime } from "react-syntax-highlighter/dist/esm/styles/hljs";

const languages = {
    bash,
    c,
    cpp,
    csharp,
    css,
    diff,
    dockerfile,
    go,
    html: xml,
    java,
    javascript,
    json,
    kotlin,
    lua,
    markdown,
    php,
    protobuf,
    python,
    ruby,
    rust,
    scala,
    scss,
    sql,
    swift,
    typescript,
    xml,
    yaml,
};
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
