import type { SyntaxHighlightedSourceLanguage } from "../ui/syntaxHighlightedSourceLanguage.ts";
import type { ChatToolPart } from "./chatTypes.ts";

export type ChatToolDiffLineKind = "add" | "context" | "delete" | "file" | "skip";

export interface ChatToolDiffLine {
    readonly kind: ChatToolDiffLineKind;
    readonly language?: SyntaxHighlightedSourceLanguage;
    readonly lineNumber?: number;
    readonly text: string;
}

export interface ChatToolDiff {
    readonly added: number;
    readonly files: readonly string[];
    readonly lines: readonly ChatToolDiffLine[];
    readonly removed: number;
}

interface MutableDiff {
    added: number;
    files: string[];
    lines: ChatToolDiffLine[];
    removed: number;
    language?: SyntaxHighlightedSourceLanguage;
}

interface HunkPosition {
    newLine?: number;
    oldLine?: number;
}

function toolName(name: string): string {
    const unqualified = name.startsWith("functions.")
        ? name.slice("functions.".length)
        : name;
    return unqualified.trim().toLowerCase();
}

function isPatchTool(name: string): boolean {
    return ["apply_patch", "applypatch", "patch"].includes(toolName(name));
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;
}

function patchSource(input: unknown): string | undefined {
    if (typeof input === "string") {
        const trimmed = input.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                const parsed = record(JSON.parse(trimmed) as unknown);
                if (parsed !== undefined) return patchSource(parsed);
            } catch {
                // A patch can contain JSON source without itself being JSON.
            }
        }
        return input;
    }
    const inputRecord = record(input);
    if (inputRecord === undefined) return undefined;
    for (const key of ["patch", "input", "diff"] as const) {
        const candidate = inputRecord[key];
        if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    }
    return undefined;
}

