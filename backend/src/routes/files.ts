import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/home/ubuntu/.openclaw/workspace";
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit for preview

/** Describes file item. */
interface FileItem {
    name: string;
    type: "file" | "directory";
    path: string;
    size?: number;
    modified?: string;
    error?: boolean;
}

/** Describes file response. */
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

/** Describes write response. */
interface WriteResponse {
    success: boolean;
    path: string;
    size: number;
    modified: string;
}

/** Handles is binary file. */
function isBinaryFile(content: string): boolean {
    for (let i = 0; i < Math.min(content.length, 8000); i++) {
        if (content.codePointAt(i) === 0) return true;
    }
    return false;
}

/** Handles is image file. */
function isImageFile(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase();
    const imageExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"];
    return imageExts.includes(ext || "");
}

/** Handles get image mime type. */
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

/** Handles should hide file. */
function shouldHideFile(name: string): boolean {
    return name.startsWith(".") && name !== ".env.example";
}

/** Handles list directory. */
function listDirectory(dirPath: string): FileItem[] {
    const items: FileItem[] = [];
    const fullPath = dirPath ? path.join(WORKSPACE_ROOT, dirPath) : WORKSPACE_ROOT;

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

/** Handles files routes. */
export default function filesRoutes(
    app: express.Application,
    _express: typeof express
): void {
    // List files
    app.get("/api/files", (async (req, res) => {
        try {
            const dirPath = (req.query.path as string) || "";
            const files = listDirectory(dirPath);
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
            const fullPath = path.resolve(WORKSPACE_ROOT, filePath);

            if (!fullPath.startsWith(WORKSPACE_ROOT)) {
                res.status(403).json({ error: "Access denied: path outside workspace" });
                return;
            }

            if (!fs.existsSync(fullPath)) {
                res.status(404).json({ error: "File not found" });
                return;
            }

            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                res.status(400).json({ error: "Path is a directory, not a file" });
                return;
            }

            const filename = path.basename(filePath);

            // Handle image files
            if (isImageFile(filename)) {
                const buffer = fs.readFileSync(fullPath);
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
                const fd = fs.openSync(fullPath, "r");
                const buffer = Buffer.alloc(MAX_FILE_SIZE);
                const bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
                fs.closeSync(fd);

                const content = buffer.toString("utf8", 0, bytesRead);
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

            const content = fs.readFileSync(fullPath, "utf8");
            const isBinary = isBinaryFile(content);

            res.json({
                path: filePath,
                content: isBinary ? "[Binary file]" : content,
                size: stat.size,
                modified: stat.mtime.toISOString(),
                isBinary: isBinary,
            } satisfies FileResponse);
        } catch (error) {
            console.error("[Backend] File read error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Write file
    app.put(/^\/api\/files\/(.*)$/, express.json(), (async (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");
        const { content } = req.body as { content?: string };

        if (content === undefined) {
            res.status(400).json({ error: "Content required" });
            return;
        }

        try {
            const fullPath = path.resolve(WORKSPACE_ROOT, filePath);

            if (!fullPath.startsWith(WORKSPACE_ROOT)) {
                res.status(403).json({ error: "Access denied: path outside workspace" });
                return;
            }

            if (fs.existsSync(fullPath)) {
                const backupPath = fullPath + ".bak";
                fs.copyFileSync(fullPath, backupPath);
            } else {
                const parentDir = path.dirname(fullPath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }
            }

            fs.writeFileSync(fullPath, content, "utf8");
            const stat = fs.statSync(fullPath);

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
