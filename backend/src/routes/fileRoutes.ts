import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    guardedPath,
    lstatGuarded,
    mkdirGuarded,
    openReadNoFollowGuarded,
    readdirGuarded,
    readFromOpenFile,
    statGuarded,
    writeTextNoFollowAnchoredGuarded,
} from "../lib/guardedOps.ts";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.ts";

const MAX_FILE_SIZE = 1024 * 1024;
const JSON_WRITE_BODY_LIMIT = MAX_FILE_SIZE * 3;

interface FileItem {
    name: string;
    path: string;
    type: "directory" | "file";
    error?: boolean;
    modified?: string;
    size?: number;
}

function defaultWorkspaceRoot(): string {
    const openclawHome =
        process.env.OPENCLAW_HOME?.trim() ||
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME?.trim();
    if (
        openclawHome &&
        path.isAbsolute(openclawHome) &&
        path.parse(openclawHome).root !== openclawHome
    ) {
        return path.join(openclawHome, "workspace");
    }
    const rawHome = process.env.HOME?.trim();
    const fallbackHome = os.homedir().trim();
    const home =
        rawHome && path.isAbsolute(rawHome)
            ? path.resolve(rawHome)
            : fallbackHome && path.isAbsolute(fallbackHome)
              ? path.resolve(fallbackHome)
              : "";
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
    return relativePath.split(/[\\/]+/u).some((segment) => isHidden(segment));
}

function isBinaryContent(content: string): boolean {
    for (let index = 0; index < Math.min(content.length, 8000); index += 1) {
        if (content.codePointAt(index) === 0) return true;
    }
    return false;
}

