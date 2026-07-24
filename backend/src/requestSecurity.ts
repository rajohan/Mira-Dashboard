import type { Server } from "bun";

import { isAllowedDashboardOrigin, isSecureRequest } from "./http.ts";

const SAFE_REQUEST_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_FETCH_SITES = new Set(["none", "same-origin"]);
const PERMISSIONS_POLICY = [
    "camera=()",
    "geolocation=()",
    "microphone=(self)",
    "payment=()",
    "usb=()",
].join(", ");

const requestIds = new WeakMap<Request, string>();

function contentSecurityPolicyFor(request: Request, server: Server<unknown>): string {
    const requestUrl = new URL(request.url);
    const webSocketProtocol = isSecureRequest(request, server) ? "wss:" : "ws:";
    const webSocketOrigin = `${webSocketProtocol}//${requestUrl.host}`;

    return [
        "default-src 'self'",
        "base-uri 'none'",
        `connect-src 'self' ${webSocketOrigin}`,
        "font-src 'self' data:",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' data: blob: https:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
    ].join("; ");
}

/** Returns the server-generated correlation identifier for a request. */
export function requestIdFor(request: Request): string {
    const existing = requestIds.get(request);
    if (existing) return existing;

    const requestId = Bun.randomUUIDv7();
    requestIds.set(request, requestId);
    return requestId;
}

/**
 * Rejects browser mutations that identify a cross-origin or same-site source.
 * Requests without browser provenance headers remain available to direct API
 * clients and the explicitly configured direct-loopback automation boundary.
 */
export function isAllowedMutationSource(request: Request): boolean {
    if (SAFE_REQUEST_METHODS.has(request.method.toUpperCase())) {
        return true;
    }

    const origin = request.headers.get("origin");
    if (origin !== null && !isAllowedDashboardOrigin(request)) {
        return false;
    }

    const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
    return !fetchSite || ALLOWED_FETCH_SITES.has(fetchSite);
}

/** Adds correlation and browser hardening headers without consuming the body. */
export function withRequestSecurity(
    request: Request,
    response: Response,
    server: Server<unknown>
): Response {
    const headers = new Headers(response.headers);
    headers.set("X-Request-ID", requestIdFor(request));
    if (!headers.has("Content-Security-Policy")) {
        headers.set("Content-Security-Policy", contentSecurityPolicyFor(request, server));
    }
    headers.set("Permissions-Policy", PERMISSIONS_POLICY);
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");

    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}