function normalizedLines(source: string): string[] {
    return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
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

function addFile(diff: MutableDiff, path: string, operation: string): void {
    const normalizedPath = path.trim();
    if (normalizedPath === "") return;
    if (!diff.files.includes(normalizedPath)) diff.files.push(normalizedPath);
    diff.language = sourceLanguage(normalizedPath);
    addLine(diff, {
        kind: "file",
        text: `${operation} ${normalizedPath}`,
    });
}

function addLine(diff: MutableDiff, line: ChatToolDiffLine): void {
    diff.lines.push(
        line.kind === "add" || line.kind === "context" || line.kind === "delete"
            ? { ...line, language: diff.language }
            : line
    );
    if (line.kind === "add") diff.added += 1;
    if (line.kind === "delete") diff.removed += 1;
}

function addSkip(diff: MutableDiff): void {
    if (diff.lines.at(-1)?.kind !== "skip") {
        addLine(diff, { kind: "skip", text: "⋯" });
    }
}

function parseHunkPosition(line: string): HunkPosition {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (match === null) return {};
    return {
        newLine: Math.trunc(Number(match[2] ?? "")),
        oldLine: Math.trunc(Number(match[1] ?? "")),
    };
}

function operationLabel(operation: "add" | "delete" | "update"): string {
    if (operation === "add") return "Add";
    if (operation === "delete") return "Delete";
    return "Update";
}

function addHunkLine(diff: MutableDiff, line: string, position: HunkPosition): void {
    if (line.startsWith("+")) {
        addLine(diff, {
            kind: "add",
            ...(position.newLine === undefined ? {} : { lineNumber: position.newLine }),
            text: line.slice(1),
        });
        if (position.newLine !== undefined) position.newLine += 1;
        return;
    }
    if (line.startsWith("-")) {
        addLine(diff, {
            kind: "delete",
            ...(position.oldLine === undefined ? {} : { lineNumber: position.oldLine }),
            text: line.slice(1),
        });
        if (position.oldLine !== undefined) position.oldLine += 1;
        return;
    }
    addLine(diff, {
        kind: "context",
        ...(position.newLine === undefined ? {} : { lineNumber: position.newLine }),
        text: line.startsWith(" ") ? line.slice(1) : line,
    });
    if (position.newLine !== undefined) position.newLine += 1;
    if (position.oldLine !== undefined) position.oldLine += 1;
}

function createMutableDiff(): MutableDiff {
    return {
        added: 0,
        files: [],
        lines: [],
        removed: 0,
    };
}

function finishDiff(diff: MutableDiff): ChatToolDiff | undefined {
    if (diff.files.length === 0 || diff.lines.length === 0) return undefined;
    return diff;
}

function structuredChangeOperation(value: unknown): "add" | "delete" | "update" {
    const type = typeof value === "string" ? value : record(value)?.type;
    return type === "add" || type === "delete" ? type : "update";
}

function structuredChangeStat(
    value: unknown
): Readonly<{ added: number; removed: number }> | undefined {
    const stat = record(value);
    const added = stat?.added;
    const removed = stat?.removed;
    return typeof added === "number" &&
        Number.isSafeInteger(added) &&
        added >= 0 &&
        typeof removed === "number" &&
        Number.isSafeInteger(removed) &&
        removed >= 0
        ? { added, removed }
        : undefined;
}

function addStructuredUpdate(diff: MutableDiff, source: string): void {
    let position: HunkPosition = {};
    for (const line of normalizedLines(source)) {
        if (line.startsWith("@@")) {
            if (diff.lines.at(-1)?.kind !== "file") addSkip(diff);
            position = parseHunkPosition(line);
            continue;
        }
        if (
            line === "" ||
            line.startsWith("+") ||
            line.startsWith("-") ||
            line.startsWith(" ")
        ) {
            addHunkLine(diff, line, position);
        }
    }
}

function addStructuredFile(
    diff: MutableDiff,
    source: string,
    operation: "add" | "delete"
): void {
    for (const [index, rawLine] of normalizedLines(source).entries()) {
        const prefix = operation === "add" ? "+" : "-";
        addLine(diff, {
            kind: operation,
            lineNumber: index + 1,
            text: rawLine.startsWith(prefix) ? rawLine.slice(1) : rawLine,
        });
    }
}

function parseStructuredChanges(input: unknown): ChatToolDiff | undefined {
    const parsedInput =
        typeof input === "string" ? (parsedJsonRecord(input) ?? input) : input;
    const changes = record(parsedInput)?.changes;
    if (!Array.isArray(changes) || changes.length === 0) return undefined;
    const diff = createMutableDiff();
    let declaredAdded = 0;
    let declaredRemoved = 0;
    let hasDeclaredStat = false;
    for (const value of changes) {
        const change = record(value);
        if (change === undefined) continue;
        const path = change.path;
        const source = change.diff;
        if (
            typeof path !== "string" ||
            path.trim() === "" ||
            typeof source !== "string"
        ) {
            continue;
        }
        const operation = structuredChangeOperation(change.kind);
        const kind = record(change.kind);
        const movePath = kind?.move_path ?? kind?.movePath;
        const target =
            operation === "update" &&
            typeof movePath === "string" &&
            movePath.trim() !== ""
                ? movePath
                : path;
        if (!diff.files.includes(target)) diff.files.push(target);
        diff.language = sourceLanguage(target);
        addLine(diff, {
            kind: "file",
            text:
                target === path
                    ? `${operationLabel(operation)} ${path}`
                    : `Move ${path} → ${target}`,
        });
        if (operation === "update") addStructuredUpdate(diff, source);
        else addStructuredFile(diff, source, operation);
        const stat = structuredChangeStat(change.stat);
        if (stat !== undefined) {
            hasDeclaredStat = true;
            declaredAdded += stat.added;
            declaredRemoved += stat.removed;
        }
    }
    const finished = finishDiff(diff);
    return finished === undefined
        ? undefined
        : {
              ...finished,
              ...(hasDeclaredStat
                  ? { added: declaredAdded, removed: declaredRemoved }
                  : {}),
          };
}

function parsedJsonRecord(value: string): Readonly<Record<string, unknown>> | undefined {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
        return record(JSON.parse(trimmed) as unknown);
    } catch {
        return undefined;
    }
}

