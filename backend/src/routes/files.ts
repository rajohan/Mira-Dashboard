import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

import { asyncRoute } from "../lib/errors.js";
import {
    copyGuarded,
    guardedPath,
    openReadNoFollowGuarded,
    readdirGuarded,
    statGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.js";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.js";
import { nonEmptyEnvFallback, stringFallback } from "../lib/values.js";

function getDefaultWorkspaceRoot(): string {
    const openclawHome = process.env.OPENCLAW_HOME;
    return openclawHome
        ? path.join(openclawHome, "workspace")
        : path.join(os.homedir(), ".openclaw", "workspace");
}

const WORKSPACE_ROOT = nonEmptyEnvFallback("WORKSPACE_ROOT", getDefaultWorkspaceRoot());
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit for preview

/** Represents file item. */
interface FileItem {
    name: string;
    type: "file" | "directory";
    path: string;
    size?: number;
    modified?: string;
    error?: boolean;
}

/** Represents the file API response. */
interface FileResponse {
    path: string;
    content: string;
    size: number;
    modified: string;
    isBinary: boolean;
    isImage?: boolean;
    mimeType?: string;
    truncated?: boolean;
}

/** Represents the write API response. */
interface WriteResponse {
    success: boolean;
    path: string;
    size: number;
    modified: string;
}

function decodeRouteFilePath(value: unknown): string {
    return stringFallback(value);
}

/** Returns whether binary file. */
function isBinaryFile(content: string): boolean {
    for (let i = 0; i < Math.min(content.length, 8000); i++) {
        if (content.codePointAt(i) === 0) return true;
    }
    return false;
}

/** Returns whether image file. */
function isImageFile(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase();
    const imageExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"];
    return imageExts.includes(stringFallback(ext));
}

/** Returns image mime type. */
function getImageMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        svg: "image/svg+xml",
        webp: "image/webp",
        ico: "image/x-icon",
        bmp: "image/bmp",
    };
    return mimeTypes[stringFallback(ext)] || "application/octet-stream";
}

/** Performs should hIDe file. */
function shouldHideFile(name: string): boolean {
    return name.startsWith(".") && name !== ".env.example";
}

