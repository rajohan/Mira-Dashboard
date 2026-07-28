import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
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

for (const [name, language] of Object.entries(languages)) {
    SyntaxHighlighter.registerLanguage(name, language);
}

export { Light as CodeSyntaxHighlighter } from "react-syntax-highlighter";
