import type { SyntaxHighlightedSourceLanguage } from "../ui/syntaxHighlightedSourceLanguage.ts";

export interface ChatToolSourceDetail {
    readonly content: string;
    readonly label?: string;
    readonly language: SyntaxHighlightedSourceLanguage | "plaintext";
}

interface ChatToolSourceContext {
    readonly input?: unknown;
    readonly name: string;
    readonly placement: "input" | "output";
}

interface NumberedSourceRequest {
    readonly endLine: number;
    readonly path: string;
    readonly startLine: number;
}

interface SourceRangeRequest {
    readonly endLine: number;
    readonly path: string;
    readonly startLine: number;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;
}

function parsedJson(value: string): Readonly<{ value: unknown }> | undefined {
    const trimmed = value.trim();
    if (trimmed === "" || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
        return undefined;
    }
    try {
        return { value: JSON.parse(trimmed) as unknown };
    } catch {
        return undefined;
    }
}

function leadingJson(
    value: string
): Readonly<{ parsed: unknown; remainder: string }> | undefined {
    const offset = value.search(/\S/u);
    if (offset < 0) return undefined;
    const first = value[offset];
    if (first !== "{" && first !== "[") return undefined;
    const stack: string[] = [];
    let escaped = false;
    let quoted = false;
    for (let index = offset; index < value.length; index += 1) {
        const character = value[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') {
            quoted = true;
            continue;
        }
        if (character === "{" || character === "[") {
            stack.push(character);
            continue;
        }
        if (character !== "}" && character !== "]") continue;
        const expected = character === "}" ? "{" : "[";
        if (stack.pop() !== expected) return undefined;
        if (stack.length > 0) continue;
        const source = value.slice(offset, index + 1);
        try {
            return {
                parsed: JSON.parse(source) as unknown,
                remainder: value.slice(index + 1).trim(),
            };
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function normalizedToolName(name: string): string {
    const unqualified = name.startsWith("functions.")
        ? name.slice("functions.".length)
        : name;
    return unqualified.toLowerCase().split("__").at(-1) ?? unqualified.toLowerCase();
}

function inputPath(value: unknown): string | undefined {
    const parsedResult = typeof value === "string" ? parsedJson(value) : undefined;
    const parsed = parsedResult === undefined ? value : parsedResult.value;
    const input = record(parsed);
    if (input === undefined) return undefined;
    for (const key of [
        "path",
        "file_path",
        "filePath",
        "file",
        "filepath",
        "filename",
        "notebook_path",
    ] as const) {
        const candidate = input[key];
        if (typeof candidate === "string" && candidate.trim() !== "") {
            return candidate;
        }
    }
    return undefined;
}

function inputCommand(value: unknown): string | undefined {
    const parsedResult = typeof value === "string" ? parsedJson(value) : undefined;
    const input = record(parsedResult === undefined ? value : parsedResult.value);
    if (input === undefined) return undefined;
    const command = input.command ?? input.cmd;
    return typeof command === "string" && command.trim() !== "" ? command : undefined;
}

function shellCommandBody(command: string): string {
    const trimmed = command.trim();
    const doubleQuoted = /^(?:\/bin\/)?(?:bash|sh|zsh)\s+-lc\s+"([\s\S]*)"$/u.exec(
        trimmed
    );
    if (doubleQuoted?.[1] !== undefined) return doubleQuoted[1];
    const singleQuoted = /^(?:\/bin\/)?(?:bash|sh|zsh)\s+-lc\s+'([\s\S]*)'$/u.exec(
        trimmed
    );
    return singleQuoted?.[1] ?? trimmed;
}

function sedSourceRangeRequest(command: string): SourceRangeRequest | undefined {
    const body = shellCommandBody(command);
    const match =
        /^\s*sed\s+-n\s+(?:'(\d+)(?:,(\d+))?p'|"(\d+)(?:,(\d+))?p")\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&<>]+))\s*$/u.exec(
            body
        );
    const startLine = Number(match?.[1] ?? match?.[3]);
    const endLine = Number(match?.[2] ?? match?.[4] ?? startLine);
    const path = match?.[5] ?? match?.[6] ?? match?.[7];
    if (
        path === undefined ||
        path.trim() === "" ||
        !Number.isSafeInteger(startLine) ||
        !Number.isSafeInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine
    ) {
        return undefined;
    }
    return { endLine, path, startLine };
}

