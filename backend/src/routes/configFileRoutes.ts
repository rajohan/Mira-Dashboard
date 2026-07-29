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
    openReadNoFollowNonblockingGuarded,
    readFromOpenFile,
    writeTextNoFollowAnchoredGuarded,
} from "../lib/guardedOps.ts";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.ts";
import { readApiJsonOrError, routeFailureResponse } from "../routeSupport.ts";
import {
    CONFIG_REDACTION_SENTINEL,
    redactConfigJsonText,
} from "../services/configRedaction.ts";

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_CONFIG_WRITE_SIZE = 2 * 1024 * 1024;
const CONFIG_WRITE_BODY_LIMIT = MAX_CONFIG_WRITE_SIZE * 2;
const ALLOWED_CONFIG_FILES = new Set(["openclaw.json", "hooks/transforms/agentmail.ts"]);

function openclawRoot(): string | undefined {
    const configured = process.env.OPENCLAW_HOME?.trim();
    const rawHome = process.env.HOME?.trim();
    const home =
        rawHome && path.isAbsolute(rawHome) ? path.resolve(rawHome) : os.homedir().trim();
    if (
        !configured &&
        (!home || !path.isAbsolute(home) || home === path.parse(home).root)
    ) {
        return undefined;
    }
    if (configured && !path.isAbsolute(configured)) {
        return undefined;
    }
    const root = configured
        ? path.resolve(configured)
        : path.resolve(path.join(home, ".openclaw"));
    if (!path.isAbsolute(root) || root === path.parse(root).root) {
        return undefined;
    }
    try {
        const resolvedRoot = fs.realpathSync(root);
        return path.isAbsolute(resolvedRoot) &&
            resolvedRoot !== path.parse(resolvedRoot).root
            ? resolvedRoot
            : undefined;
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

function configPathFromRequest(request: Request): string | undefined {
    try {
        const pathname = new URL(request.url).pathname;
        return decodeURIComponent(pathname.slice("/api/config-files/".length));
    } catch {
        return undefined;
    }
}

function listConfigFiles(root: string): FileEntry[] {
    const files: FileEntry[] = [];
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

function configTarget(relativePath: string, root: string): string | undefined {
    if (!ALLOWED_CONFIG_FILES.has(relativePath)) return undefined;
    return safePathWithinRoot(relativePath, root);
}

function realPathFromOpenFile(file: fs.promises.FileHandle, fallback: string) {
    return process.platform === "linux"
        ? fs.realpathSync(`/proc/self/fd/${file.fd}`)
        : fallback;
}

async function validateOpenFileWithinRoot(
    file: fs.promises.FileHandle,
    root: string,
    fallbackPath: string
): Promise<fs.Stats | undefined> {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1) {
        return undefined;
    }
    const realPath = realPathFromOpenFile(file, fallbackPath);
    const relativeRealPath = path.relative(root, realPath);
    if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
        return undefined;
    }
    return stat;
}

function guardedOpenErrorResponse(error: unknown): Response {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ENOTDIR"].includes(code ?? "")) {
        return routeFailureResponse({
            context: "config-file",
            message: "File not found",
            status: 404,
        });
    }
    if (code === "ENXIO") {
        return routeFailureResponse({
            context: "config-file",
            message: "Path is not a regular file",
            status: 400,
        });
    }
    if (["ELOOP", "EACCES", "EPERM"].includes(code ?? "")) {
        return routeFailureResponse({
            context: "config-file",
            message: "Access denied",
            status: 403,
        });
    }
    throw error;
}

