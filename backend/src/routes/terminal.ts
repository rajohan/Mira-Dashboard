import os from "node:os";
import path from "node:path";

import express from "express";

import { guardedPath, readdirGuardedAsync, statGuardedAsync } from "../lib/guardedOps.ts";

/** Represents completion request. */
interface CompletionRequest {
    partial: string;
    cwd?: string;
}

/** Represents CD request. */
interface CdRequest {
    path: string;
    cwd: string;
}

/** Represents the CD API response. */
interface CdResponse {
    success: boolean;
    newCwd: string;
    error?: string;
}

/** Represents completion item. */
interface CompletionItem {
    completion: string;
    type: "file" | "directory" | "executable";
    display: string;
}

/** Represents the completion API response. */
interface CompletionResponse {
    completions: CompletionItem[];
    commonPrefix: string;
}

const HOME_DIR = os.homedir();

/** Performs expand path. */
function expandPath(inputPath: string, cwd: string): string {
    if (inputPath.includes("\0")) return cwd; // Reject null bytes
    if (inputPath.startsWith("/")) return inputPath;
    if (inputPath.startsWith("~/")) return HOME_DIR + inputPath.slice(1);
    if (inputPath === "~") return HOME_DIR;
    return path.join(cwd, inputPath);
}

/** Returns completions. */
async function getCompletions(
    partial: string,
    cwd: string,
    statFile = statGuardedAsync
): Promise<CompletionResponse> {
    const trimmed = partial.trim();

    // Extract the path part being completed (after last space for commands)
    const lastSpaceIndex = trimmed.lastIndexOf(" ");
    const pathPart = lastSpaceIndex === -1 ? trimmed : trimmed.slice(lastSpaceIndex + 1);
    const prefix = lastSpaceIndex === -1 ? "" : trimmed.slice(0, lastSpaceIndex + 1);

    // Determine directory to search in
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
            if (!name.startsWith(searchPrefix) || name.startsWith(".")) {
                continue;
            }

            const fullPath = path.join(searchDirectory, name);
            let type: "file" | "directory" | "executable" = "file";

            if (entry.isDirectory()) {
                type = "directory";
            } else if (entry.isFile()) {
                try {
                    const stats = await statFile(guardedPath(fullPath));
                    if (stats.mode & 0o111) {
                        type = "executable";
                    }
                } catch {
                    // ignore
                }
            }

            const completion =
                prefix + (pathPart.includes("/") ? directoryPart + name : name);

            matches.push({
                completion,
                type,
                display: name + (type === "directory" ? "/" : ""),
            });
        }

        // Sort: directories first, then executables, then files
        matches.sort((a, b) => {
            const typeOrder = { directory: 0, executable: 1, file: 2 };
            if (typeOrder[a.type] !== typeOrder[b.type]) {
                return typeOrder[a.type] - typeOrder[b.type];
            }
            return a.display.localeCompare(b.display);
        });

        // Find common prefix
        let commonPrefix = "";
        if (matches.length > 0) {
            const first = matches[0].completion;
            let index = first.length;
            while (index > searchPrefix.length) {
                const candidate = first.slice(0, index);
                if (matches.every((m) => m.completion.startsWith(candidate))) {
                    commonPrefix = candidate;
                    break;
                }
                index--;
            }
        }

        return { completions: matches.slice(0, 20), commonPrefix };
    } catch {
        return { completions: [], commonPrefix: "" };
    }
}

/** Registers terminal API routes. */
export default function terminalRoutes(app: express.Application): void {
    app.post("/api/terminal/complete", express.json(), async (request, response) => {
        const body = request.body;
        if (!body || typeof body !== "object") {
            response.status(400).json({ error: "Missing or invalid body" });
            return;
        }

        const { partial, cwd } = body as CompletionRequest;

        if (
            typeof partial !== "string" ||
            partial.length === 0 ||
            partial.includes("\0")
        ) {
            response.status(400).json({ error: "Missing or invalid partial" });
            return;
        }
        const trimmedCwd = typeof cwd === "string" ? cwd.trim() : undefined;
        if (
            cwd !== undefined &&
            (typeof cwd !== "string" || !trimmedCwd || trimmedCwd.includes("\0"))
        ) {
            response.status(400).json({ error: "Missing or invalid cwd" });
            return;
        }
        const resolvedCwd = trimmedCwd || HOME_DIR;
        const result = await getCompletions(partial, resolvedCwd);
        response.json(result);
    });

    app.post("/api/terminal/cd", express.json(), async (request, response) => {
        const { path: targetPath, cwd } = request.body as CdRequest;
        const resolvedCwd = cwd || HOME_DIR;

        if (!targetPath || typeof targetPath !== "string" || targetPath.includes("\0")) {
            response.status(400).json({
                success: false,
                newCwd: resolvedCwd,
                error: "Missing or invalid path",
            } satisfies CdResponse);
            return;
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

        // Resolve .. and .
        const parts = newPath.split("/").filter(Boolean);
        const resolvedParts: string[] = [];
        for (const part of parts) {
            if (part === "..") {
                resolvedParts.pop();
            } else if (part !== ".") {
                resolvedParts.push(part);
            }
        }
        newPath = "/" + resolvedParts.join("/");

        // Check if directory exists
        try {
            const stats = await statGuardedAsync(guardedPath(newPath));
            if (!stats.isDirectory()) {
                response.status(400).json({
                    success: false,
                    newCwd: resolvedCwd,
                    error: `Not a directory: ${targetPath}`,
                } satisfies CdResponse);
                return;
            }
            response.json({ success: true, newCwd: newPath } satisfies CdResponse);
        } catch {
            response.status(400).json({
                success: false,
                newCwd: resolvedCwd,
                error: `No such file or directory: ${targetPath}`,
            } satisfies CdResponse);
        }
    });
}
