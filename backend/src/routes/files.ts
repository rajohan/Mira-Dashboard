import { randomUUID } from "node:crypto";

import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

import { asyncRoute } from "../lib/errors.js";
import {
    copyNoFollowGuarded,
    guardedPath,
    lstatGuarded,
    openReadNoFollowGuarded,
    readdirGuarded,
    statGuarded,
    writeTextNoFollowExclusiveGuarded,
} from "../lib/guardedOps.js";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.js";
import { stringFallback } from "../lib/values.js";

function getDefaultWorkspaceRoot(): string {
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

    const homeDir = os.homedir().trim();
    if (!homeDir || !path.isAbsolute(homeDir) || path.parse(homeDir).root === homeDir) {
        throw new Error("Could not resolve a safe workspace root");
    }

    return path.join(homeDir, ".openclaw", "workspace");
}

function resolveWorkspaceRoot(): string {
    const workspaceRoot = process.env.WORKSPACE_ROOT?.trim() || getDefaultWorkspaceRoot();
    if (
        !path.isAbsolute(workspaceRoot) ||
        path.normalize(workspaceRoot) !== workspaceRoot ||
        path.resolve(workspaceRoot) === path.parse(path.resolve(workspaceRoot)).root
    ) {
        throw new Error("WORKSPACE_ROOT must be an absolute normalized path");
    }
    return workspaceRoot;
}

const WORKSPACE_ROOT = resolveWorkspaceRoot();
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit for preview
const MAX_BACKUP_COPY_BYTES = 2 * 1024 * 1024;
const JSON_PARSER_SIZE_HEADROOM = MAX_FILE_SIZE * 2;
const JSON_WRITE_BODY_LIMIT = MAX_FILE_SIZE + JSON_PARSER_SIZE_HEADROOM;
const HARD_LINK_ERROR = "Access denied: hard links are not supported";
const FILE_OPEN_NOT_FOUND_ERROR_CODES = new Set([
    "ENOENT",
    "ENOTDIR",
    "ERR_INVALID_ARG_VALUE",
]);
let listDirectoryRealpathSync = fs.realpathSync;
let procSelfFdPath = "/proc/self/fd";

function isFileOpenNotFoundErrorCode(code: string | undefined): boolean {
    return code !== undefined && FILE_OPEN_NOT_FOUND_ERROR_CODES.has(code);
}

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