function sourceLanguage(path: string): SyntaxHighlightedSourceLanguage | undefined {
    const lowerPath = path.toLowerCase();
    const fileName = lowerPath.split("/").at(-1) ?? lowerPath;
    if (fileName === "dockerfile") return "dockerfile";
    const extension = fileName.split(".").at(-1);
    if (["ts", "tsx", "mts", "cts"].includes(extension ?? "")) {
        return "typescript";
    }
    if (["js", "jsx", "mjs", "cjs"].includes(extension ?? "")) {
        return "javascript";
    }
    if (["json", "jsonc"].includes(extension ?? "")) return "json";
    if (["sh", "bash", "zsh"].includes(extension ?? "")) return "shell";
    if (["css", "scss"].includes(extension ?? "")) return "css";
    if (["html", "htm"].includes(extension ?? "")) return "html";
    if (["md", "mdx"].includes(extension ?? "")) return "markdown";
    if (extension === "py") return "python";
    if (extension === "sql") return "sql";
    if (["yaml", "yml"].includes(extension ?? "")) return "yaml";
    if (["xml", "svg"].includes(extension ?? "")) return "xml";
    return undefined;
}

function numberedSourceRequests(command: string): readonly NumberedSourceRequest[] {
    const requests: NumberedSourceRequest[] = [];
    const pattern =
        /\bnl\s+-ba\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))\s*\|\s*sed\s+-n\s+(['"])(\d+),(\d+)p\4/gu;
    for (const match of command.matchAll(pattern)) {
        const path = match[1] ?? match[2] ?? match[3];
        const startLine = Number(match[5]);
        const endLine = Number(match[6]);
        if (
            path === undefined ||
            path.trim() === "" ||
            !Number.isSafeInteger(startLine) ||
            !Number.isSafeInteger(endLine) ||
            startLine < 1 ||
            endLine < startLine
        ) {
            return [];
        }
        requests.push({ endLine, path, startLine });
    }
    return requests;
}

function numberedLine(value: string): number | undefined {
    const match = /^\s*(\d+)(?:\s|\t)/u.exec(value);
    const line = Number(match?.[1]);
    return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function numberedCommandOutputDetails(
    value: string,
    context: ChatToolSourceContext
): readonly ChatToolSourceDetail[] | undefined {
    if (context.placement !== "output") return undefined;
    const name = normalizedToolName(context.name);
    if (!["bash", "exec", "exec_command", "shell", "run_command"].includes(name)) {
        return undefined;
    }
    const command = inputCommand(context.input);
    if (command === undefined) return undefined;
    const requests = numberedSourceRequests(command);
    if (requests.length === 0) return undefined;
    const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const details: ChatToolSourceDetail[] = [];
    let offset = 0;
    for (const [index, request] of requests.entries()) {
        const requestedCount = request.endLine - request.startLine + 1;
        const remaining = lines.length - offset;
        const count = index === requests.length - 1 ? remaining : requestedCount;
        if (count < 1 || count > requestedCount) return undefined;
        const section = lines.slice(offset, offset + count);
        if (
            !section.every(
                (line, lineIndex) => numberedLine(line) === request.startLine + lineIndex
            )
        ) {
            return undefined;
        }
        details.push({
            content: section.join("\n"),
            label: `${request.path} · lines ${request.startLine}–${request.startLine + count - 1}`,
            language: sourceLanguage(request.path) ?? "plaintext",
        });
        offset += count;
    }
    return offset === lines.length ? details : undefined;
}

function sourceRangeCommandOutputDetails(
    value: string,
    context: ChatToolSourceContext
): readonly ChatToolSourceDetail[] | undefined {
    if (context.placement !== "output") return undefined;
    const name = normalizedToolName(context.name);
    if (!["bash", "exec", "exec_command", "shell", "run_command"].includes(name)) {
        return undefined;
    }
    const command = inputCommand(context.input);
    if (command === undefined) return undefined;
    const request = sedSourceRangeRequest(command);
    if (request === undefined || /^(?:bash|sed|sh|zsh):/u.test(value.trimStart())) {
        return undefined;
    }
    const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lines = normalized.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const actualEndLine = Math.min(
        request.endLine,
        request.startLine + Math.max(0, lines.length - 1)
    );
    return [
        {
            content: normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized,
            label: `${request.path} · lines ${request.startLine}–${actualEndLine}`,
            language: sourceLanguage(request.path) ?? "plaintext",
        },
    ];
}

function inferredPlaintextLanguage(
    context: ChatToolSourceContext
): SyntaxHighlightedSourceLanguage | "plaintext" {
    if (context.placement !== "output") return "plaintext";
    const name = normalizedToolName(context.name);
    if (["web_fetch", "webfetch"].includes(name)) return "markdown";
    if (
        !["read", "read_file", "readfile", "notebook_read", "notebookread"].includes(name)
    ) {
        return "plaintext";
    }
    const path = inputPath(context.input);
    return path === undefined ? "plaintext" : (sourceLanguage(path) ?? "plaintext");
}

function jsonDetail(value: unknown): ChatToolSourceDetail {
    try {
        const content = JSON.stringify(value, undefined, 2);
        return content === undefined
            ? { content: "Detail could not be displayed.", language: "plaintext" }
            : { content, language: "json" };
    } catch {
        return { content: "Detail could not be displayed.", language: "plaintext" };
    }
}

function mediaBlockDetail(
    block: Readonly<Record<string, unknown>>
): ChatToolSourceDetail {
    const type = typeof block.type === "string" ? block.type : "media";
    const mimeType = typeof block.mimeType === "string" ? ` (${block.mimeType})` : "";
    return {
        content: `${type.charAt(0).toUpperCase()}${type.slice(1)} output${mimeType}.`,
        language: "plaintext",
    };
}

function detailsFromText(
    value: string,
    context: ChatToolSourceContext,
    depth: number
): readonly ChatToolSourceDetail[] {
    const numberedDetails = numberedCommandOutputDetails(value, context);
    if (numberedDetails !== undefined) return numberedDetails;
    const prefix = leadingJson(value);
    if (prefix !== undefined && prefix.remainder !== "") {
        return [
            ...detailsFromValue(prefix.parsed, context, depth + 1),
            {
                content: prefix.remainder,
                language: inferredPlaintextLanguage(context),
            },
        ];
    }
    const sourceRangeDetails = sourceRangeCommandOutputDetails(value, context);
    if (sourceRangeDetails !== undefined) return sourceRangeDetails;
    const parsed = parsedJson(value);
    if (parsed !== undefined) {
        return detailsFromValue(parsed.value, context, depth + 1);
    }
    return [{ content: value, language: inferredPlaintextLanguage(context) }];
}

function contentBlockDetails(
    content: readonly unknown[],
    context: ChatToolSourceContext,
    depth: number
): readonly ChatToolSourceDetail[] | undefined {
    if (content.length === 0 || content.length > 64) return undefined;
    const details: ChatToolSourceDetail[] = [];
    for (const value of content) {
        const block = record(value);
        if (block === undefined || typeof block.type !== "string") return undefined;
        const type = block.type.toLowerCase();
        if (
            (type === "text" || type === "output_text") &&
            typeof block.text === "string"
        ) {
            details.push(...detailsFromText(block.text, context, depth + 1));
            continue;
        }
        const resource = type === "resource" ? record(block.resource) : undefined;
        if (resource !== undefined && typeof resource.text === "string") {
            details.push(...detailsFromText(resource.text, context, depth + 1));
            continue;
        }
        if (type === "image" || type === "audio") {
            details.push(mediaBlockDetail(block));
            continue;
        }
        details.push(jsonDetail(block));
    }
    return details;
}

function detailsFromValue(
    value: unknown,
    context: ChatToolSourceContext,
    depth: number
): readonly ChatToolSourceDetail[] {
    if (depth > 4) return [jsonDetail(value)];
    if (typeof value === "string") return detailsFromText(value, context, depth);
    const valueRecord = record(value);
    if (valueRecord !== undefined && Array.isArray(valueRecord.content)) {
        const details = contentBlockDetails(valueRecord.content, context, depth + 1);
        if (details !== undefined) return details;
    }
    if (value === undefined) return [];
    if (value === null || typeof value === "object") return [jsonDetail(value)];
    if (
        typeof value === "boolean" ||
        typeof value === "bigint" ||
        typeof value === "number"
    ) {
        return [{ content: `${value}`, language: "plaintext" }];
    }
    return [{ content: "Detail could not be displayed.", language: "plaintext" }];
}

/**
 * Projects provider-neutral tool data into readable source blocks.
 * @param value Bounded input or output retained by the chat adapter.
 * @param context Tool identity and source placement used for safe language inference.
 * @returns Structured text blocks without interpreting tool output as Markdown or HTML.
 */
export function chatToolSourceDetails(
    value: unknown,
    context: ChatToolSourceContext
): readonly ChatToolSourceDetail[] {
    return detailsFromValue(value, context, 0);
}
