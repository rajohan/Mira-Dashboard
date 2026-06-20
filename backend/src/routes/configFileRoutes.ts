import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { json, readJson } from "../http.ts";
import {
    copyNoFollowGuarded,
    guardedPath,
    openReadNoFollowGuarded,
    readFromOpenFile,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.ts";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.ts";

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_CONFIG_WRITE_SIZE = 2 * 1024 * 1024;
const CONFIG_WRITE_BODY_LIMIT = MAX_CONFIG_WRITE_SIZE + 4096;
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
            let stat: fs.Stats;
            try {
                const linkStat = fs.lstatSync(fullPath);
                if (linkStat.isSymbolicLink()) {
                    return json({ error: "File not found" }, { status: 404 });
                }
                stat = fs.statSync(fullPath);
            } catch {
                return json({ error: "File not found" }, { status: 404 });
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
            const file = await openReadNoFollowGuarded(guardedPath(fullPath));
            let buffer: Buffer;
            try {
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
            const body = await readJson<{ content?: unknown }>(request, {
                maxBytes: CONFIG_WRITE_BODY_LIMIT,
            });
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
            const target = prepareSafeWriteTargetWithinRoot(
                path.resolve(root, relativePath),
                root
            );
            if (!target) {
                return json(
                    { error: "Access denied: path outside allowed root" },
                    { status: 403 }
                );
            }
            await fsp.mkdir(path.dirname(target), { recursive: true });
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
                    if (stat.size <= MAX_CONFIG_WRITE_SIZE) {
                        await copyNoFollowGuarded(
                            guardedPath(target),
                            guardedPath(`${target}.bak`)
                        );
                    }
                }
                await writeTextNoFollowGuarded(guardedPath(target), body.content);
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
