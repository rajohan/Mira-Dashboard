import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getPersistedGatewayToken } from "../auth.ts";
import { json } from "../http.ts";
import {
    guardedPath,
    openReadNoFollowNonblockingGuarded,
    readFromOpenFile,
} from "../lib/guardedOps.ts";
import { stringFallback } from "../lib/values.ts";

const MAX_MEDIA_SIZE = 16 * 1024 * 1024;
const MAX_TEXT_PREVIEW_SIZE = 1024 * 1024;
const GATEWAY_MEDIA_REQUEST_TIMEOUT_MS = 30_000;
const GATEWAY_WEBSOCKET_PROTOCOLS = new Set(["ws:", "wss:"]);
const ACTIVE_DOCUMENT_EXTENSIONS = new Set([".htm", ".html", ".svg", ".xhtml"]);
const ACTIVE_DOCUMENT_MIME_TYPES = new Set([
    "application/xhtml+xml",
    "application/xml",
    "image/svg+xml",
    "text/html",
    "text/xml",
]);
const TEXT_PREVIEW_EXTENSIONS = new Set([".csv", ".json", ".md", ".txt"]);
const GATEWAY_TEXT_PREVIEW_MIME_TYPES = new Set([
    "application/json",
    "text/csv",
    "text/markdown",
    "text/plain",
]);
const MANAGED_GATEWAY_MEDIA_PATH =
    /^\/api\/chat\/media\/outgoing\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/full$/iu;
const SVG_PREVIEW_CONTENT_SECURITY_POLICY =
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const mediaRouteState: {
    cachedMediaRoot?: string;
    cachedOpenclawRoot?: string;
    cachedRealMediaRoot?: string;
    cachedRealOpenclawRoot?: string;
} = {};

const MIME_TYPES: Record<string, string> = {
    ".aac": "audio/aac",
    ".bmp": "image/bmp",
    ".csv": "text/csv; charset=utf-8",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".flac": "audio/flac",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".m4a": "audio/mp4",
    ".md": "text/markdown; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".svg": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
};

function mimeTypeFromPath(filePath: string): string {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function configuredGatewayToken(): string | undefined {
    return (
        process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
        process.env.OPENCLAW_TOKEN?.trim() ||
        getPersistedGatewayToken()?.trim() ||
        undefined
    );
}

function gatewayMediaUrl(request: Request): URL | undefined {
    const pathname = new URL(request.url).pathname;
    if (!MANAGED_GATEWAY_MEDIA_PATH.test(pathname)) {
        return undefined;
    }

    let gatewayUrl: URL;
    try {
        gatewayUrl = new URL(
            process.env.OPENCLAW_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789"
        );
    } catch {
        return undefined;
    }
    if (!GATEWAY_WEBSOCKET_PROTOCOLS.has(gatewayUrl.protocol)) {
        return undefined;
    }
    if (gatewayUrl.username || gatewayUrl.password) {
        return undefined;
    }

    gatewayUrl.protocol = gatewayUrl.protocol === "wss:" ? "https:" : "http:";
    gatewayUrl.pathname = pathname;
    gatewayUrl.search = "";
    gatewayUrl.hash = "";
    return gatewayUrl;
}

function gatewayMediaMetadata(response: Response): {
    contentDisposition: string;
    contentType: string;
    fileExtension: string;
} {
    const contentDisposition = response.headers.get("content-disposition") || "";
    const contentType =
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ||
        "";
    const fileNameMatch = /filename\*?=(?:UTF-8''|")?([^";]+)/iu.exec(contentDisposition);
    const fileExtension = fileNameMatch
        ? path.extname(fileNameMatch[1]!.trim()).toLowerCase()
        : "";
    return { contentDisposition, contentType, fileExtension };
}

function downloadContentDisposition(contentDisposition: string): string {
    const parametersIndex = contentDisposition.indexOf(";");
    return parametersIndex === -1
        ? "attachment"
        : `attachment${contentDisposition.slice(parametersIndex)}`;
}

