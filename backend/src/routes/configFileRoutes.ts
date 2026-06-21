import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    guardedPath,
    openReadNoFollowNonblockingGuarded,
    readFromOpenFile,
    writeTextNoFollowAnchoredGuarded,
} from "../lib/guardedOps.ts";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.ts";

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_CONFIG_WRITE_SIZE = 2 * 1024 * 1024;
const CONFIG_WRITE_BODY_LIMIT = MAX_CONFIG_WRITE_SIZE * 2;
const ALLOWED_CONFIG_FILES = new Set(["openclaw.json", "hooks/transforms/agentmail.ts"]);

function openclawRoot(): string | null {
    const configured =
        process.env.OPENCLAW_HOME?.trim() ||
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME?.trim();
    const rawHome = process.env.HOME?.trim();
    const home =
        rawHome && path.isAbsolute(rawHome) ? path.resolve(rawHome) : os.homedir().trim();
    if (
        !configured &&
        (!home || !path.isAbsolute(home) || home === path.parse(home).root)
    ) {
        return null;
    }
    const root = path.resolve(configured || path.join(home, ".openclaw"));
    if (!path.isAbsolute(root) || root === path.parse(root).root) {
        return null;
    }
    try {
        return fs.realpathSync(root);
    } catch {
        return root;
    }
}

function isBinaryContent(content: string): boolean {
    for (let index = 0; index < Math.min(content.length, 8000); index += 1) {
        if (content.codePointAt(index) === 0) return true;
    }
    return false;
}

function configPathFromRequest(request: Request): string | null {
    try {
        const pathname = new URL(request.url).pathname;
        return decodeURIComponent(pathname.slice("/api/config-files/".length));
    } catch {
        return null;
    }
}

function listConfigFiles(root: string) {
    const files: Array<{
        modified: string;
        name: string;
        path: string;
        relativePath: string;
        size: number;
        type: "file";
    }> = [];
    let realRoot: string;
    try {
        realRoot = fs.realpathSync(root);
    } catch {
        return files;
    }
    for (const relativePath of ALLOWED_CONFIG_FILES) {
        const fullPath = path.join(root, relativePath);
        try {
            if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
            const realPath = fs.realpathSync(fullPath);
            if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
                continue;
            }
            const stat = fs.statSync(realPath);
            if (!stat.isFile() || stat.nlink > 1) continue;
            files.push({
                modified: stat.mtime.toISOString(),
                name: path.basename(relativePath),
                path: `config:${relativePath}`,
                relativePath,
                size: stat.size,
                type: "file",
            });
        } catch {
            // Missing optional config files are omitted.
        }
    }
    return files;
}

function configTarget(relativePath: string, root: string): string | null {
    if (!ALLOWED_CONFIG_FILES.has(relativePath)) return null;
    return safePathWithinRoot(relativePath, root);
}

async function realPathFromOpenFile(file: fs.promises.FileHandle, fallback: string) {
    return process.platform === "linux"
        ? fs.realpathSync(`/proc/self/fd/${file.fd}`)
        : fallback;
}

async function validateOpenFileWithinRoot(
    file: fs.promises.FileHandle,
    root: string,
    fallbackPath: string
): Promise<fs.Stats | null> {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1) {
        return null;
    }
    const realPath = await realPathFromOpenFile(file, fallbackPath);
    const relativeRealPath = path.relative(root, realPath);
    if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
        return null;
    }
    return stat;
}

