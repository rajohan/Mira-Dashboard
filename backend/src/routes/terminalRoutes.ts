import os from "node:os";
import path from "node:path";

import type {
    TerminalCdRequest,
    TerminalCdResponse as CdResponse,
    TerminalCompletionItem as CompletionItem,
    TerminalCompletionRequest,
    TerminalCompletionResponse as CompletionResponse,
} from "../../../contracts/terminal.ts";
import {
    parseTerminalCdRequest,
    parseTerminalCompletionRequest,
} from "../../../contracts/terminal.ts";
import { json } from "../http.ts";
import { guardedPath, readdirGuardedAsync, statGuardedAsync } from "../lib/guardedOps.ts";
import {
    readApiJson,
    routeErrorResponse,
    routeFailureResponse,
} from "../routeSupport.ts";

const HOME_DIR = os.homedir();
const SHELL_ESCAPE_RE = /([\s\\'"$`!&|;<>()*?[\]{}])/gu;

function expandPath(inputPath: string, cwd: string): string {
    if (inputPath.includes("\0")) return cwd;
    if (inputPath.startsWith("/")) return inputPath;
    if (inputPath.startsWith("~/")) return HOME_DIR + inputPath.slice(1);
    if (inputPath === "~") return HOME_DIR;
    return path.join(cwd, inputPath);
}

function unescapeShellToken(token: string): string {
    let output = "";
    let quote: "'" | '"' | undefined;
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
        if (quote === undefined && (character === "'" || character === '"')) {
            quote = character;
            continue;
        }
        if (character === quote) {
            quote = undefined;
            continue;
        }
        output += character;
    }
    if (isEscaped) output += "\\";
    return output;
}

function completionInput(input: string): { pathPart: string; prefix: string } {
    let quote: "'" | '"' | undefined;
    let isEscaped = false;
    let tokenStart = 0;
    for (let index = 0; index < input.length;) {
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
        if (quote === undefined && (characterText === "'" || characterText === '"')) {
            quote = characterText;
            index = nextIndex;
            continue;
        }
        if (characterText === quote) {
            quote = undefined;
            index = nextIndex;
            continue;
        }
        if (quote === undefined && /\s/u.test(characterText)) {
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

        const sortedMatches = matches.toSorted((a, b) => {
            const typeOrder = { directory: 0, executable: 1, file: 2 };
            if (typeOrder[a.type] !== typeOrder[b.type]) {
                return typeOrder[a.type] - typeOrder[b.type];
            }
            return a.display.localeCompare(b.display);
        });

        let commonPrefix = "";
        const first = sortedMatches[0]?.completion;
        if (first) {
            let index = first.length;
            while (index >= searchPrefix.length) {
                const candidate = first.slice(0, index);
                if (
                    sortedMatches.every((match) => match.completion.startsWith(candidate))
                ) {
                    commonPrefix = candidate;
                    break;
                }
                index -= 1;
            }
        }

        return { commonPrefix, completions: sortedMatches.slice(0, 20) };
    } catch {
        return { commonPrefix: "", completions: [] };
    }
}

export const terminalRoutes = {
    "/api/terminal/complete": {
        POST: async (request: Request) => {
            let body: TerminalCompletionRequest;
            try {
                body = await readApiJson(request, parseTerminalCompletionRequest);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "terminal_completion_failed",
                    context: "terminal.complete",
                    message: "Terminal completion failed",
                });
            }

            const { cwd, partial } = body;
            if (partial.includes("\0")) {
                return routeFailureResponse({
                    context: "terminal",
                    message: "Missing or invalid partial",
                    status: 400,
                });
            }
            const trimmedCwd = cwd?.trim();
            if (
                cwd !== undefined &&
                (!trimmedCwd || trimmedCwd.includes("\0") || !path.isAbsolute(trimmedCwd))
            ) {
                return routeFailureResponse({
                    context: "terminal",
                    message: "Missing or invalid cwd",
                    status: 400,
                });
            }
            return json(await getCompletions(partial, trimmedCwd || HOME_DIR));
        },
    },

    "/api/terminal/cd": {
        POST: async (request: Request) => {
            let body: TerminalCdRequest;
            try {
                body = await readApiJson(request, parseTerminalCdRequest);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "terminal_cd_failed",
                    context: "terminal.cd",
                    message: "Terminal directory change failed",
                });
            }
            const resolvedCwd = body.cwd;
            const targetPath = body.path;

            if (
                !targetPath ||
                resolvedCwd.includes("\0") ||
                !body.cwd.trim() ||
                !body.cwd.startsWith("/") ||
                targetPath.includes("\0")
            ) {
                return routeFailureResponse(
                    {
                        context: "terminal.cd",
                        message: "Missing or invalid path",
                        status: 400,
                    },
                    request
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
                    return routeFailureResponse(
                        {
                            context: "terminal.cd",
                            message: `Not a directory: ${targetPath}`,
                            status: 400,
                        },
                        request
                    );
                }
                return json({ newCwd: newPath } satisfies CdResponse);
            } catch {
                return routeFailureResponse(
                    {
                        context: "terminal.cd",
                        message: `No such file or directory: ${targetPath}`,
                        status: 400,
                    },
                    request
                );
            }
        },
    },
} as const;