async function readGatewayBodyUpTo(
    response: Response,
    maximumBytes: number
): Promise<Uint8Array | undefined> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        await response.body?.cancel();
        return undefined;
    }

    const reader = response.body?.getReader();
    if (!reader) {
        return new Uint8Array();
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            totalBytes += value.byteLength;
            if (totalBytes > maximumBytes) {
                await reader.cancel();
                return undefined;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

async function proxyGatewayMedia(request: Request): Promise<Response> {
    const previewMode = new URL(request.url).searchParams.get("preview");
    if (previewMode && !["image", "text"].includes(previewMode)) {
        return json({ error: "Invalid preview mode" }, { status: 400 });
    }
    const gatewayUrl = gatewayMediaUrl(request);
    const token = configuredGatewayToken();
    if (!gatewayUrl || !token) {
        return json({ error: "Media not found" }, { status: 404 });
    }

    let response: Response;
    try {
        response = await fetch(gatewayUrl, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "manual",
            signal: AbortSignal.timeout(GATEWAY_MEDIA_REQUEST_TIMEOUT_MS),
        });
    } catch {
        return json({ error: "Gateway media unavailable" }, { status: 502 });
    }
    if (!response.ok) {
        const status = [400, 401, 403, 404, 413, 429].includes(response.status)
            ? response.status
            : 502;
        return json({ error: "Media not found" }, { status });
    }

    const { contentDisposition, contentType, fileExtension } =
        gatewayMediaMetadata(response);
    if (previewMode === "text") {
        if (
            !GATEWAY_TEXT_PREVIEW_MIME_TYPES.has(contentType) &&
            !TEXT_PREVIEW_EXTENSIONS.has(fileExtension)
        ) {
            await response.body?.cancel();
            return json({ error: "Text preview is not available" }, { status: 415 });
        }

        const body = await readGatewayBodyUpTo(response, MAX_TEXT_PREVIEW_SIZE);
        if (!body) {
            return json({ error: "Text preview is too large" }, { status: 413 });
        }
        return new Response(body, {
            headers: {
                "Cache-Control":
                    response.headers.get("cache-control") || "private, max-age=3600",
                "Content-Type": "text/plain; charset=utf-8",
                "X-Content-Type-Options": "nosniff",
            },
        });
    }

    if (previewMode === "image") {
        if (contentType !== "image/svg+xml" && fileExtension !== ".svg") {
            await response.body?.cancel();
            return json({ error: "Image preview is not available" }, { status: 415 });
        }
        const body = await readGatewayBodyUpTo(response, MAX_MEDIA_SIZE);
        if (!body) {
            return json({ error: "Media file too large" }, { status: 413 });
        }
        return new Response(body, {
            headers: {
                "Cache-Control":
                    response.headers.get("cache-control") || "private, max-age=3600",
                "Content-Security-Policy": SVG_PREVIEW_CONTENT_SECURITY_POLICY,
                "Content-Type": "image/svg+xml",
                "X-Content-Type-Options": "nosniff",
            },
        });
    }

    const isActiveDocument =
        ACTIVE_DOCUMENT_MIME_TYPES.has(contentType) ||
        ACTIVE_DOCUMENT_EXTENSIONS.has(fileExtension);
    const headers = new Headers({
        "Cache-Control": response.headers.get("cache-control") || "private, max-age=3600",
        "Content-Type": isActiveDocument
            ? "application/octet-stream"
            : response.headers.get("content-type") || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
    });
    if (isActiveDocument) {
        headers.set(
            "Content-Disposition",
            downloadContentDisposition(contentDisposition)
        );
    } else if (contentDisposition) {
        headers.set("Content-Disposition", contentDisposition);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
        headers.set("Content-Length", contentLength);
    }
    return new Response(response.body, { headers });
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
    "/api/chat/media/outgoing/*": {
        GET: proxyGatewayMedia,
    },
    "/api/media": {
        GET: async (request: Request) => {
            const requestUrl = new URL(request.url);
            const requestedPath = stringFallback(requestUrl.searchParams.get("path"));

            if (!requestedPath) {
                return json({ error: "Access denied" }, { status: 403 });
            }
            if (requestedPath.includes("\0")) {
                return json({ error: "Invalid media path" }, { status: 400 });
            }
            const previewMode = requestUrl.searchParams.get("preview");
            if (previewMode && !["image", "text"].includes(previewMode)) {
                return json({ error: "Invalid preview mode" }, { status: 400 });
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
                const extension = path.extname(openedRealPath).toLowerCase();
                if (previewMode === "text" && !TEXT_PREVIEW_EXTENSIONS.has(extension)) {
                    return json(
                        { error: "Text preview is not available" },
                        { status: 415 }
                    );
                }
                if (previewMode === "text" && stat.size > MAX_TEXT_PREVIEW_SIZE) {
                    return json({ error: "Text preview is too large" }, { status: 413 });
                }
                if (previewMode === "image" && extension !== ".svg") {
                    return json(
                        { error: "Image preview is not available" },
                        { status: 415 }
                    );
                }
                buffer = readFromOpenFile(file.fd, stat.size);
            } finally {
                await file.close();
            }

            const responseHeaders = new Headers({
                "Cache-Control": "private, max-age=3600",
                "Content-Type":
                    previewMode === "text"
                        ? "text/plain; charset=utf-8"
                        : previewMode === "image"
                          ? "image/svg+xml"
                          : mimeTypeFromPath(openedRealPath),
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
        },
    },
} as const;