function compareNames(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/** Lists a workspace directory or returns null when the path escapes the workspace. */
function listDirectory(dirPath: string): FileItem[] | null {
    const items: FileItem[] = [];
    const fullPath = safePathWithinRoot(dirPath || ".", WORKSPACE_ROOT);

    if (!fullPath) {
        return null;
    }

    try {
        const entries = readdirGuarded(guardedPath(fullPath), { withFileTypes: true });
        for (const entry of entries) {
            if (shouldHideFile(entry.name)) continue;
            const itemPath = dirPath ? path.join(dirPath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                items.push({
                    name: entry.name,
                    type: "directory",
                    path: itemPath,
                });
            } else {
                // Use stat from readdirSync entry info; avoid separate existsSync/statSync TOCTOU
                try {
                    const stat = statGuarded(
                        guardedPath(path.join(fullPath, entry.name))
                    );
                    items.push({
                        name: entry.name,
                        type: "file",
                        path: itemPath,
                        size: stat.size,
                        modified: stat.mtime.toISOString(),
                    });
                } catch {
                    items.push({
                        name: entry.name,
                        type: "file",
                        path: itemPath,
                        error: true,
                    });
                }
            }
        }
    } catch (error) {
        console.error("[Files] Error listing directory:", (error as Error).message);
    }

    const typeOrder: Record<FileItem["type"], number> = { directory: 0, file: 1 };
    return items.sort(
        (a, b) => typeOrder[a.type] - typeOrder[b.type] || compareNames(a.name, b.name)
    );
}

export const __testing = {
    compareNames,
    decodeRouteFilePath,
    getDefaultWorkspaceRoot,
    getImageMimeType,
    isBinaryFile,
    isImageFile,
    listDirectory,
    shouldHideFile,
};

/** Registers files API routes. */
export default function filesRoutes(
    app: express.Application,
    _express: typeof express
): void {
    // List files
    app.get(
        "/api/files",
        asyncRoute(
            async (req, res) => {
                const dirPath = stringFallback(req.query.path);
                const files = listDirectory(dirPath);
                if (!files) {
                    res.status(403).json({
                        error: "Access denied: path outside workspace",
                    });
                    return;
                }
                res.json({ files, root: WORKSPACE_ROOT });
            },
            { fallback: "Files list failed", logLabel: "[Backend] Files list error:" }
        )
    );

    // Read file content
    app.get(
        /^\/api\/files\/(.*)$/,
        asyncRoute(
            async (req, res) => {
                const filePath = decodeRouteFilePath(req.params[0]);

                let workspaceRoot: string;
                try {
                    workspaceRoot = fs.realpathSync(WORKSPACE_ROOT);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                        res.status(404).json({ error: "File not found" });
                        return;
                    }
                    throw error;
                }

                const candidatePath = path.resolve(workspaceRoot, filePath);

                if (
                    candidatePath !== workspaceRoot &&
                    !candidatePath.startsWith(workspaceRoot + path.sep)
                ) {
                    res.status(403).json({
                        error: "Access denied: path outside workspace",
                    });
                    return;
                }

                let file: fs.promises.FileHandle | undefined;
                let fullPath: string;
                try {
                    file = await openReadNoFollowGuarded(guardedPath(candidatePath));
                    if (process.platform === "linux") {
                        fullPath = fs.realpathSync(`/proc/self/fd/${file.fd}`);
                    } else {
                        const openedStat = await file.stat();
                        const targetStat = fs.statSync(candidatePath);
                        if (
                            openedStat.dev !== targetStat.dev ||
                            openedStat.ino !== targetStat.ino
                        ) {
                            res.status(403).json({
                                error: "Access denied: path outside workspace",
                            });
                            await file.close();
                            return;
                        }
                        fullPath = candidatePath;
                    }
                } catch (error) {
                    if (file) {
                        await file.close();
                    }
                    const code = (error as NodeJS.ErrnoException).code;
                    if (
                        code === "ENOENT" ||
                        code === "ENOTDIR" ||
                        code === "ERR_INVALID_ARG_VALUE"
                    ) {
                        res.status(404).json({ error: "File not found" });
                        return;
                    }
                    if (code === "ELOOP") {
                        res.status(403).json({
                            error: "Access denied: symlinks are not readable",
                        });
                        return;
                    }
                    throw error;
                }

                if (
                    fullPath !== workspaceRoot &&
                    !fullPath.startsWith(workspaceRoot + path.sep)
                ) {
                    res.status(403).json({
                        error: "Access denied: path outside workspace",
                    });
                    if (file) await file.close();
                    return;
                }

                try {
                    const stat = await file.stat();

                    if (stat.isDirectory()) {
                        res.status(400).json({
                            error: "Path is a directory, not a file",
                        });
                        return;
                    }

                    const filename = path.basename(filePath);

                    // Handle image files
                    if (isImageFile(filename)) {
                        if (stat.size > MAX_FILE_SIZE) {
                            res.status(413).json({
                                error: "Image file is too large to preview",
                            });
                            return;
                        }

                        const buffer = await file.readFile();
                        const base64 = buffer.toString("base64");
                        const mimeType = getImageMimeType(filename);

                        res.json({
                            path: filePath,
                            content: base64,
                            mimeType: mimeType,
                            size: stat.size,
                            modified: stat.mtime.toISOString(),
                            isImage: true,
                            isBinary: true,
                        } satisfies FileResponse);
                        return;
                    }

                    if (stat.size > MAX_FILE_SIZE) {
                        const buffer = Buffer.alloc(MAX_FILE_SIZE);
                        const { bytesRead } = await file.read(
                            buffer,
                            0,
                            MAX_FILE_SIZE,
                            0
                        );
                        const content = buffer.subarray(0, bytesRead).toString("utf8");
                        const isBinary = isBinaryFile(content);

                        res.json({
                            path: filePath,
                            content: isBinary ? "[Binary file]" : content,
                            size: stat.size,
                            modified: stat.mtime.toISOString(),
                            isBinary: isBinary,
                            truncated: true,
                        } satisfies FileResponse);
                        return;
                    }

                    const fullBuffer = await file.readFile();
                    const content = fullBuffer.toString("utf8");
                    const isBinary = isBinaryFile(content);

                    res.json({
                        path: filePath,
                        content: isBinary ? "[Binary file]" : content,
                        size: stat.size,
                        modified: stat.mtime.toISOString(),
                        isBinary: isBinary,
                    } satisfies FileResponse);
                } finally {
                    if (file) await file.close();
                }
            },
            { fallback: "File read failed", logLabel: "[Backend] File read error:" }
        )
    );

    // Write file
    app.put(
        /^\/api\/files\/(.*)$/,
        express.json(),
        asyncRoute(
            async (req, res) => {
                const filePath = decodeRouteFilePath(req.params[0]);
                const { content } = req.body as { content?: string };

                if (typeof content !== "string") {
                    res.status(400).json({ error: "Content required" });
                    return;
                }

                const fullPath = safePathWithinRoot(filePath, WORKSPACE_ROOT);

                if (!fullPath) {
                    res.status(403).json({
                        error: "Access denied: path outside workspace",
                    });
                    return;
                }

                const safeFullPath = prepareSafeWriteTargetWithinRoot(
                    fullPath,
                    WORKSPACE_ROOT
                );
                if (!safeFullPath) {
                    res.status(403).json({
                        error: "Access denied: path outside workspace",
                    });
                    return;
                }

                try {
                    const backupPath = safeFullPath + ".bak";
                    copyGuarded(guardedPath(safeFullPath), guardedPath(backupPath));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw error;
                    }
                }

                await writeTextNoFollowGuarded(guardedPath(safeFullPath), content);
                const stat = statGuarded(guardedPath(safeFullPath));

                res.json({
                    success: true,
                    path: filePath,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                } satisfies WriteResponse);
            },
            { fallback: "File write failed", logLabel: "[Backend] File write error:" }
        )
    );

    app.use(
        "/api/files",
        (
            error: unknown,
            _req: express.Request,
            res: express.Response,
            next: express.NextFunction
        ) => {
            if (error instanceof URIError) {
                res.status(400).json({ error: "Malformed URL encoding" });
                return;
            }
            next(error);
        }
    );
}