function parseApplyPatch(source: string): ChatToolDiff | undefined {
    const diff = createMutableDiff();
    let operation: "add" | "delete" | "update" | undefined;
    let position: HunkPosition = {};
    let addLineNumber = 0;
    let deleteLineNumber = 0;

    for (const rawLine of normalizedLines(source)) {
        const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/u.exec(rawLine.trimEnd());
        if (header !== null) {
            if (header[1] === "Add") operation = "add";
            else if (header[1] === "Delete") operation = "delete";
            else operation = "update";
            const path = header[2] ?? "";
            addFile(diff, path, operationLabel(operation));
            position = {};
            addLineNumber = 0;
            deleteLineNumber = 0;
            continue;
        }
        if (operation === "update" && rawLine.startsWith("*** Move to: ")) {
            const target = rawLine.slice("*** Move to: ".length).trim();
            const sourcePath = diff.files.at(-1);
            if (sourcePath !== undefined && target !== "") {
                diff.files[diff.files.length - 1] = target;
                const fileLine = diff.lines.findLast((line) => line.kind === "file");
                if (fileLine !== undefined) {
                    const index = diff.lines.lastIndexOf(fileLine);
                    diff.lines[index] = {
                        kind: "file",
                        text: `Move ${sourcePath} → ${target}`,
                    };
                }
            }
            continue;
        }
        if (
            rawLine === "*** Begin Patch" ||
            rawLine === "*** End Patch" ||
            rawLine === "*** End of File" ||
            operation === undefined
        ) {
            continue;
        }
        if (rawLine.startsWith("@@")) {
            if (diff.lines.at(-1)?.kind !== "file") addSkip(diff);
            position = parseHunkPosition(rawLine);
            continue;
        }
        if (operation === "add" && rawLine.startsWith("+")) {
            addLineNumber += 1;
            addLine(diff, {
                kind: "add",
                lineNumber: addLineNumber,
                text: rawLine.slice(1),
            });
            continue;
        }
        if (operation === "delete" && rawLine.startsWith("-")) {
            deleteLineNumber += 1;
            addLine(diff, {
                kind: "delete",
                lineNumber: deleteLineNumber,
                text: rawLine.slice(1),
            });
            continue;
        }
        if (
            operation === "update" &&
            (rawLine === "" ||
                rawLine.startsWith("+") ||
                rawLine.startsWith("-") ||
                rawLine.startsWith(" "))
        ) {
            addHunkLine(diff, rawLine, position);
        }
    }
    return finishDiff(diff);
}

function cleanUnifiedPath(value: string): string {
    return (value.split("\t", 1)[0] ?? "").trim().replace(/^[ab]\//u, "");
}

function parseUnifiedDiff(source: string): ChatToolDiff | undefined {
    const diff = createMutableDiff();
    const lines = normalizedLines(source);
    let hasFile = false;
    let inHunk = false;
    let position: HunkPosition = {};

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const gitHeader = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
        if (gitHeader !== null) {
            addFile(diff, gitHeader[2] ?? gitHeader[1] ?? "", "Update");
            hasFile = true;
            inHunk = false;
            continue;
        }
        const nextLine = lines[index + 1];
        if (line.startsWith("--- ") && nextLine?.startsWith("+++ ")) {
            const oldPath = cleanUnifiedPath(line.slice(4));
            const newPath = cleanUnifiedPath(nextLine.slice(4));
            let operation = "Update";
            if (oldPath === "/dev/null") operation = "Add";
            else if (newPath === "/dev/null") operation = "Delete";
            const path = newPath === "/dev/null" ? oldPath : newPath;
            if (!hasFile || diff.files.at(-1) !== path) addFile(diff, path, operation);
            index += 1;
            hasFile = true;
            continue;
        }
        if (line.startsWith("@@")) {
            if (diff.lines.at(-1)?.kind !== "file") addSkip(diff);
            position = parseHunkPosition(line);
            inHunk = true;
            continue;
        }
        if (
            inHunk &&
            (line === "" ||
                line.startsWith("+") ||
                line.startsWith("-") ||
                line.startsWith(" "))
        ) {
            addHunkLine(diff, line, position);
        }
    }
    return finishDiff(diff);
}

/**
 * Returns a bounded file diff for apply-patch tool activity.
 * @param part Provider-neutral tool part.
 * @returns Parsed file changes, or undefined when the input is not a supported diff.
 */
export function chatToolDiff(
    part: Pick<ChatToolPart, "input" | "name">
): ChatToolDiff | undefined {
    if (!isPatchTool(part.name)) return undefined;
    const structured = parseStructuredChanges(part.input);
    if (structured !== undefined) return structured;
    const source = patchSource(part.input);
    if (source === undefined || source.trim() === "") return undefined;
    return /(?:^|\n)\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/u.test(
        source
    )
        ? parseApplyPatch(source)
        : parseUnifiedDiff(source);
}
