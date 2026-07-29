import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
    FileContent,
    FileEntry,
    FileWriteResponse,
} from "../../../contracts/files.ts";
import { parseFileWriteRequest } from "../../../contracts/files.ts";
import { json } from "../http.ts";
import {
    guardedPath,
    lstatGuarded,
    mkdirGuarded,
    openReadNoFollowNonblockingGuarded,
    readdirGuarded,
    readFromOpenFile,
    statGuarded,
    writeTextNoFollowAnchoredGuarded,
} from "../lib/guardedOps.ts";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.ts";
import { readApiJsonOrError, routeFailureResponse } from "../routeSupport.ts";

const MAX_FILE_SIZE = 1024 * 1024;
const JSON_WRITE_BODY_LIMIT = MAX_FILE_SIZE * 3;

function defaultWorkspaceRoot(): string {
    const openclawHome = process.env.OPENCLAW_HOME?.trim();
    if (
        openclawHome &&
        path.isAbsolute(openclawHome) &&
        path.parse(openclawHome).root !== openclawHome
    ) {
        return path.join(openclawHome, "workspace");
    }
    const rawHome = process.env.HOME?.trim();
    const fallbackHome = os.homedir().trim();
    let home = "";
    if (fallbackHome && path.isAbsolute(fallbackHome)) {
        home = path.resolve(fallbackHome);
    }
    if (rawHome && path.isAbsolute(rawHome)) {
        home = path.resolve(rawHome);
    }
    if (!home || path.parse(home).root === home) {
        throw new Error("Could not resolve a safe workspace root");
    }
    return path.join(home, ".openclaw", "workspace");
}

function workspaceRoot(): string {
    const root = process.env.WORKSPACE_ROOT?.trim() || defaultWorkspaceRoot();
    if (
        !path.isAbsolute(root) ||
        path.normalize(root) !== root ||
        path.resolve(root) === path.parse(path.resolve(root)).root
    ) {
        throw new Error("WORKSPACE_ROOT must be an absolute normalized path");
    }
    return root;
}

function isHidden(name: string): boolean {
    return (
        name.startsWith(".") && name !== ".env.example" && name !== ".environment.example"
    );
}

function hasHiddenSegment(relativePath: string): boolean {
    return relativePath
        .split(/[\\/]+/u)
        .filter(Boolean)
        .some((segment) => segment !== "." && isHidden(segment));
}

function isBinaryContent(content: string): boolean {
    for (let index = 0; index < Math.min(content.length, 8000); index += 1) {
        if (content.codePointAt(index) === 0) return true;
    }
    return false;
}

function imageMime(filename: string): string | undefined {
    const extension = filename.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
        bmp: "image/bmp",
        gif: "image/gif",
        ico: "image/x-icon",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        png: "image/png",
        svg: "image/svg+xml",
        webp: "image/webp",
    };
    return extension ? (map[extension] ?? undefined) : undefined;
}

function isPathWithinRoot(candidatePath: string, root: string): boolean {
    const relativePath = path.relative(root, candidatePath);
    return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function isOpenFileWithinRoot(file: fs.promises.FileHandle, root: string): boolean {
    if (process.platform !== "linux") return true;
    try {
        return isPathWithinRoot(fs.realpathSync(`/proc/self/fd/${file.fd}`), root);
    } catch {
        return false;
    }
}

function fileOpenErrorResponse(error: unknown): Response {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ENOTDIR"].includes(code ?? "")) {
        return routeFailureResponse({
            context: "file",
            message: "File not found",
            status: 404,
        });
    }
    if (["ELOOP", "EACCES", "EPERM"].includes(code ?? "")) {
        return routeFailureResponse({
            context: "file",
            message: "Access denied",
            status: 403,
        });
    }
    throw error;
}

function listFiles(directoryPath: string): FileEntry[] | undefined {
    let root: string;
    try {
        root = fs.realpathSync(workspaceRoot());
    } catch (error) {
        if (
            !directoryPath &&
            ((error as NodeJS.ErrnoException).code === "ENOENT" ||
                (error as NodeJS.ErrnoException).code === "ENOTDIR")
        ) {
            return [];
        }
        throw error;
    }
    if (hasHiddenSegment(directoryPath)) return;
    const fullPath = safePathWithinRoot(directoryPath || ".", root);
    if (!fullPath) return;
    const resolved = safePathWithinRoot(fs.realpathSync(fullPath), root);
    if (!resolved) return;
    if (hasHiddenSegment(path.relative(root, resolved))) return;
    const items: FileEntry[] = [];
    const entries = readdirGuarded(guardedPath(resolved), { withFileTypes: true });
    for (const entry of entries) {
        if (isHidden(entry.name) || entry.isSymbolicLink()) continue;
        const itemPath = directoryPath
            ? path.join(directoryPath, entry.name)
            : entry.name;
        if (entry.isDirectory()) {
            items.push({ name: entry.name, path: itemPath, type: "directory" });
            continue;
        }
        try {
            const stat = lstatGuarded(guardedPath(path.join(resolved, entry.name)));
            items.push({
                modified: stat.mtime.toISOString(),
                name: entry.name,
                path: itemPath,
                size: stat.size,
                type: "file",
            });
        } catch {
            items.push({ error: true, name: entry.name, path: itemPath, type: "file" });
        }
    }
    return items.toSorted((a, b) => {
        if (a.type === b.type) {
            return a.name.localeCompare(b.name);
        }
        return a.type === "directory" ? -1 : 1;
    });
}

