import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

import { asyncRoute } from "../lib/errors.js";
import {
    copyNoFollowGuarded,
    guardedPath,
    mkdirGuarded,
    openReadNoFollowGuarded,
    statGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.js";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.js";
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit
const MAX_CONFIG_WRITE_SIZE = 2 * 1024 * 1024; // 2MB write guardrail
const CONFIG_WRITE_JSON_LIMIT = MAX_CONFIG_WRITE_SIZE * 2;

// Allowed config files (whitelist for security)
const ALLOWED_CONFIG_FILES = [
    "openclaw.json",
    "cron/jobs.json",
    "hooks/transforms/agentmail.ts",
];

/** Represents config file. */
interface ConfigFile {
    name: string;
    path: string;
    relPath: string;
    type: "file";
    size: number;
    modified: string;
}

/** Represents the config file API response. */
interface ConfigFileResponse {
    path: string;
    relPath: string;
    content: string;
    size: number;
    modified: string;
    isBinary: boolean;
    truncated?: boolean;
}

/** Represents the write API response. */
interface WriteResponse {
    success: boolean;
    path: string;
    relPath: string;
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

/** Resolves the OpenClaw root without falling back to a root-level path. */
function resolveOpenclawRoot(): string | null {
    const configuredRoot =
        process.env.OPENCLAW_HOME?.trim() ||
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME?.trim();
    const homeDir = os.homedir().trim();
    if (
        !configuredRoot &&
        (!homeDir || !path.isAbsolute(homeDir) || homeDir === path.parse(homeDir).root)
    ) {
        return null;
    }
    const openclawRoot = configuredRoot || path.join(homeDir, ".openclaw");
    const resolvedRoot = path.resolve(openclawRoot);
    if (
        !openclawRoot ||
        !path.isAbsolute(openclawRoot) ||
        resolvedRoot === path.parse(resolvedRoot).root
    ) {
        return null;
    }
    try {
        return fs.realpathSync(resolvedRoot);
    } catch {
        return resolvedRoot;
    }
}

function validateOpenclawLeaf(openclawRoot: string): boolean {
    try {
        if (fs.lstatSync(openclawRoot).isSymbolicLink()) {
            return false;
        }
        return fs.statSync(openclawRoot).isDirectory();
    } catch {
        return false;
    }
}

let validateOpenclawLeafForWrite = validateOpenclawLeaf;

function decodeConfigPath(encodedPath: string): string | null {
    try {
        return decodeURIComponent(encodedPath);
    } catch {
        return null;
    }
}

async function withRootedParentPath<T>(
    safePath: string,
    rootPath: string,
    callback: (rootedPath: string) => Promise<T> | T
): Promise<T> {
    if (process.platform !== "linux") {
        const error = new Error("Parent path validation failed") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
    }

    const parentPath = path.dirname(safePath);
    const parentFd = fs.openSync(
        parentPath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
        const realRoot = fs.realpathSync(rootPath);
        const realParent = fs.realpathSync(`/proc/self/fd/${parentFd}`);
        if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
            const error = new Error(
                "Parent path validation failed"
            ) as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
        }

        return await callback(`/proc/self/fd/${parentFd}/${path.basename(safePath)}`);
    } finally {
        fs.closeSync(parentFd);
    }
}

async function ensureParentDirsForWrite(
    safePath: string,
    rootPath: string
): Promise<void> {
    const targetParent = path.dirname(safePath);
    try {
        fs.mkdirSync(rootPath, { recursive: true });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
            throw error;
        }
    }
    const canonicalRoot = fs.realpathSync(rootPath);
    const relativeParent = path.relative(canonicalRoot, targetParent);
    if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
        const error = new Error(
            "Parent directory validation failed"
        ) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
    }
    if (!relativeParent) {
        return;
    }

    let currentPath = canonicalRoot;
    for (const segment of relativeParent.split(path.sep)) {
        currentPath = path.join(currentPath, segment);
        const safeDirectoryPath = prepareSafeWriteTargetWithinRoot(
            currentPath,
            canonicalRoot
        );
        if (!safeDirectoryPath) {
            const error = new Error(
                "Parent directory validation failed"
            ) as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
        }
        await withRootedParentPath(safeDirectoryPath, canonicalRoot, (rootedPath) => {
            mkdirGuarded(guardedPath(rootedPath), { recursive: true });
        });
    }
}