export const configFileRoutes = {
    "/api/config-files": {
        GET: () => {
            const root = openclawRoot();
            if (!root) {
                return json(
                    { error: "Server misconfigured: HOME is not configured" },
                    { status: 500 }
                );
            }
            return json({ files: listConfigFiles(root), root });
        },
    },

    "/api/config-files/*": {
        GET: async (request: Request) => {
            const relativePath = configPathFromRequest(request);
            if (relativePath === null) {
                return json({ error: "Malformed config file path" }, { status: 400 });
            }
            const root = openclawRoot();
            if (!root) {
                return json(
                    { error: "Server misconfigured: HOME is not configured" },
                    { status: 500 }
                );
            }
            const fullPath = configTarget(relativePath, root);
            if (!fullPath) {
                return json(
                    { error: "Access denied: file not in allowed list" },
                    { status: 403 }
                );
            }
            const lexicalPath = path.resolve(root, relativePath);
            try {
                if (fs.lstatSync(lexicalPath).isSymbolicLink()) {
                    return json({ error: "File not found" }, { status: 404 });
                }
            } catch {
                return json({ error: "File not found" }, { status: 404 });
            }
            const realFullPath = fs.realpathSync(fullPath);
            const relativeRealPath = path.relative(root, realFullPath);
            if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
                return json({ error: "Access denied" }, { status: 403 });
            }
            if (!fs.statSync(realFullPath).isFile()) {
                return json({ error: "Access denied" }, { status: 403 });
            }
            const file = await openReadNoFollowNonblockingGuarded(
                guardedPath(realFullPath)
            );
            let buffer: Buffer;
            let stat: fs.Stats;
            try {
                const openedStat = await validateOpenFileWithinRoot(
                    file,
                    root,
                    realFullPath
                );
                if (!openedStat) {
                    return json({ error: "Access denied" }, { status: 403 });
                }
                stat = openedStat;
                buffer = readFromOpenFile(file.fd, Math.min(stat.size, MAX_FILE_SIZE));
            } finally {
                await file.close();
            }
            const content = buffer.toString("utf8");
            const isBinary = isBinaryContent(content);
            return json({
                content: isBinary ? "[Binary file]" : content,
                isBinary,
                modified: stat.mtime.toISOString(),
                path: `config:${relativePath}`,
                relativePath,
                size: stat.size,
                truncated: stat.size > MAX_FILE_SIZE || undefined,
            });
        },

        PUT: async (request: Request) => {
            const relativePath = configPathFromRequest(request);
            if (relativePath === null) {
                return json({ error: "Malformed config file path" }, { status: 400 });
            }
            if (!ALLOWED_CONFIG_FILES.has(relativePath)) {
                return json(
                    { error: "Access denied: file not in allowed list" },
                    { status: 403 }
                );
            }
            let body: { content?: unknown };
            try {
                body = await readJson<{ content?: unknown }>(request, {
                    maxBytes: CONFIG_WRITE_BODY_LIMIT,
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
            if (body.content === undefined)
                return json({ error: "Content required" }, { status: 400 });
            if (
                typeof body.content !== "string" ||
                Buffer.byteLength(body.content, "utf8") > MAX_CONFIG_WRITE_SIZE
            ) {
                return json({ error: "Invalid content" }, { status: 400 });
            }
            const root = openclawRoot();
            if (!root) {
                return json(
                    { error: "Server misconfigured: HOME is not configured" },
                    { status: 500 }
                );
            }
            const lexicalTarget = path.resolve(root, relativePath);
            try {
                if (fs.lstatSync(lexicalTarget).isSymbolicLink()) {
                    return json({ error: "Access denied" }, { status: 403 });
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
            const target = prepareSafeWriteTargetWithinRoot(lexicalTarget, root);
            if (!target) {
                return json(
                    { error: "Access denied: path outside allowed root" },
                    { status: 403 }
                );
            }
            let existingMode: number | undefined;
            try {
                if (fs.existsSync(target)) {
                    const stat = fs.lstatSync(target);
                    if (stat.isSymbolicLink()) {
                        return json({ error: "Access denied" }, { status: 403 });
                    }
                    if (stat.isDirectory()) {
                        return json(
                            { error: "Path is a directory, not a file" },
                            { status: 400 }
                        );
                    }
                    if (stat.nlink > 1) {
                        return json(
                            { error: "Hard-linked files are not allowed" },
                            { status: 403 }
                        );
                    }
                    existingMode = stat.mode & 0o777;
                    if (stat.size > MAX_CONFIG_WRITE_SIZE) {
                        return json(
                            { error: "Existing file is too large to back up" },
                            { status: 413 }
                        );
                    }
                    if (!fs.statSync(target).isFile()) {
                        return json({ error: "Access denied" }, { status: 403 });
                    }
                    const file = await openReadNoFollowNonblockingGuarded(
                        guardedPath(target)
                    );
                    let backupContent: string;
                    try {
                        const openedStat = await validateOpenFileWithinRoot(
                            file,
                            root,
                            target
                        );
                        if (!openedStat) {
                            return json({ error: "Access denied" }, { status: 403 });
                        }
                        if (openedStat.size > MAX_CONFIG_WRITE_SIZE) {
                            return json(
                                { error: "Existing file is too large to back up" },
                                { status: 413 }
                            );
                        }
                        backupContent = readFromOpenFile(
                            file.fd,
                            openedStat.size
                        ).toString("utf8");
                    } finally {
                        await file.close();
                    }
                    await writeTextNoFollowAnchoredGuarded(
                        guardedPath(root),
                        `${relativePath}.bak`,
                        backupContent,
                        { createParents: true, mode: stat.mode & 0o777 }
                    );
                }
                await writeTextNoFollowAnchoredGuarded(
                    guardedPath(root),
                    relativePath,
                    body.content,
                    { createParents: true, mode: existingMode }
                );
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EACCES") {
                    return json({ error: "Access denied" }, { status: 403 });
                }
                throw error;
            }
            const stat = fs.statSync(target);
            return json({
                isSuccess: true,
                modified: stat.mtime.toISOString(),
                path: `config:${relativePath}`,
                relativePath,
                size: stat.size,
            });
        },
    },
} as const;
