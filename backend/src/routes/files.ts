import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";

import {
    copyGuarded,
    guardedPath,
    mkdirGuarded,
    openReadNoFollowGuarded,
    statGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.js";
import { safePathWithinRoot } from "../lib/safePath.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/home/ubuntu/.openclaw/workspace";
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
    return imageExts.includes(ext || "");
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
    return mimeTypes[ext || ""] || "application/octet-stream";
}

/** Performs should hIDe file. */
function shouldHideFile(name: string): boolean {
    return name.startsWith(".") && name !== ".env.example";
}

/** Lists a workspace directory or returns null when the path escapes the workspace. */
function listDirectory(dirPath: string): FileItem[] | null {
    const items: FileItem[] = [];
    const fullPath = safePathWithinRoot(dirPath || ".", WORKSPACE_ROOT);

    if (!fullPath) {
        return null;
    }

    try {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
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
                    const stat = fs.statSync(path.join(fullPath, entry.name));
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

    return items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

/** Registers files API routes. */
export default function filesRoutes(
    app: express.Application,
    _express: typeof express
): void {
    // List files
    app.get("/api/files", (async (req, res) => {
        try {
            const dirPath = (req.query.path as string) || "";
            const files = listDirectory(dirPath);
            if (!files) {
                res.status(403).json({ error: "Access denied: path outside workspace" });
                return;
            }
            res.json({ files, root: WORKSPACE_ROOT });
        } catch (error) {
            console.error("[Backend] Files list error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Read file content
    app.get(/^\/api\/files\/(.*)$/, (async (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");

        try {
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
                res.status(403).json({ error: "Access denied: path outside workspace" });
                return;
            }

            let fullPath: string;
            try {
                fullPath = fs.realpathSync(candidatePath);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    res.status(404).json({ error: "File not found" });
                    return;
                }
                throw error;
            }

            if (
                fullPath !== workspaceRoot &&
                !fullPath.startsWith(workspaceRoot + path.sep)
            ) {
                res.status(403).json({ error: "Access denied: path outside workspace" });
                return;
            }

            // Open file first to avoid TOCTOU race between stat and read.
            // O_NOFOLLOW rejects a final-component symlink if the path is swapped
            // after canonicalization but before open.
            let file: fs.promises.FileHandle | undefined;
            try {
                file = await openReadNoFollowGuarded(guardedPath(fullPath));
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT") {
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

            try {
                const stat = await file.stat();

                if (stat.isDirectory()) {
                    res.status(400).json({ error: "Path is a directory, not a file" });
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
                    const { bytesRead } = await file.read(buffer, 0, MAX_FILE_SIZE, 0);
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
        } catch (error) {
            console.error("[Backend] File read error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Write file
    app.put(/^\/api\/files\/(.*)$/, express.json(), (async (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");
        const { content } = req.body as { content?: string };

        if (typeof content !== "string") {
            res.status(400).json({ error: "Content required" });
            return;
        }

        try {
            const fullPath = safePathWithinRoot(filePath, WORKSPACE_ROOT);

            if (!fullPath) {
                res.status(403).json({ error: "Access denied: path outside workspace" });
                return;
            }

            try {
                const backupPath = fullPath + ".bak";
                copyGuarded(guardedPath(fullPath), guardedPath(backupPath));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }

                mkdirGuarded(guardedPath(path.dirname(fullPath)), { recursive: true });
            }

            await writeTextNoFollowGuarded(guardedPath(fullPath), content);
            const stat = statGuarded(guardedPath(fullPath));

            res.json({
                success: true,
                path: filePath,
                size: stat.size,
                modified: stat.mtime.toISOString(),
            } satisfies WriteResponse);
        } catch (error) {
            console.error("[Backend] File write error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