/** Performs list config files. */
function listConfigFiles(openclawRoot: string): ConfigFile[] {
    const files: ConfigFile[] = [];
    let rootReal: string;
    try {
        rootReal = fs.realpathSync(openclawRoot);
    } catch {
        return files;
    }

    for (const relPath of ALLOWED_CONFIG_FILES) {
        const fullPath = path.join(openclawRoot, relPath);
        try {
            const lexicalStat = fs.lstatSync(fullPath);
            if (lexicalStat.isSymbolicLink()) {
                continue;
            }
            const resolvedFullPath = fs.realpathSync(fullPath);
            if (
                resolvedFullPath !== rootReal &&
                !resolvedFullPath.startsWith(rootReal + path.sep)
            ) {
                continue;
            }
            const stat = fs.statSync(resolvedFullPath);
            if (!stat.isFile()) {
                continue;
            }
            files.push({
                name: path.basename(relPath),
                path: "config:" + relPath, // Prefix to distinguish from workspace files
                relPath: relPath,
                type: "file",
                size: stat.size,
                modified: stat.mtime.toISOString(),
            });
        } catch {
            // File doesn't exist, skip
        }
    }

    return files;
}

/** Registers config files API routes. */
export default function configFilesRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.use((req, res, next) => {
        if (
            (req.method === "GET" || req.method === "PUT") &&
            req.originalUrl.startsWith("/api/config-files/")
        ) {
            const rawPath = req.originalUrl
                .slice("/api/config-files/".length)
                .split("?")[0];
            if (decodeConfigPath(rawPath) === null) {
                res.status(400).json({ error: "Malformed config file path" });
                return;
            }
        }
        next();
    });

    // List config files
    app.get(
        "/api/config-files",
        asyncRoute(
            async (_req, res) => {
                const openclawRoot = resolveOpenclawRoot();
                if (!openclawRoot) {
                    res.status(500).json({
                        error: "Server misconfigured: HOME is not configured",
                    });
                    return;
                }

                const files = listConfigFiles(openclawRoot);
                res.json({ files, root: openclawRoot });
            },
            { fallback: "Config file list failed", logLabel: "[ConfigFiles] List error:" }
        )
    );

    // Read config file content
    app.get(
        /^\/api\/config-files\/(.*)$/,
        asyncRoute(
            async (req, res) => {
                const filePath = req.params[0];

                // Check if file is in whitelist
                if (!ALLOWED_CONFIG_FILES.includes(filePath)) {
                    res.status(403).json({
                        error: "Access denied: file not in allowed list",
                    });
                    return;
                }

                const openclawRoot = resolveOpenclawRoot();
                if (!openclawRoot) {
                    res.status(500).json({
                        error: "Server misconfigured: HOME is not configured",
                    });
                    return;
                }

                const fullPath = safePathWithinRoot(filePath, openclawRoot);

                if (!fullPath) {
                    try {
                        fs.realpathSync(path.resolve(openclawRoot, filePath));
                    } catch (error) {
                        const code = (error as NodeJS.ErrnoException).code;
                        if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
                            res.status(404).json({ error: "File not found" });
                            return;
                        }
                    }
                    res.status(403).json({
                        error: "Access denied: path outside allowed root",
                    });
                    return;
                }

                try {
                    const lexicalStat = fs.lstatSync(fullPath);
                    if (lexicalStat.isSymbolicLink()) {
                        res.status(404).json({ error: "File not found" });
                        return;
                    }
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
                        res.status(404).json({ error: "File not found" });
                        return;
                    }
                    throw error;
                }

                let file: fs.promises.FileHandle | undefined;
                let fd: number | undefined;
                try {
                    file = await openReadNoFollowGuarded(guardedPath(fullPath));
                    fd = file.fd;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
                        res.status(404).json({ error: "File not found" });
                        return;
                    }
                    throw error;
                }

                try {
                    const realOpenclawRoot = fs.realpathSync(openclawRoot);
                    let realOpenedPath: string;
                    if (process.platform === "linux") {
                        realOpenedPath = fs.realpathSync(`/proc/self/fd/${fd}`);
                    } else {
                        const openedStat = fs.fstatSync(fd);
                        const targetStat = fs.statSync(fullPath);
                        if (
                            openedStat.dev !== targetStat.dev ||
                            openedStat.ino !== targetStat.ino
                        ) {
                            res.status(403).json({
                                error: "Access denied: path outside allowed root",
                            });
                            return;
                        }
                        realOpenedPath = fs.realpathSync(fullPath);
                    }
                    if (
                        realOpenedPath !== realOpenclawRoot &&
                        !realOpenedPath.startsWith(realOpenclawRoot + path.sep)
                    ) {
                        res.status(403).json({
                            error: "Access denied: path outside allowed root",
                        });
                        return;
                    }

                    const stat = fs.fstatSync(fd);

                    if (stat.isDirectory()) {
                        res.status(400).json({
                            error: "Path is a directory, not a file",
                        });
                        return;
                    }

                    if (stat.nlink > 1) {
                        res.status(403).json({
                            error: "Hard-linked files are not allowed",
                        });
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
                        const content = buffer.toString("utf8", 0, bytesRead);
                        const isBinary = isBinaryFile(content);

                        res.json({
                            path: "config:" + filePath,
                            relPath: filePath,
                            content: isBinary ? "[Binary file]" : content,
                            size: stat.size,
                            modified: stat.mtime.toISOString(),
                            isBinary: isBinary,
                            truncated: true,
                        } satisfies ConfigFileResponse);
                        return;
                    }

                    const content = await file.readFile("utf8");
                    const isBinary = isBinaryFile(content);

                    res.json({
                        path: "config:" + filePath,
                        relPath: filePath,
                        content: isBinary ? "[Binary file]" : content,
                        size: stat.size,
                        modified: stat.mtime.toISOString(),
                        isBinary: isBinary,
                    } satisfies ConfigFileResponse);
                } finally {
                    await file?.close();
                }
                return;
            },
            { fallback: "Config file read failed", logLabel: "[ConfigFiles] Read error:" }
        )
    );

    // Write config file
    app.put(
        /^\/api\/config-files\/(.*)$/,
        express.json({ limit: `${CONFIG_WRITE_JSON_LIMIT}b` }),
        asyncRoute(
            async (req, res) => {
                const filePath = req.params[0];
                if (!req.body || typeof req.body !== "object") {
                    res.status(400).json({ error: "Content required" });
                    return;
                }
                const { content } = req.body as { content?: unknown };

                if (content === undefined) {
                    res.status(400).json({ error: "Content required" });
                    return;
                }

                if (
                    typeof content !== "string" ||
                    Buffer.byteLength(content, "utf8") > MAX_CONFIG_WRITE_SIZE
                ) {
                    res.status(400).json({ error: "Invalid content" });
                    return;
                }

                // Check if file is in whitelist
                if (!ALLOWED_CONFIG_FILES.includes(filePath)) {
                    res.status(403).json({
                        error: "Access denied: file not in allowed list",
                    });
                    return;
                }

                const openclawRoot = resolveOpenclawRoot();
                if (!openclawRoot) {
                    res.status(500).json({
                        error: "Server misconfigured: HOME is not configured",
                    });
                    return;
                }

                const fullPathCandidate = path.resolve(openclawRoot, filePath);
                const safeFullPath = prepareSafeWriteTargetWithinRoot(
                    fullPathCandidate,
                    openclawRoot
                );
                if (!safeFullPath) {
                    res.status(403).json({
                        error: "Access denied: path outside allowed root",
                    });
                    return;
                }
                const allowMissingDefaultRoot =
                    validateOpenclawLeafForWrite === validateOpenclawLeaf &&
                    !fs.existsSync(openclawRoot);
                if (
                    !validateOpenclawLeafForWrite(openclawRoot) &&
                    !allowMissingDefaultRoot
                ) {
                    res.status(403).json({
                        error: "Access denied: path outside allowed root",
                    });
                    return;
                }

                try {
                    await ensureParentDirsForWrite(safeFullPath, openclawRoot);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "EACCES") {
                        res.status(403).json({
                            error: "Access denied: path outside allowed root",
                        });
                        return;
                    }
                    throw error;
                }

                // Create backup
                try {
                    const backupPath = safeFullPath + ".bak";
                    const safeBackupPath = prepareSafeWriteTargetWithinRoot(
                        backupPath,
                        openclawRoot
                    );
                    if (!safeBackupPath) {
                        const error = new Error(
                            "Backup path validation failed"
                        ) as NodeJS.ErrnoException;
                        error.code = "EACCES";
                        throw error;
                    }
                    await withRootedParentPath(
                        safeFullPath,
                        openclawRoot,
                        async (rootedFullPath) => {
                            const currentStat = statGuarded(guardedPath(rootedFullPath));
                            if (currentStat.nlink > 1) {
                                const error = new Error(
                                    "Hard-linked files are not allowed"
                                ) as NodeJS.ErrnoException;
                                error.code = "EMLINK";
                                throw error;
                            }
                            if (currentStat.size > MAX_CONFIG_WRITE_SIZE) {
                                const error = new Error(
                                    "Existing config file exceeds backup size limit"
                                ) as NodeJS.ErrnoException;
                                error.code = "EFBIG";
                                throw error;
                            }
                            await withRootedParentPath(
                                safeBackupPath,
                                openclawRoot,
                                (rootedBackupPath) =>
                                    copyNoFollowGuarded(
                                        guardedPath(rootedFullPath),
                                        guardedPath(rootedBackupPath)
                                    )
                            );
                        }
                    );
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "EACCES") {
                        res.status(403).json({ error: "Access denied" });
                        return;
                    }
                    if (code === "EMLINK") {
                        res.status(403).json({
                            error: "Hard-linked files are not allowed",
                        });
                        return;
                    }
                    if (code === "EFBIG") {
                        res.status(413).json({
                            error: "Config file too large to back up",
                        });
                        return;
                    }
                    if (code !== "ENOENT") {
                        throw error;
                    }
                }

                const stat = await withRootedParentPath(
                    safeFullPath,
                    openclawRoot,
                    async (rootedFullPath) => {
                        await writeTextNoFollowGuarded(
                            guardedPath(rootedFullPath),
                            content
                        );
                        return statGuarded(guardedPath(rootedFullPath));
                    }
                ).catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "EACCES") {
                        res.status(403).json({ error: "Access denied" });
                        return null;
                    }
                    if (error.code === "EMLINK") {
                        res.status(403).json({
                            error: "Hard-linked files are not allowed",
                        });
                        return null;
                    }
                    throw error;
                });
                if (!stat) {
                    return;
                }

                res.json({
                    success: true,
                    path: "config:" + filePath,
                    relPath: filePath,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                } satisfies WriteResponse);
            },
            {
                fallback: "Config file write failed",
                logLabel: "[ConfigFiles] Write error:",
            }
        )
    );
}

export const __testing = {
    ensureParentDirsForWrite,
    listConfigFiles,
    resolveOpenclawRoot,
    setValidateOpenclawLeafForTest(
        nextValidateOpenclawLeaf?: typeof validateOpenclawLeaf
    ): void {
        validateOpenclawLeafForWrite = nextValidateOpenclawLeaf ?? validateOpenclawLeaf;
    },
    validateOpenclawLeaf,
    withRootedParentPath,
};
