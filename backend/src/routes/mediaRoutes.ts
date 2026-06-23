import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { json } from "../http.ts";
import {
    guardedPath,
    openReadNoFollowNonblockingGuarded,
    readFromOpenFile,
} from "../lib/guardedOps.ts";
import { stringFallback } from "../lib/values.ts";

const MAX_MEDIA_SIZE = 16 * 1024 * 1024;
const mediaRouteState: {
    cachedMediaRoot?: string;
    cachedOpenclawRoot?: string;
    cachedRealMediaRoot?: string;
    cachedRealOpenclawRoot?: string;
} = {};

const MIME_TYPES: Record<string, string> = {
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".svg": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
};

function mimeTypeFromPath(filePath: string): string {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function resolveOpenclawRoot(): string | undefined {
    const configuredRoot =
        process.env.OPENCLAW_HOME?.trim() ||
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME?.trim();
    const homeDirectory = process.env.HOME?.trim() || os.homedir().trim();
    if (
        !configuredRoot &&
        (!homeDirectory ||
            !path.isAbsolute(homeDirectory) ||
            homeDirectory === path.parse(homeDirectory).root)
    ) {
        return undefined;
    }
    const openclawRoot = configuredRoot || path.join(homeDirectory, ".openclaw");
    const resolvedRoot = path.resolve(openclawRoot);
    if (
        !openclawRoot ||
        !path.isAbsolute(openclawRoot) ||
        resolvedRoot === path.parse(resolvedRoot).root
    ) {
        return undefined;
    }
    if (
        mediaRouteState.cachedOpenclawRoot === resolvedRoot &&
        mediaRouteState.cachedRealOpenclawRoot
    ) {
        return mediaRouteState.cachedRealOpenclawRoot;
    }
    try {
        mediaRouteState.cachedOpenclawRoot = resolvedRoot;
        mediaRouteState.cachedRealOpenclawRoot = fs.realpathSync(resolvedRoot);
        return mediaRouteState.cachedRealOpenclawRoot;
    } catch {
        mediaRouteState.cachedOpenclawRoot = resolvedRoot;
        mediaRouteState.cachedRealOpenclawRoot = resolvedRoot;
        return resolvedRoot;
    }
}

function getMediaRoot(): string | undefined {
    const openclawRoot = resolveOpenclawRoot();
    return openclawRoot ? path.join(openclawRoot, "media") : undefined;
}

function getRealMediaRoot(mediaRoot: string): string | undefined {
    if (mediaRouteState.cachedMediaRoot !== mediaRoot) {
        mediaRouteState.cachedMediaRoot = mediaRoot;
        mediaRouteState.cachedRealMediaRoot = undefined;
    }
    if (mediaRouteState.cachedRealMediaRoot) {
        return mediaRouteState.cachedRealMediaRoot;
    }
    try {
        mediaRouteState.cachedRealMediaRoot = fs.realpathSync(mediaRoot);
        return mediaRouteState.cachedRealMediaRoot;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
            throw error;
        }
        return undefined;
    }
}

export const mediaRoutes = {
    "/api/media": {
        GET: async (request: Request) => {
            const requestedPath = stringFallback(
                new URL(request.url).searchParams.get("path")
            );

            if (!requestedPath) {
                return json({ error: "Access denied" }, { status: 403 });
            }
            if (requestedPath.includes("\0")) {
                return json({ error: "Invalid media path" }, { status: 400 });
            }

            const mediaRoot = getMediaRoot();
            if (!mediaRoot) {
                return json({ error: "Media not found" }, { status: 404 });
            }

            const fullPath = path.resolve(mediaRoot, requestedPath);
            const realMediaRoot = getRealMediaRoot(mediaRoot);
            if (!realMediaRoot) {
                return json({ error: "Media not found" }, { status: 404 });
            }

            let realPath: string;
            try {
                realPath = await fsp.realpath(fullPath);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    return json({ error: "Media not found" }, { status: 404 });
                }
                throw error;
            }
            const relativeRealPath = path.relative(realMediaRoot, realPath);
            if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
                return json({ error: "Access denied" }, { status: 403 });
            }
            let preOpenStat: fs.Stats;
            try {
                preOpenStat = await fsp.stat(realPath);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    return json({ error: "Media not found" }, { status: 404 });
                }
                if (["EACCES", "EPERM"].includes(code ?? "")) {
                    return json({ error: "Access denied" }, { status: 403 });
                }
                throw error;
            }
            if (!preOpenStat.isFile()) {
                return json({ error: "Media path is not a file" }, { status: 400 });
            }

            let file: fs.promises.FileHandle;
            try {
                file = await openReadNoFollowNonblockingGuarded(guardedPath(realPath));
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    return json({ error: "Media not found" }, { status: 404 });
                }
                if (code === "ENXIO") {
                    return json({ error: "Media path is not a file" }, { status: 400 });
                }
                if (["ELOOP", "EACCES", "EPERM"].includes(code ?? "")) {
                    return json({ error: "Access denied" }, { status: 403 });
                }
                throw error;
            }
            let buffer: Buffer;
            let openedRealPath: string;
            try {
                const stat = await file.stat();
                openedRealPath =
                    process.platform === "linux"
                        ? await fsp.realpath(`/proc/self/fd/${file.fd}`)
                        : realPath;
                const relativeOpenedPath = path.relative(realMediaRoot, openedRealPath);
                if (
                    relativeOpenedPath.startsWith("..") ||
                    path.isAbsolute(relativeOpenedPath)
                ) {
                    return json({ error: "Access denied" }, { status: 403 });
                }
                if (!stat.isFile()) {
                    return json({ error: "Media path is not a file" }, { status: 400 });
                }
                if (stat.nlink > 1) {
                    return json({ error: "Access denied" }, { status: 403 });
                }
                if (stat.size > MAX_MEDIA_SIZE) {
                    return json({ error: "Media file too large" }, { status: 413 });
                }
                buffer = readFromOpenFile(file.fd, stat.size);
            } finally {
                await file.close();
            }

            return new Response(buffer, {
                headers: {
                    "Cache-Control": "private, max-age=3600",
                    "Content-Type": mimeTypeFromPath(openedRealPath),
                    "X-Content-Type-Options": "nosniff",
                },
            });
        },
    },
} as const;
