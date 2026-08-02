import path from "node:path";

import { routeFailureResponse } from "../../http/routeSupport.ts";
import { byteStreamReader } from "../../lib/byteStreams.ts";
import { resolveGatewayToken } from "../../services/gateway/token.ts";
import {
    MAX_MEDIA_SIZE,
    MAX_TEXT_PREVIEW_SIZE,
    SVG_PREVIEW_CONTENT_SECURITY_POLICY,
    TEXT_PREVIEW_EXTENSIONS,
} from "./policy.ts";

const GATEWAY_MEDIA_REQUEST_TIMEOUT_MS = 30_000;
const MANAGED_MEDIA_CACHE_CONTROL = "private, no-store";
const GATEWAY_WEBSOCKET_PROTOCOLS = new Set(["ws:", "wss:"]);
const ACTIVE_DOCUMENT_EXTENSIONS = new Set([".htm", ".html", ".svg", ".xhtml"]);
const ACTIVE_DOCUMENT_MIME_TYPES = new Set([
    "application/xhtml+xml",
    "application/xml",
    "image/svg+xml",
    "text/html",
    "text/xml",
]);
const GATEWAY_TEXT_PREVIEW_MIME_TYPES = new Set([
    "application/json",
    "text/csv",
    "text/markdown",
    "text/plain",
]);
// Keep this aligned with OpenClaw's managed-image route, which creates IDs with
// node:crypto randomUUID() and rejects non-v4 IDs before reading its media store.
const MANAGED_GATEWAY_MEDIA_PATH =
    /^\/api\/chat\/media\/outgoing\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/full$/iu;

function configuredGatewayToken(): string | undefined {
    return resolveGatewayToken();
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

    const reader = byteStreamReader(response.body);
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

export async function handleGatewayMediaRequest(request: Request): Promise<Response> {
    const previewMode = new URL(request.url).searchParams.get("preview");
    if (previewMode && !["image", "text"].includes(previewMode)) {
        return routeFailureResponse({
            context: "media",
            message: "Invalid preview mode",
            status: 400,
        });
    }
    const gatewayUrl = gatewayMediaUrl(request);
    const token = configuredGatewayToken();
    if (!gatewayUrl || !token) {
        return routeFailureResponse({
            context: "media",
            message: "Media not found",
            status: 404,
        });
    }

    let response: Response;
    const gatewayRequestController = new AbortController();
    const gatewayRequestTimeout = setTimeout(
        () => gatewayRequestController.abort(),
        GATEWAY_MEDIA_REQUEST_TIMEOUT_MS
    );
    try {
        response = await fetch(gatewayUrl, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "manual",
            signal: gatewayRequestController.signal,
        });
    } catch {
        clearTimeout(gatewayRequestTimeout);
        return routeFailureResponse({
            context: "media",
            message: "Gateway media unavailable",
            status: 502,
        });
    }
    if (!response.ok) {
        clearTimeout(gatewayRequestTimeout);
        const status = [400, 401, 403, 404, 413, 429].includes(response.status)
            ? response.status
            : 502;
        return routeFailureResponse({
            context: "media",
            message: "Media not found",
            status,
        });
    }

    const { contentDisposition, contentType, fileExtension } =
        gatewayMediaMetadata(response);
    if (previewMode === "text") {
        if (
            !GATEWAY_TEXT_PREVIEW_MIME_TYPES.has(contentType) &&
            !TEXT_PREVIEW_EXTENSIONS.has(fileExtension)
        ) {
            await response.body?.cancel();
            clearTimeout(gatewayRequestTimeout);
            return routeFailureResponse({
                context: "media",
                message: "Text preview is not available",
                status: 415,
            });
        }

        let body: Uint8Array | undefined;
        try {
            body = await readGatewayBodyUpTo(response, MAX_TEXT_PREVIEW_SIZE);
        } catch {
            return routeFailureResponse({
                context: "media",
                message: "Gateway media preview timed out",
                status: 504,
            });
        } finally {
            clearTimeout(gatewayRequestTimeout);
        }
        if (!body) {
            return routeFailureResponse({
                context: "media",
                message: "Text preview is too large",
                status: 413,
            });
        }
        return new Response(body, {
            headers: {
                "Cache-Control": MANAGED_MEDIA_CACHE_CONTROL,
                "Content-Type": "text/plain; charset=utf-8",
                "X-Content-Type-Options": "nosniff",
            },
        });
    }

    if (previewMode === "image") {
        const isSvg = contentType === "image/svg+xml" || fileExtension === ".svg";
        let previewContentType: string | undefined;
        if (contentType.startsWith("image/")) {
            previewContentType = contentType;
        }
        if (!previewContentType && isSvg) {
            previewContentType = "image/svg+xml";
        }
        if (!previewContentType) {
            await response.body?.cancel();
            clearTimeout(gatewayRequestTimeout);
            return routeFailureResponse({
                context: "media",
                message: "Image preview is not available",
                status: 415,
            });
        }
        let body: Uint8Array | undefined;
        try {
            body = await readGatewayBodyUpTo(response, MAX_MEDIA_SIZE);
        } catch {
            return routeFailureResponse({
                context: "media",
                message: "Gateway media preview timed out",
                status: 504,
            });
        } finally {
            clearTimeout(gatewayRequestTimeout);
        }
        if (!body) {
            return routeFailureResponse({
                context: "media",
                message: "Media file too large",
                status: 413,
            });
        }
        const previewHeaders = new Headers({
            "Cache-Control": MANAGED_MEDIA_CACHE_CONTROL,
            "Content-Type": previewContentType,
            "X-Content-Type-Options": "nosniff",
        });
        if (isSvg) {
            previewHeaders.set(
                "Content-Security-Policy",
                SVG_PREVIEW_CONTENT_SECURITY_POLICY
            );
        }
        return new Response(body, {
            headers: previewHeaders,
        });
    }

    const isActiveDocument =
        ACTIVE_DOCUMENT_MIME_TYPES.has(contentType) ||
        ACTIVE_DOCUMENT_EXTENSIONS.has(fileExtension);
    const headers = new Headers({
        "Cache-Control": MANAGED_MEDIA_CACHE_CONTROL,
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
    clearTimeout(gatewayRequestTimeout);
    return new Response(response.body, { headers });
}
