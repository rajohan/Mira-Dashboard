import os from "node:os";
import path from "node:path";

import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { guardedPath, readdirGuardedAsync, statGuardedAsync } from "../lib/guardedOps.ts";

interface CompletionRequest {
    cwd?: string;
    partial: string;
}

interface CdRequest {
    cwd: string;
    path: string;
}

interface CdResponse {
    error?: string;
    isSuccess: boolean;
    newCwd: string;
}

interface CompletionItem {
    completion: string;
    display: string;
    type: "file" | "directory" | "executable";
}

interface CompletionResponse {
    commonPrefix: string;
    completions: CompletionItem[];
}

const HOME_DIR = os.homedir();
const SHELL_ESCAPE_RE = /([\s\\'"$`!&|;<>()*?[\]{}])/gu;

async function readTerminalJson<T>(request: Request): Promise<T | Response> {
    try {
        return await readJson<T>(request);
    } catch (error) {
        return json(
            { error: errorMessage(error, "Invalid request body") },
            { status: httpStatusCode(error) }
        );
    }
}

function expandPath(inputPath: string, cwd: string): string {
    if (inputPath.includes("\0")) return cwd;
    if (inputPath.startsWith("/")) return inputPath;
    if (inputPath.startsWith("~/")) return HOME_DIR + inputPath.slice(1);
    if (inputPath === "~") return HOME_DIR;
    return path.join(cwd, inputPath);
}

function unescapeShellToken(token: string): string {
    let output = "";
    let quote: "'" | '"' | null = null;
    let isEscaped = false;
    for (const character of token) {
        if (isEscaped) {
            output += character;
            isEscaped = false;
            continue;
        }
        if (character === "\\") {
            isEscaped = true;
            continue;
        }
        if ((character === "'" || character === '"') && quote === null) {
            quote = character;
            continue;
        }
        if (character === quote) {
            quote = null;
            continue;
        }
        output += character;
    }
    if (isEscaped) output += "\\";
    return output;
}

function completionInput(input: string): { pathPart: string; prefix: string } {
    let quote: "'" | '"' | null = null;
    let isEscaped = false;
    let tokenStart = 0;
    for (let index = 0; index < input.length; ) {
        const character = input.codePointAt(index);
        if (character === undefined) break;
        const characterText = String.fromCodePoint(character);
        const nextIndex = index + characterText.length;
        if (isEscaped) {
            isEscaped = false;
            index = nextIndex;
            continue;
        }
        if (characterText === "\\") {
            isEscaped = true;
            index = nextIndex;
            continue;
        }
        if ((characterText === "'" || characterText === '"') && quote === null) {
            quote = characterText;
            index = nextIndex;
            continue;
        }
        if (characterText === quote) {
            quote = null;
            index = nextIndex;
            continue;
        }
        if (quote === null && /\s/u.test(characterText)) {
            tokenStart = nextIndex;
        }
        index = nextIndex;
    }
    return {
        pathPart: unescapeShellToken(input.slice(tokenStart)),
        prefix: input.slice(0, tokenStart),
    };
}

function escapeShellPath(value: string): string {
    return value.replaceAll(SHELL_ESCAPE_RE, String.raw`\$1`);
}

async function getCompletions(
    partial: string,
    cwd: string,
    statFile = statGuardedAsync
): Promise<CompletionResponse> {
    const { pathPart, prefix } = completionInput(partial);

    let searchDirectory: string;
    let searchPrefix: string;
    let directoryPart = "";

    if (pathPart.includes("/")) {
        const lastSlashIndex = pathPart.lastIndexOf("/");
        directoryPart = pathPart.slice(0, lastSlashIndex + 1);
        searchPrefix = pathPart.slice(lastSlashIndex + 1);
        searchDirectory = expandPath(directoryPart, cwd);
    } else {
        searchDirectory = cwd;
        searchPrefix = pathPart;
    }

    try {
        const entries = await readdirGuardedAsync(guardedPath(searchDirectory), {
            withFileTypes: true,
        });
        const matches: CompletionItem[] = [];

        for (const entry of entries) {
            const name = entry.name;
            if (
                !name.startsWith(searchPrefix) ||
                (searchPrefix === "" && name.startsWith("."))
            ) {
                continue;
            }
            const fullPath = path.join(searchDirectory, name);
            let type: CompletionItem["type"] = "file";
            if (entry.isDirectory()) {
                type = "directory";
            } else if (entry.isFile()) {
                try {
                    const stats = await statFile(guardedPath(fullPath));
                    if (stats.mode & 0o111) type = "executable";
                } catch {
                    // ignore unavailable entries
                }
            }

            matches.push({
                completion:
                    prefix +
                    escapeShellPath(pathPart.includes("/") ? directoryPart + name : name),
                display: name + (type === "directory" ? "/" : ""),
                type,
            });
        }

        matches.sort((a, b) => {
            const typeOrder = { directory: 0, executable: 1, file: 2 };
            if (typeOrder[a.type] !== typeOrder[b.type]) {
                return typeOrder[a.type] - typeOrder[b.type];
            }
            return a.display.localeCompare(b.display);
        });

        let commonPrefix = "";
        if (matches.length > 0) {
            const first = matches[0].completion;
            let index = first.length;
            while (index >= searchPrefix.length) {
                const candidate = first.slice(0, index);
                if (matches.every((match) => match.completion.startsWith(candidate))) {
                    commonPrefix = candidate;
                    break;
                }
                index -= 1;
            }
        }

        return { commonPrefix, completions: matches.slice(0, 20) };
    } catch {
        return { commonPrefix: "", completions: [] };
    }
}

export const terminalRoutes = {
    "/api/terminal/complete": {
        POST: async (request: Request) => {
            const body = await readTerminalJson<CompletionRequest | null>(request);
            if (body instanceof Response) return body;
            if (!body || typeof body !== "object") {
                return json({ error: "Missing or invalid body" }, { status: 400 });
            }

            const { cwd, partial } = body;
            if (typeof partial !== "string" || partial.includes("\0")) {
                return json({ error: "Missing or invalid partial" }, { status: 400 });
            }
            const trimmedCwd = typeof cwd === "string" ? cwd.trim() : undefined;
            if (
                cwd !== undefined &&
                (typeof cwd !== "string" ||
                    !trimmedCwd ||
                    trimmedCwd.includes("\0") ||
                    !path.isAbsolute(trimmedCwd))
            ) {
                return json({ error: "Missing or invalid cwd" }, { status: 400 });
            }
            return json(await getCompletions(partial, trimmedCwd || HOME_DIR));
        },
    },

    "/api/terminal/cd": {
        POST: async (request: Request) => {
            const body = await readTerminalJson<CdRequest | null>(request);
            if (body instanceof Response) return body;
            if (!body || typeof body !== "object") {
                return json(
                    {
                        error: "Missing or invalid body",
                        isSuccess: false,
                        newCwd: HOME_DIR,
                    } satisfies CdResponse,
                    { status: 400 }
                );
            }
            const resolvedCwd = typeof body.cwd === "string" ? body.cwd : HOME_DIR;
            const targetPath = body.path;

            if (
                resolvedCwd.includes("\0") ||
                (typeof body.cwd === "string" &&
                    (!body.cwd.trim() || !body.cwd.startsWith("/"))) ||
                !targetPath ||
                typeof targetPath !== "string" ||
                targetPath.includes("\0")
            ) {
                return json(
                    {
                        error: "Missing or invalid path",
                        isSuccess: false,
                        newCwd: resolvedCwd,
                    } satisfies CdResponse,
                    { status: 400 }
                );
            }

            let newPath: string;
            if (targetPath === "~") {
                newPath = HOME_DIR;
            } else if (targetPath.startsWith("~/")) {
                newPath = HOME_DIR + targetPath.slice(1);
            } else if (targetPath.startsWith("/")) {
                newPath = targetPath;
            } else {
                newPath = path.join(resolvedCwd, targetPath);
            }

            const resolvedParts: string[] = [];
            const pathParts = newPath.split("/").filter(Boolean);
            for (const part of pathParts) {
                if (part === "..") {
                    resolvedParts.pop();
                } else if (part !== ".") {
                    resolvedParts.push(part);
                }
            }
            newPath = `/${resolvedParts.join("/")}`;

            try {
                const stats = await statGuardedAsync(guardedPath(newPath));
                if (!stats.isDirectory()) {
                    return json(
                        {
                            error: `Not a directory: ${targetPath}`,
                            isSuccess: false,
                            newCwd: resolvedCwd,
                        } satisfies CdResponse,
                        { status: 400 }
                    );
                }
                return json({ isSuccess: true, newCwd: newPath } satisfies CdResponse);
            } catch {
                return json(
                    {
                        error: `No such file or directory: ${targetPath}`,
                        isSuccess: false,
                        newCwd: resolvedCwd,
                    } satisfies CdResponse,
                    { status: 400 }
                );
            }
        },
    },
} as const;
