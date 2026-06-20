import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { json, readJson } from "../http.ts";
import {
    guardedPath,
    lstatGuarded,
    readdirGuarded,
    statGuarded,
    writeTextNoFollowExclusiveGuarded,
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

function listFiles(directoryPath: string) {
    const root = fs.realpathSync(workspaceRoot());
    const fullPath = safePathWithinRoot(directoryPath || ".", root);
    if (!fullPath) return null;
    const resolved = safePathWithinRoot(fs.realpathSync(fullPath), root);
    if (!resolved) return null;
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

function filePathFromRequest(request: Request): string {
    const url = new URL(request.url);
    return decodeURIComponent(url.pathname.slice("/api/files/".length));
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
            const root = fs.realpathSync(workspaceRoot());
            const fullPath = safePathWithinRoot(relativePath, root);
            if (!fullPath) {
                return json(
                    { error: "Access denied: path outside workspace" },
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
            if (stat.isDirectory()) {
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
                const buffer = Buffer.from(await Bun.file(fullPath).arrayBuffer());
                return json({
                    content: buffer.toBase64(),
                    isBinary: true,
                    isImage: true,
                    mimeType,
                    modified: stat.mtime.toISOString(),
                    path: relativePath,
                    size: stat.size,
                });
            }
            const buffer =
                stat.size > MAX_FILE_SIZE
                    ? Buffer.from(
                          await Bun.file(fullPath).slice(0, MAX_FILE_SIZE).arrayBuffer()
                      )
                    : Buffer.from(await Bun.file(fullPath).arrayBuffer());
            const content = buffer.toString("utf8");
            const isBinary = isBinaryContent(content);
            return json({
                content: isBinary ? "[Binary file]" : content,
                isBinary,
                modified: stat.mtime.toISOString(),
                path: relativePath,
                size: stat.size,
                truncated: stat.size > MAX_FILE_SIZE || undefined,
            });
        },

        PUT: async (request: Request) => {
            const relativePath = filePathFromRequest(request);
            const body = await readJson<{ content?: unknown }>(request);
            if (typeof body.content !== "string") {
                return json({ error: "Content required" }, { status: 400 });
            }
            if (Buffer.byteLength(body.content, "utf8") > JSON_WRITE_BODY_LIMIT) {
                return json({ error: "File is too large to write" }, { status: 413 });
            }
            const root = fs.realpathSync(workspaceRoot());
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
            const parent = path.dirname(safeFullPath);
            if (!fs.existsSync(parent)) {
                return json({ error: "Path not found" }, { status: 404 });
            }
            const temporaryPath = `${safeFullPath}.${process.pid}.${Date.now()}.${Bun.randomUUIDv7()}.tmp`;
            await writeTextNoFollowExclusiveGuarded(
                guardedPath(temporaryPath),
                body.content
            );
            await fs.promises.rename(temporaryPath, safeFullPath);
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