/** Returns image MIME type. */
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

    try {
        const workspaceRoot = listDirectoryRealpathSync(WORKSPACE_ROOT);
        const fullPath = safePathWithinRoot(dirPath || ".", workspaceRoot);

        if (!fullPath) {
            return null;
        }
        const resolvedFullPath = safePathWithinRoot(
            listDirectoryRealpathSync(fullPath),
            workspaceRoot
        );
        if (!resolvedFullPath) {
            return null;
        }

        const entries = readdirGuarded(guardedPath(resolvedFullPath), {
            withFileTypes: true,
        });
        for (const entry of entries) {
            if (shouldHideFile(entry.name)) continue;
            if (entry.isSymbolicLink()) continue;
            const itemPath = dirPath ? path.join(dirPath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                items.push({
                    name: entry.name,
                    type: "directory",
                    path: itemPath,
                });
            } else {
                try {
                    const stat = lstatGuarded(
                        guardedPath(path.join(resolvedFullPath, entry.name))
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
        if (
            !dirPath &&
            (error as NodeJS.ErrnoException).code === "ENOENT" &&
            path.resolve(WORKSPACE_ROOT) === WORKSPACE_ROOT
        ) {
            return [];
        }
        console.error("[Files] Error listing directory:", (error as Error).message);
        throw error;
    }

    const typeOrder: Record<FileItem["type"], number> = { directory: 0, file: 1 };
    return items.sort(
        (a, b) => typeOrder[a.type] - typeOrder[b.type] || compareNames(a.name, b.name)
    );
}

async function withRootedParentPath<T>(
    safePath: string,
    rootPath: string,
    callback: (rootedPath: string) => Promise<T> | T
): Promise<T> {
    const parentPath = path.dirname(safePath);
    const parentFd = fs.openSync(
        parentPath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
        const realRoot = fs.realpathSync(rootPath);
        const procSelfFd = procSelfFdPath;
        let rootedPath = safePath;
        let realParent: string;
        if (
            process.platform === "linux" &&
            fs.existsSync(procSelfFd) &&
            fs.statSync(procSelfFd).isDirectory()
        ) {
            realParent = fs.realpathSync(path.join(procSelfFd, String(parentFd)));
            rootedPath = path.join(procSelfFd, String(parentFd), path.basename(safePath));
        } else {
            realParent = fs.realpathSync(parentPath);
            const openedParentStat = fs.fstatSync(parentFd);
            const realParentStat = fs.statSync(realParent);
            if (
                openedParentStat.dev !== realParentStat.dev ||
                openedParentStat.ino !== realParentStat.ino
            ) {
                const error = new Error(
                    "Parent path validation failed"
                ) as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
        }
        if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
            const error = new Error(
                "Parent path validation failed"
            ) as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
        }

        return await callback(rootedPath);
    } finally {
        fs.closeSync(parentFd);
    }
}

async function ensureSafeParentDirectoryForWrite(
    preparedSafePath: string,
    rootPath: string
): Promise<void> {
    const canonicalRoot = fs.realpathSync(rootPath);
    await withRootedParentPath(preparedSafePath, canonicalRoot, () => {});
}

async function realpathForOpenedFile(
    file: fs.promises.FileHandle,
    candidatePath: string
): Promise<string> {
    const procSelfFd = procSelfFdPath;
    if (
        process.platform === "linux" &&
        fs.existsSync(procSelfFd) &&
        fs.statSync(procSelfFd).isDirectory()
    ) {
        return fs.realpathSync(path.join(procSelfFd, String(file.fd)));
    }

    const openedStat = await file.stat();
    const resolvedCandidatePath = await fs.promises.realpath(candidatePath);
    const targetStat = fs.statSync(resolvedCandidatePath);
    if (openedStat.dev !== targetStat.dev || openedStat.ino !== targetStat.ino) {
        const error = new Error("File path validation failed") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
    }
    return resolvedCandidatePath;
}

function sendRootedParentError(
    res: express.Response,
    error: NodeJS.ErrnoException
): boolean {
    if (error.code !== "EACCES") {
        return false;
    }
    if (error.message !== "Parent path validation failed") {
        return false;
    }
    res.status(403).json({ error: "Access denied: path outside workspace" });
    return true;
}

export const __testing = {
    compareNames,
    decodeRouteFilePath,
    getDefaultWorkspaceRoot,
    getImageMimeType,
    isBinaryFile,
    isImageFile,
    listDirectory,
    resolveWorkspaceRoot,
    sendRootedParentError,
    setListDirectoryRealpathSyncForTest(nextRealpathSync?: typeof fs.realpathSync): void {
        listDirectoryRealpathSync = nextRealpathSync ?? fs.realpathSync;
    },
    setProcSelfFdPathForTest(nextPath?: string): void {
        procSelfFdPath = nextPath ?? "/proc/self/fd";
    },
    shouldHideFile,
    withRootedParentPath,
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
                let files: FileItem[] | null;
                try {
                    files = listDirectory(dirPath);
                } catch (error) {
                    if (
                        (error as NodeJS.ErrnoException).code === "ENOENT" ||
                        (error as NodeJS.ErrnoException).code === "ENOTDIR"
                    ) {
                        res.status(404).json({ error: "Directory not found" });
                        return;
                    }
                    throw error;
                }
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
                    fullPath = await realpathForOpenedFile(file, candidatePath);
                } catch (error) {
                    if (file) {
                        await file.close();
                    }
                    const code = (error as NodeJS.ErrnoException).code;
                    if (isFileOpenNotFoundErrorCode(code)) {
                        res.status(404).json({ error: "File not found" });
                        return;
                    }
                    if (code === "ELOOP") {
                        res.status(403).json({
                            error: "Access denied: symlinks are not readable",
                        });
                        return;
                    }
                    if (
                        code === "EACCES" &&
                        (error as Error).message === "File path validation failed"
                    ) {
                        res.status(403).json({
                            error: "Access denied: path outside workspace",
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

                    if (stat.nlink > 1) {
                        res.status(403).json({ error: HARD_LINK_ERROR });
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
                        const base64 = buffer.toBase64();
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
        express.json({ limit: JSON_WRITE_BODY_LIMIT }),
        asyncRoute(
            async (req, res) => {
                const filePath = decodeRouteFilePath(req.params[0]);
                const content =
                    req.body && typeof req.body === "object"
                        ? (req.body as { content?: unknown }).content
                        : undefined;

                if (typeof content !== "string") {
                    res.status(400).json({ error: "Content required" });
                    return;
                }
                if (Buffer.byteLength(content, "utf8") > MAX_FILE_SIZE) {
                    res.status(413).json({ error: "File is too large to write" });
                    return;
                }

                let workspaceRoot: string;
                try {
                    workspaceRoot = fs.realpathSync(WORKSPACE_ROOT);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "ENOENT") {
                        workspaceRoot = path.resolve(WORKSPACE_ROOT);
                    } else {
                        if (sendRootedParentError(res, error as NodeJS.ErrnoException)) {
                            return;
                        }
                        throw error;
                    }
                }

                const fullPath = safePathWithinRoot(filePath, workspaceRoot);

                if (!fullPath) {
                    res.status(403).json({
                        error: "Access denied: path outside workspace",
                    });
                    return;
                }

                const safeFullPath = prepareSafeWriteTargetWithinRoot(
                    fullPath,
                    workspaceRoot
                );
                if (!safeFullPath) {
                    res.status(403).json({
                        error: "Access denied: path outside workspace",
                    });
                    return;
                }

                const backupPath = safeFullPath + ".bak";
                const safeBackupPath = prepareSafeWriteTargetWithinRoot(
                    backupPath,
                    workspaceRoot
                );
                if (!safeBackupPath) {
                    res.status(403).json({
                        error: "Access denied: path outside workspace",
                    });
                    return;
                }
                try {
                    await ensureSafeParentDirectoryForWrite(safeFullPath, workspaceRoot);
                } catch (error) {
                    if (sendRootedParentError(res, error as NodeJS.ErrnoException)) {
                        return;
                    }
                    throw error;
                }

                let stat: fs.Stats | null;
                try {
                    stat = await withRootedParentPath(
                        safeFullPath,
                        workspaceRoot,
                        async (rootedFullPath) => {
                            let existingMode: number | null = null;
                            let shouldCopyBackup = false;
                            try {
                                const existingStat = statGuarded(
                                    guardedPath(rootedFullPath)
                                );
                                if (existingStat.isDirectory()) {
                                    throw Object.assign(
                                        new Error("Path is a directory, not a file"),
                                        { code: "EISDIR" }
                                    );
                                }
                                if (existingStat.nlink > 1) {
                                    return null;
                                }
                                existingMode = existingStat.mode & 0o777;
                                if (existingStat.size > MAX_BACKUP_COPY_BYTES) {
                                    try {
                                        await fs.promises.unlink(
                                            path.join(
                                                path.dirname(rootedFullPath),
                                                path.basename(safeBackupPath)
                                            )
                                        );
                                    } catch (error) {
                                        if (
                                            (error as NodeJS.ErrnoException).code !==
                                            "ENOENT"
                                        ) {
                                            throw error;
                                        }
                                    }
                                    shouldCopyBackup = false;
                                } else {
                                    shouldCopyBackup = true;
                                }
                            } catch (error) {
                                const code = (error as NodeJS.ErrnoException).code;
                                if (code !== "ENOENT") {
                                    throw error;
                                }
                            }

                            if (shouldCopyBackup) {
                                try {
                                    await withRootedParentPath(
                                        safeBackupPath,
                                        workspaceRoot,
                                        (rootedBackupPath) =>
                                            copyNoFollowGuarded(
                                                guardedPath(rootedFullPath),
                                                guardedPath(rootedBackupPath)
                                            )
                                    );
                                } catch (error) {
                                    const code = (error as NodeJS.ErrnoException).code;
                                    if (code === "EMLINK") {
                                        return null;
                                    }
                                    if (code !== "ENOENT") {
                                        throw error;
                                    }
                                }
                            }

                            const tempPath = `${rootedFullPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
                            try {
                                await writeTextNoFollowExclusiveGuarded(
                                    guardedPath(tempPath),
                                    content,
                                    existingMode ?? undefined
                                );
                                await fs.promises.rename(tempPath, rootedFullPath);
                                return statGuarded(guardedPath(rootedFullPath));
                            } finally {
                                await fs.promises.rm(tempPath, { force: true });
                            }
                        }
                    );
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "ENOENT") {
                        res.status(404).json({ error: "Path not found" });
                        return;
                    }
                    if (code === "ENOTDIR") {
                        res.status(400).json({ error: "Not a directory" });
                        return;
                    }
                    if (code === "ELOOP") {
                        res.status(403).json({
                            error: "Access denied: symlinks are not writable",
                        });
                        return;
                    }
                    if (code === "EISDIR") {
                        res.status(400).json({
                            error: "Path is a directory, not a file",
                        });
                        return;
                    }
                    if (code === "EINVAL") {
                        res.status(400).json({
                            error: (error as Error).message,
                        });
                        return;
                    }
                    if (sendRootedParentError(res, error as NodeJS.ErrnoException)) {
                        return;
                    }
                    throw error;
                }
                if (!stat) {
                    res.status(403).json({ error: HARD_LINK_ERROR });
                    return;
                }

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
