import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { routeFailureResponse } from "../../http/routeSupport.ts";
import { guardedPath } from "../../lib/guardedOps/core.ts";
import {
    openReadNoFollowNonblockingGuarded,
    readFromOpenFile,
} from "../../lib/guardedOps/read.ts";
import { stringFallback } from "../../lib/values.ts";
import {
    MAX_MEDIA_SIZE,
    MAX_TEXT_PREVIEW_SIZE,
    mimeTypeFromPath,
    SVG_PREVIEW_CONTENT_SECURITY_POLICY,
    TEXT_PREVIEW_EXTENSIONS,
} from "./policy.ts";

const mediaRouteState: {
    cachedMediaRoot?: string;
    cachedOpenclawRoot?: string;
    cachedRealMediaRoot?: string;
    cachedRealOpenclawRoot?: string;
} = {};

function resolveOpenclawRoot(): string | undefined {
    const configuredRoot = process.env.OPENCLAW_HOME?.trim();
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

/**
 * Serves one guarded file from the isolated OpenClaw media root.
 * @param request Media request.
 * @returns Media response or stable validation failure.
 */
export async function handleLocalMediaRequest(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    const requestedPath = stringFallback(requestUrl.searchParams.get("path"));

    if (!requestedPath) {
        return routeFailureResponse({
            context: "media",
            message: "Access denied",
            status: 403,
        });
    }
    if (requestedPath.includes("\0")) {
        return routeFailureResponse({
            context: "media",
            message: "Invalid media path",
            status: 400,
        });
    }
    const previewMode = requestUrl.searchParams.get("preview");
    if (previewMode && !["image", "text"].includes(previewMode)) {
        return routeFailureResponse({
            context: "media",
            message: "Invalid preview mode",
            status: 400,
        });
    }

    const mediaRoot = getMediaRoot();
    if (!mediaRoot) {
        return routeFailureResponse({
            context: "media",
            message: "Media not found",
            status: 404,
        });
    }

    const fullPath = path.resolve(mediaRoot, requestedPath);
    const realMediaRoot = getRealMediaRoot(mediaRoot);
    if (!realMediaRoot) {
        return routeFailureResponse({
            context: "media",
            message: "Media not found",
            status: 404,
        });
    }

    let realPath: string;
    try {
        realPath = await fsp.realpath(fullPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return routeFailureResponse({
                context: "media",
                message: "Media not found",
                status: 404,
            });
        }
        throw error;
    }
    const relativeRealPath = path.relative(realMediaRoot, realPath);
    if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
        return routeFailureResponse({
            context: "media",
            message: "Access denied",
            status: 403,
        });
    }
    let preOpenStat: fs.Stats;
    try {
        preOpenStat = await fsp.stat(realPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return routeFailureResponse({
                context: "media",
                message: "Media not found",
                status: 404,
            });
        }
        if (["EACCES", "EPERM"].includes(code ?? "")) {
            return routeFailureResponse({
                context: "media",
                message: "Access denied",
                status: 403,
            });
        }
        throw error;
    }
    if (!preOpenStat.isFile()) {
        return routeFailureResponse({
            context: "media",
            message: "Media path is not a file",
            status: 400,
        });
    }

    let file: fs.promises.FileHandle;
    try {
        file = await openReadNoFollowNonblockingGuarded(guardedPath(realPath));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return routeFailureResponse({
                context: "media",
                message: "Media not found",
                status: 404,
            });
        }
        if (code === "ENXIO") {
            return routeFailureResponse({
                context: "media",
                message: "Media path is not a file",
                status: 400,
            });
        }
        if (["ELOOP", "EACCES", "EPERM"].includes(code ?? "")) {
            return routeFailureResponse({
                context: "media",
                message: "Access denied",
                status: 403,
            });
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
        if (relativeOpenedPath.startsWith("..") || path.isAbsolute(relativeOpenedPath)) {
            return routeFailureResponse({
                context: "media",
                message: "Access denied",
                status: 403,
            });
        }
        if (!stat.isFile()) {
            return routeFailureResponse({
                context: "media",
                message: "Media path is not a file",
                status: 400,
            });
        }
        if (stat.nlink > 1) {
            return routeFailureResponse({
                context: "media",
                message: "Access denied",
                status: 403,
            });
        }
        if (stat.size > MAX_MEDIA_SIZE) {
            return routeFailureResponse({
                context: "media",
                message: "Media file too large",
                status: 413,
            });
        }
        const extension = path.extname(openedRealPath).toLowerCase();
        if (previewMode === "text" && !TEXT_PREVIEW_EXTENSIONS.has(extension)) {
            return routeFailureResponse({
                context: "media",
                message: "Text preview is not available",
                status: 415,
            });
        }
        if (previewMode === "text" && stat.size > MAX_TEXT_PREVIEW_SIZE) {
            return routeFailureResponse({
                context: "media",
                message: "Text preview is too large",
                status: 413,
            });
        }
        if (previewMode === "image" && extension !== ".svg") {
            return routeFailureResponse({
                context: "media",
                message: "Image preview is not available",
                status: 415,
            });
        }
        buffer = readFromOpenFile(file.fd, stat.size);
    } finally {
        await file.close();
    }

    let previewContentType = mimeTypeFromPath(openedRealPath);
    if (previewMode === "text") {
        previewContentType = "text/plain; charset=utf-8";
    }
    if (previewMode === "image") {
        previewContentType = "image/svg+xml";
    }
    const responseHeaders = new Headers({
        "Cache-Control": "private, max-age=3600",
        "Content-Type": previewContentType,
        "X-Content-Type-Options": "nosniff",
    });
    if (previewMode === "image") {
        responseHeaders.set(
            "Content-Security-Policy",
            SVG_PREVIEW_CONTENT_SECURITY_POLICY
        );
    }
    return new Response(buffer, {
        headers: responseHeaders,
    });
}