function filePathFromRequest(request: Request): string | undefined {
    const url = new URL(request.url);
    try {
        return decodeURIComponent(url.pathname.slice("/api/files/".length));
    } catch {
        return undefined;
    }
}

export const fileRoutes = {
    "/api/files": {
        GET: (request: Request) => {
            try {
                const directory = new URL(request.url).searchParams.get("path") ?? "";
                const files = listFiles(directory);
                if (!files) {
                    return routeFailureResponse({
                        context: "file",
                        message: "Access denied: path outside workspace",
                        status: 403,
                    });
                }
                return json({ files, root: workspaceRoot() });
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    return routeFailureResponse({
                        context: "file",
                        message: "Directory not found",
                        status: 404,
                    });
                }
                throw error;
            }
        },
    },

    "/api/files/*": {
        GET: async (request: Request) => {
            const relativePath = filePathFromRequest(request);
            if (relativePath === undefined) {
                return routeFailureResponse({
                    context: "file",
                    message: "Malformed file path",
                    status: 400,
                });
            }
            if (hasHiddenSegment(relativePath)) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied: hidden paths are not allowed",
                    status: 403,
                });
            }
            let root: string;
            try {
                root = fs.realpathSync(workspaceRoot());
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                root = path.resolve(workspaceRoot());
            }
            const fullPath = safePathWithinRoot(relativePath, root);
            if (!fullPath) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied: path outside workspace",
                    status: 403,
                });
            }
            if (hasHiddenSegment(path.relative(root, fullPath))) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied: hidden paths are not allowed",
                    status: 403,
                });
            }
            let stat: fs.Stats;
            try {
                stat = statGuarded(guardedPath(fullPath));
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    return routeFailureResponse({
                        context: "file",
                        message: "File not found",
                        status: 404,
                    });
                }
                throw error;
            }
            if (!stat.isFile()) {
                return routeFailureResponse({
                    context: "file",
                    message: "Path is a directory, not a file",
                    status: 400,
                });
            }
            if (stat.nlink > 1) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied: hard links are not supported",
                    status: 403,
                });
            }
            const mimeType = imageMime(path.basename(relativePath));
            if (mimeType) {
                if (stat.size > MAX_FILE_SIZE) {
                    return routeFailureResponse({
                        context: "file",
                        message: "Image file is too large to preview",
                        status: 413,
                    });
                }
                let file: fs.promises.FileHandle;
                try {
                    file = await openReadNoFollowNonblockingGuarded(
                        guardedPath(fullPath)
                    );
                } catch (error) {
                    return fileOpenErrorResponse(error);
                }
                let buffer: Buffer;
                let openedStat: fs.Stats;
                try {
                    if (!isOpenFileWithinRoot(file, root)) {
                        return routeFailureResponse({
                            context: "file",
                            message: "Access denied",
                            status: 403,
                        });
                    }
                    openedStat = await file.stat();
                    if (!openedStat.isFile() || openedStat.nlink > 1) {
                        return routeFailureResponse({
                            context: "file",
                            message: "Access denied",
                            status: 403,
                        });
                    }
                    if (openedStat.size > MAX_FILE_SIZE) {
                        return routeFailureResponse({
                            context: "file",
                            message: "Image file is too large to preview",
                            status: 413,
                        });
                    }
                    buffer = readFromOpenFile(file.fd, openedStat.size);
                } finally {
                    await file.close();
                }
                return json({
                    content: buffer.toBase64(),
                    isBinary: true,
                    isImage: true,
                    mimeType,
                    modified: openedStat.mtime.toISOString(),
                    path: relativePath,
                    size: openedStat.size,
                } satisfies FileContent);
            }
            let file: fs.promises.FileHandle;
            try {
                file = await openReadNoFollowNonblockingGuarded(guardedPath(fullPath));
            } catch (error) {
                return fileOpenErrorResponse(error);
            }
            let buffer: Buffer;
            let openedStat: fs.Stats;
            try {
                if (!isOpenFileWithinRoot(file, root)) {
                    return routeFailureResponse({
                        context: "file",
                        message: "Access denied",
                        status: 403,
                    });
                }
                openedStat = await file.stat();
                if (!openedStat.isFile() || openedStat.nlink > 1) {
                    return routeFailureResponse({
                        context: "file",
                        message: "Access denied",
                        status: 403,
                    });
                }
                buffer = readFromOpenFile(
                    file.fd,
                    Math.min(openedStat.size, MAX_FILE_SIZE)
                );
            } finally {
                await file.close();
            }
            const content = buffer.toString("utf8");
            const isBinary = isBinaryContent(content);
            return json({
                content: isBinary ? "[Binary file]" : content,
                isBinary,
                modified: openedStat.mtime.toISOString(),
                path: relativePath,
                size: openedStat.size,
                truncated: openedStat.size > MAX_FILE_SIZE || undefined,
            } satisfies FileContent);
        },

        PUT: async (request: Request) => {
            const relativePath = filePathFromRequest(request);
            if (relativePath === undefined) {
                return routeFailureResponse({
                    context: "file",
                    message: "Malformed file path",
                    status: 400,
                });
            }
            if (hasHiddenSegment(relativePath)) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied: hidden paths are not allowed",
                    status: 403,
                });
            }
            const body = await readApiJsonOrError(request, parseFileWriteRequest, {
                code: "invalid_file_request",
                context: "file.write",
                maxBytes: JSON_WRITE_BODY_LIMIT,
                message: "Invalid file request",
            });
            if (body instanceof Response) return body;
            if (Buffer.byteLength(body.content, "utf8") > MAX_FILE_SIZE) {
                return routeFailureResponse({
                    context: "file",
                    message: "File is too large to write",
                    status: 413,
                });
            }
            const workspaceRootPath = workspaceRoot();
            let root: string;
            try {
                root = fs.realpathSync(workspaceRootPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
                mkdirGuarded(guardedPath(workspaceRootPath), { recursive: true });
                root = fs.realpathSync(workspaceRootPath);
            }
            const fullPath = safePathWithinRoot(relativePath, root);
            const safeFullPath = fullPath
                ? prepareSafeWriteTargetWithinRoot(fullPath, root)
                : undefined;
            if (!safeFullPath) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied: path outside workspace",
                    status: 403,
                });
            }
            const safeRelativePath = path.relative(root, safeFullPath);
            if (hasHiddenSegment(safeRelativePath)) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied: hidden paths are not allowed",
                    status: 403,
                });
            }
            const parent = path.dirname(safeFullPath);
            if (!fs.existsSync(parent)) {
                return routeFailureResponse({
                    context: "file",
                    message: "Path not found",
                    status: 404,
                });
            }
            let existingMode: number | undefined;
            let backupContent: string | undefined;
            try {
                const existingStat = lstatGuarded(guardedPath(safeFullPath));
                if (existingStat.isDirectory()) {
                    return routeFailureResponse({
                        context: "file",
                        message: "Path is a directory, not a file",
                        status: 400,
                    });
                }
                if (!existingStat.isFile()) {
                    return routeFailureResponse({
                        context: "file",
                        message: "Path is not a regular file",
                        status: 400,
                    });
                }
                if (existingStat.nlink > 1) {
                    return routeFailureResponse({
                        context: "file",
                        message: "Access denied: hard links are not supported",
                        status: 403,
                    });
                }
                existingMode = existingStat.mode & 0o777;
                const file = await openReadNoFollowNonblockingGuarded(
                    guardedPath(safeFullPath)
                );
                try {
                    const openedStat = await file.stat();
                    if (!openedStat.isFile() || openedStat.nlink > 1) {
                        return routeFailureResponse({
                            context: "file",
                            message: "Access denied",
                            status: 403,
                        });
                    }
                    if (!isOpenFileWithinRoot(file, root)) {
                        return routeFailureResponse({
                            context: "file",
                            message: "Access denied",
                            status: 403,
                        });
                    }
                    if (openedStat.size > MAX_FILE_SIZE) {
                        return routeFailureResponse({
                            context: "file",
                            message: "Existing file is too large to back up",
                            status: 413,
                        });
                    }
                    backupContent = readFromOpenFile(file.fd, openedStat.size).toString(
                        "utf8"
                    );
                } finally {
                    await file.close();
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    return fileOpenErrorResponse(error);
                }
            }
            const anchoredPath = path.relative(root, safeFullPath);
            if (backupContent !== undefined) {
                await writeTextNoFollowAnchoredGuarded(
                    guardedPath(root),
                    `${anchoredPath}.bak`,
                    backupContent,
                    { mode: existingMode }
                );
            }
            await writeTextNoFollowAnchoredGuarded(
                guardedPath(root),
                anchoredPath,
                body.content,
                { mode: existingMode }
            );
            const stat = statGuarded(guardedPath(safeFullPath));
            return json({
                isSuccess: true,
                modified: stat.mtime.toISOString(),
                path: relativePath,
                size: stat.size,
            } satisfies FileWriteResponse);
        },
    },
} as const;