export const configFileRoutes = {
    "/api/config-files": {
        GET: () => {
            const root = openclawRoot();
            if (!root) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Server misconfigured: HOME is not configured",
                    status: 500,
                });
            }
            return json({ files: listConfigFiles(root), root });
        },
    },

    "/api/config-files/*": {
        GET: async (request: Request) => {
            const relativePath = configPathFromRequest(request);
            if (relativePath === undefined) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Malformed config file path",
                    status: 400,
                });
            }
            const root = openclawRoot();
            if (!root) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Server misconfigured: HOME is not configured",
                    status: 500,
                });
            }
            const fullPath = configTarget(relativePath, root);
            if (!fullPath) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Access denied: file not in allowed list",
                    status: 403,
                });
            }
            const lexicalPath = path.resolve(root, relativePath);
            try {
                if (fs.lstatSync(lexicalPath).isSymbolicLink()) {
                    return routeFailureResponse({
                        context: "config-file",
                        message: "File not found",
                        status: 404,
                    });
                }
            } catch {
                return routeFailureResponse({
                    context: "config-file",
                    message: "File not found",
                    status: 404,
                });
            }
            const realFullPath = fs.realpathSync(fullPath);
            const relativeRealPath = path.relative(root, realFullPath);
            if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Access denied",
                    status: 403,
                });
            }
            if (!fs.statSync(realFullPath).isFile()) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Access denied",
                    status: 403,
                });
            }
            let file: fs.promises.FileHandle;
            try {
                file = await openReadNoFollowNonblockingGuarded(
                    guardedPath(realFullPath)
                );
            } catch (error) {
                return guardedOpenErrorResponse(error);
            }
            let buffer: Buffer;
            let stat: fs.Stats;
            try {
                const openedStat = await validateOpenFileWithinRoot(
                    file,
                    root,
                    realFullPath
                );
                if (!openedStat) {
                    return routeFailureResponse({
                        context: "config-file",
                        message: "Access denied",
                        status: 403,
                    });
                }
                stat = openedStat;
                buffer = readFromOpenFile(file.fd, Math.min(stat.size, MAX_FILE_SIZE));
            } finally {
                await file.close();
            }
            const content = buffer.toString("utf8");
            const isBinary = isBinaryContent(content);
            const shouldMask =
                relativePath === "openclaw.json" &&
                new URL(request.url).searchParams.get("reveal") !== "1";
            const responseContent =
                shouldMask && !isBinary ? redactConfigJsonText(content) : content;
            let maskingError: "invalid_json" | "truncated_json" | undefined;
            if (shouldMask && responseContent === undefined) {
                maskingError =
                    stat.size > MAX_FILE_SIZE ? "truncated_json" : "invalid_json";
            }
            const response = json({
                content: isBinary ? "[Binary file]" : (responseContent ?? ""),
                isBinary,
                masked: shouldMask,
                maskingError,
                modified: stat.mtime.toISOString(),
                path: `config:${relativePath}`,
                relativePath,
                size: stat.size,
                truncated: stat.size > MAX_FILE_SIZE || undefined,
            } satisfies FileContent);
            if (relativePath === "openclaw.json" && !shouldMask) {
                response.headers.set("Cache-Control", "no-store");
            }
            return response;
        },

        PUT: async (request: Request) => {
            const relativePath = configPathFromRequest(request);
            if (relativePath === undefined) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Malformed config file path",
                    status: 400,
                });
            }
            if (!ALLOWED_CONFIG_FILES.has(relativePath)) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Access denied: file not in allowed list",
                    status: 403,
                });
            }
            const body = await readApiJsonOrError(request, parseFileWriteRequest, {
                code: "invalid_config_file_request",
                context: "config-file.write",
                maxBytes: CONFIG_WRITE_BODY_LIMIT,
                message: "Invalid config file request",
            });
            if (body instanceof Response) return body;
            if (Buffer.byteLength(body.content, "utf8") > MAX_CONFIG_WRITE_SIZE) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Invalid content",
                    status: 400,
                });
            }
            if (body.content.includes(CONFIG_REDACTION_SENTINEL)) {
                return routeFailureResponse({
                    context: "config-file",
                    message:
                        "Masked config cannot be saved; reveal and verify the file first",
                    status: 400,
                });
            }
            const root = openclawRoot();
            if (!root) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Server misconfigured: HOME is not configured",
                    status: 500,
                });
            }
            const lexicalTarget = path.resolve(root, relativePath);
            try {
                if (fs.lstatSync(lexicalTarget).isSymbolicLink()) {
                    return routeFailureResponse({
                        context: "config-file",
                        message: "Access denied",
                        status: 403,
                    });
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
            const target = prepareSafeWriteTargetWithinRoot(lexicalTarget, root);
            if (!target) {
                return routeFailureResponse({
                    context: "config-file",
                    message: "Access denied: path outside allowed root",
                    status: 403,
                });
            }
            let existingMode: number | undefined;
            try {
                if (fs.existsSync(target)) {
                    const stat = fs.lstatSync(target);
                    if (stat.isSymbolicLink()) {
                        return routeFailureResponse({
                            context: "config-file",
                            message: "Access denied",
                            status: 403,
                        });
                    }
                    if (stat.isDirectory()) {
                        return routeFailureResponse({
                            context: "config-file",
                            message: "Path is a directory, not a file",
                            status: 400,
                        });
                    }
                    if (stat.nlink > 1) {
                        return routeFailureResponse({
                            context: "config-file",
                            message: "Hard-linked files are not allowed",
                            status: 403,
                        });
                    }
                    existingMode = stat.mode & 0o777;
                    if (stat.size > MAX_CONFIG_WRITE_SIZE) {
                        return routeFailureResponse({
                            context: "config-file",
                            message: "Existing file is too large to back up",
                            status: 413,
                        });
                    }
                    if (!fs.statSync(target).isFile()) {
                        return routeFailureResponse({
                            context: "config-file",
                            message: "Access denied",
                            status: 403,
                        });
                    }
                    let file: fs.promises.FileHandle;
                    try {
                        file = await openReadNoFollowNonblockingGuarded(
                            guardedPath(target)
                        );
                    } catch (error) {
                        return guardedOpenErrorResponse(error);
                    }
                    let backupContent: string;
                    try {
                        const openedStat = await validateOpenFileWithinRoot(
                            file,
                            root,
                            target
                        );
                        if (!openedStat) {
                            return routeFailureResponse({
                                context: "config-file",
                                message: "Access denied",
                                status: 403,
                            });
                        }
                        if (openedStat.size > MAX_CONFIG_WRITE_SIZE) {
                            return routeFailureResponse({
                                context: "config-file",
                                message: "Existing file is too large to back up",
                                status: 413,
                            });
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
                    return routeFailureResponse({
                        context: "config-file",
                        message: "Access denied",
                        status: 403,
                    });
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
            } satisfies FileWriteResponse);
        },
    },
} as const;