function imageMime(filename: string): string | null {
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
    return extension ? (map[extension] ?? null) : null;
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

function listFiles(directoryPath: string) {
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
    if (hasHiddenSegment(directoryPath)) return null;
    const fullPath = safePathWithinRoot(directoryPath || ".", root);
    if (!fullPath) return null;
    const resolved = safePathWithinRoot(fs.realpathSync(fullPath), root);
    if (!resolved) return null;
    if (hasHiddenSegment(path.relative(root, resolved))) return null;
    const items: FileItem[] = [];
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
    return items.sort(
        (a, b) =>
            (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) ||
            a.name.localeCompare(b.name)
    );
}

function filePathFromRequest(request: Request): string | null {
    const url = new URL(request.url);
    try {
        return decodeURIComponent(url.pathname.slice("/api/files/".length));
    } catch {
        return null;
    }
}

export const fileRoutes = {
    "/api/files": {
        GET: (request: Request) => {
            try {
                const directory = new URL(request.url).searchParams.get("path") ?? "";
                const files = listFiles(directory);
                if (!files) {
                    return json(
                        { error: "Access denied: path outside workspace" },
                        { status: 403 }
                    );
                }
                return json({ files, root: workspaceRoot() });
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    return json({ error: "Directory not found" }, { status: 404 });
                }
                throw error;
            }
        },
    },

    "/api/files/*": {
        GET: async (request: Request) => {
            const relativePath = filePathFromRequest(request);
            if (relativePath === null) {
                return json({ error: "Malformed file path" }, { status: 400 });
            }
            if (hasHiddenSegment(relativePath)) {
                return json(
                    { error: "Access denied: hidden paths are not allowed" },
                    { status: 403 }
                );
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
                return json(
                    { error: "Access denied: path outside workspace" },
                    { status: 403 }
                );
            }
            if (hasHiddenSegment(path.relative(root, fullPath))) {
                return json(
                    { error: "Access denied: hidden paths are not allowed" },
                    { status: 403 }
                );
            }
            let stat: fs.Stats;
            try {
                stat = statGuarded(guardedPath(fullPath));
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    return json({ error: "File not found" }, { status: 404 });
                }
                throw error;
            }
            if (!stat.isFile()) {
                return json(
                    { error: "Path is a directory, not a file" },
                    { status: 400 }
                );
            }
            if (stat.nlink > 1) {
                return json(
                    { error: "Access denied: hard links are not supported" },
                    { status: 403 }
                );
            }
            const mimeType = imageMime(path.basename(relativePath));
            if (mimeType) {
                if (stat.size > MAX_FILE_SIZE) {
                    return json(
                        { error: "Image file is too large to preview" },
                        { status: 413 }
                    );
                }
                const file = await openReadNoFollowGuarded(guardedPath(fullPath));
                let buffer: Buffer;
                let openedStat: fs.Stats;
                try {
                    if (!isOpenFileWithinRoot(file, root)) {
                        return json({ error: "Access denied" }, { status: 403 });
                    }
                    openedStat = await file.stat();
                    if (!openedStat.isFile() || openedStat.nlink > 1) {
                        return json({ error: "Access denied" }, { status: 403 });
                    }
                    if (openedStat.size > MAX_FILE_SIZE) {
                        return json(
                            { error: "Image file is too large to preview" },
                            { status: 413 }
                        );
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
                });
            }
            const file = await openReadNoFollowGuarded(guardedPath(fullPath));
            let buffer: Buffer;
            let openedStat: fs.Stats;
            try {
                if (!isOpenFileWithinRoot(file, root)) {
                    return json({ error: "Access denied" }, { status: 403 });
                }
                openedStat = await file.stat();
                if (!openedStat.isFile() || openedStat.nlink > 1) {
                    return json({ error: "Access denied" }, { status: 403 });
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
            });
        },

        PUT: async (request: Request) => {
            const relativePath = filePathFromRequest(request);
            if (relativePath === null) {
                return json({ error: "Malformed file path" }, { status: 400 });
            }
            if (hasHiddenSegment(relativePath)) {
                return json(
                    { error: "Access denied: hidden paths are not allowed" },
                    { status: 403 }
                );
            }
            let body: { content?: unknown };
            try {
                body = await readJson<{ content?: unknown }>(request, {
                    maxBytes: JSON_WRITE_BODY_LIMIT,
                });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Invalid JSON") },
                    { status: httpStatusCode(error) }
                );
            }
            if (!body || typeof body !== "object" || Array.isArray(body)) {
                return json({ error: "Request body must be an object" }, { status: 400 });
            }
            if (typeof body.content !== "string") {
                return json({ error: "Content required" }, { status: 400 });
            }
            if (Buffer.byteLength(body.content, "utf8") > MAX_FILE_SIZE) {
                return json({ error: "File is too large to write" }, { status: 413 });
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
                : null;
            if (!safeFullPath) {
                return json(
                    { error: "Access denied: path outside workspace" },
                    { status: 403 }
                );
            }
            const safeRelativePath = path.relative(root, safeFullPath);
            if (hasHiddenSegment(safeRelativePath)) {
                return json(
                    { error: "Access denied: hidden paths are not allowed" },
                    { status: 403 }
                );
            }
            const parent = path.dirname(safeFullPath);
            if (!fs.existsSync(parent)) {
                return json({ error: "Path not found" }, { status: 404 });
            }
            let existingMode: number | undefined;
            let backupContent: string | undefined;
            try {
                const existingStat = lstatGuarded(guardedPath(safeFullPath));
                if (existingStat.isDirectory()) {
                    return json(
                        { error: "Path is a directory, not a file" },
                        { status: 400 }
                    );
                }
                if (!existingStat.isFile()) {
                    return json({ error: "Path is not a regular file" }, { status: 400 });
                }
                if (existingStat.nlink > 1) {
                    return json(
                        { error: "Access denied: hard links are not supported" },
                        { status: 403 }
                    );
                }
                existingMode = existingStat.mode & 0o777;
                const file = await openReadNoFollowGuarded(guardedPath(safeFullPath));
                try {
                    const openedStat = await file.stat();
                    if (!openedStat.isFile() || openedStat.nlink > 1) {
                        return json({ error: "Access denied" }, { status: 403 });
                    }
                    if (!isOpenFileWithinRoot(file, root)) {
                        return json({ error: "Access denied" }, { status: 403 });
                    }
                    if (openedStat.size > MAX_FILE_SIZE) {
                        return json(
                            { error: "Existing file is too large to back up" },
                            { status: 413 }
                        );
                    }
                    backupContent = readFromOpenFile(file.fd, openedStat.size).toString(
                        "utf8"
                    );
                } finally {
                    await file.close();
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
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
            });
        },
    },
} as const;
